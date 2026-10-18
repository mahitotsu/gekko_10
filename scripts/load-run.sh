#!/usr/bin/env bash
# Runs scripts/invoke.ts as a one-off Fargate task in Tokyo and prints its output.
#
#   scripts/load-run.sh [--max-seconds N] [--out PREFIX] -- <invoke.ts arguments>
#   scripts/load-run.sh -- https://<endpoint> --path /db/read --duration 300 --concurrency 100
#   scripts/load-run.sh --out results/2026-10-18/a1 -- https://<endpoint> --path /noop --rate 100 --duration 60
#
# --out PREFIX saves PREFIX.log (the task's output), PREFIX.json (the RESULT_JSON lines of an open-loop run, as a
# list) and PREFIX.meta.json (task id, arguments, creation/start/stop times, exit code).
#
# The task gets a public IP (assignPublicIp=ENABLED): it needs the internet to pull its image from ECR and to write
# to CloudWatch Logs, and there is no NAT Gateway. The task is stopped when it exceeds --max-seconds (default:
# --duration + 180, or 600 without --duration), and on Ctrl-C / errors, so billing never continues unattended.
set -euo pipefail

REGION=ap-northeast-1
STACK=Gekko10LoadStack
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION AWS_PAGER=""

max_seconds=""
out=""
usage="usage: $0 [--max-seconds N] [--out PREFIX] -- <invoke.ts arguments>"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-seconds) max_seconds="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --) shift; break ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
done
[[ $# -gt 0 ]] || { echo "$usage" >&2; exit 2; }
args=("$@")

if [[ -z "$max_seconds" ]]; then
  max_seconds=600
  for ((i = 0; i < ${#args[@]}; i++)); do
    if [[ "${args[i]}" == "--duration" ]]; then max_seconds=$((${args[i + 1]} + 180)); fi
    # A ramp lasts (number of steps) x (step seconds), 90 s per step unless given.
    if [[ "${args[i]}" == "--steps" ]]; then steps=${args[i + 1]}; fi
    if [[ "${args[i]}" == "--step-seconds" ]]; then step_seconds=${args[i + 1]}; fi
  done
  if [[ -n "${steps:-}" ]]; then
    n=$(awk -F, '{print NF}' <<<"$steps")
    max_seconds=$((n * ${step_seconds:-90} + 180))
  fi
fi

out() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}
cluster=$(out ClusterName)
task_def=$(out TaskDefinitionArn)
subnets=$(out SubnetIds)
sg=$(out SecurityGroupId)
log_group=$(out LogGroupName)

network=$(python3 -c '
import json, sys
print(json.dumps({"awsvpcConfiguration": {"subnets": sys.argv[1].split(","), "securityGroups": [sys.argv[2]], "assignPublicIp": "ENABLED"}}))
' "$subnets" "$sg")
overrides=$(python3 -c '
import json, sys
print(json.dumps({"containerOverrides": [{"name": "Loadgen", "command": sys.argv[1:]}]}))
' "${args[@]}")

task_arn=$(aws ecs run-task --cluster "$cluster" --task-definition "$task_def" --launch-type FARGATE \
  --network-configuration "$network" --overrides "$overrides" --count 1 \
  --query 'tasks[0].taskArn' --output text)
task_id=${task_arn##*/}
echo "started task $task_id (max ${max_seconds}s)"

stop_task() {
  # No-op once the task has stopped; otherwise stops it so that billing ends.
  aws ecs stop-task --cluster "$cluster" --task "$task_arn" --reason "load-run.sh cleanup" >/dev/null 2>&1 || true
}
trap stop_task EXIT INT TERM

deadline=$((SECONDS + max_seconds))
status=""
while :; do
  status=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" --query 'tasks[0].lastStatus' --output text)
  [[ "$status" == "STOPPED" ]] && break
  if ((SECONDS >= deadline)); then
    echo "exceeded ${max_seconds}s, stopping the task" >&2
    stop_task
    aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task_arn"
    break
  fi
  sleep 5
done

exit_code=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" --query 'tasks[0].containers[0].exitCode' --output text)
reason=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" --query 'tasks[0].stoppedReason' --output text)
echo "--- task stopped: exitCode=$exit_code reason=$reason"
echo "--- output"
# Logs can lag the task's end by a few seconds.
sleep 5
log_file=$(mktemp)
aws logs tail "$log_group" --log-stream-names "loadgen/Loadgen/$task_id" --since 6h --format short >"$log_file" || true
cat "$log_file"

if [[ -n "$out" ]]; then
  mkdir -p "$(dirname "$out")"
  cp "$log_file" "$out.log"
  times=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" \
    --query 'tasks[0].[createdAt,startedAt,stoppedAt]' --output json)
  python3 - "$out" "$task_id" "$exit_code" "$reason" "$times" "${args[@]}" <<'PY'
import json, sys
out, task_id, exit_code, reason, times, *args = sys.argv[1:]
results = []
steps = []
for line in open(out + ".log"):
    marker = line.find("RESULT_JSON ")
    if marker >= 0:
        results.append(json.loads(line[marker + len("RESULT_JSON "):]))
    marker = line.find("STEP_JSON ")
    if marker >= 0:
        steps.append(json.loads(line[marker + len("STEP_JSON "):]))
# A run that crashed before printing RESULT_JSON still leaves its finished steps (marked partial).
if not results and steps:
    results.append({"partial": True, "steps": steps})
json.dump(results, open(out + ".json", "w"), indent=1)
created, started, stopped = json.loads(times)
json.dump(
    {"taskId": task_id, "args": args, "exitCode": exit_code, "stoppedReason": reason,
     "createdAt": created, "startedAt": started, "stoppedAt": stopped},
    open(out + ".meta.json", "w"), indent=1)
print(f"--- saved {out}.log / .json ({len(results)} result) / .meta.json")
PY
fi
rm -f "$log_file"

[[ "$exit_code" == "0" ]]
