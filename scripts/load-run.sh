#!/usr/bin/env bash
# Runs scripts/invoke.ts as a one-off Fargate task in Tokyo and prints its output.
#
#   scripts/load-run.sh [--max-seconds N] -- <invoke.ts arguments>
#   scripts/load-run.sh -- https://<endpoint> --path /db/read --duration 300 --concurrency 100
#
# The task gets a public IP (assignPublicIp=ENABLED): it needs the internet to pull its image from ECR and to write
# to CloudWatch Logs, and there is no NAT Gateway. The task is stopped when it exceeds --max-seconds (default:
# --duration + 180, or 600 without --duration), and on Ctrl-C / errors, so billing never continues unattended.
set -euo pipefail

REGION=ap-northeast-1
STACK=Gekko10LoadStack
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION AWS_PAGER=""

max_seconds=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-seconds) max_seconds="$2"; shift 2 ;;
    --) shift; break ;;
    *) echo "usage: $0 [--max-seconds N] -- <invoke.ts arguments>" >&2; exit 2 ;;
  esac
done
[[ $# -gt 0 ]] || { echo "usage: $0 [--max-seconds N] -- <invoke.ts arguments>" >&2; exit 2; }
args=("$@")

if [[ -z "$max_seconds" ]]; then
  max_seconds=600
  for ((i = 0; i < ${#args[@]}; i++)); do
    if [[ "${args[i]}" == "--duration" ]]; then max_seconds=$((${args[i + 1]} + 180)); fi
  done
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
aws logs tail "$log_group" --log-stream-names "loadgen/Loadgen/$task_id" --since 2h --format short || true

[[ "$exit_code" == "0" ]]
