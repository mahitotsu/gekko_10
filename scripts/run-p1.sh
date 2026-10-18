#!/usr/bin/env bash
# P1 (step-up load): runs the six configurations one at a time, in a seeded random order, and saves everything.
#
#   scripts/run-p1.sh --set 1 --seed 20261018 [--out results/2026-10-18] [--steps 25,50,100,200,400,800,1600]
#                     [--step-seconds 90] [--first-wait SECONDS] [--dry-run]
#
# Why one at a time: the DSQL cluster (connection rate, DPU, metrics) is shared by all configurations.
# Gaps between runs: 5 minutes, but 15 minutes after a "connect every time" run, because that run uses up the
# DSQL connection budget and the budget recovers slower than the documented 100/second (docs/findings.md 2-7).
# Run set 1 as the warm-up and set 2 for the measurement (Web learns its per-environment concurrency).
# Do not change the deployed code between the sets.
set -euo pipefail
cd "$(dirname "$0")/.."

set_no=""; seed=""; out="results/$(date +%F)"; steps="25,50,100,200,400,800,1600"; step_seconds=90
first_wait=0; dry_run=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --set) set_no="$2"; shift 2 ;;
    --seed) seed="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --steps) steps="$2"; shift 2 ;;
    --step-seconds) step_seconds="$2"; shift 2 ;;
    --first-wait) first_wait="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$set_no" && -n "$seed" ]] || { echo "usage: $0 --set N --seed S [--out DIR] [--dry-run]" >&2; exit 2; }

export AWS_REGION=ap-northeast-1 AWS_DEFAULT_REGION=ap-northeast-1 AWS_PAGER=""
output() {
  aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" --output text
}
# name|base URL|path|connects every time?
EVENT_STACK=Gekko10EventStack; WEB_STACK=Gekko10WebStack
if [[ $dry_run -eq 1 ]]; then
  url_of() { echo "https://example.invalid/$1"; }
else
  url_of() {
    case "$1" in
      event-noop) output $EVENT_STACK EventNoopUrl16BA62E3 ;;
      event-dsql-each) output $EVENT_STACK EventDsqlEachUrlB9815F25 ;;
      event-dsql-reuse) output $EVENT_STACK EventDsqlReuseUrl74056B16 ;;
      web-noop) output $WEB_STACK WebNoopEndpointUrl671499AD ;;
      web-dsql-each) output $WEB_STACK WebDsqlEachEndpointUrl8E361FAA ;;
      web-dsql-pool) output $WEB_STACK WebDsqlPoolEndpointUrl41C2D2DB ;;
    esac
  }
fi

order=$(python3 -c '
import random, sys
names = ["event-noop", "event-dsql-each", "event-dsql-reuse", "web-noop", "web-dsql-each", "web-dsql-pool"]
random.Random(f"{sys.argv[1]}-{sys.argv[2]}").shuffle(names)
print(" ".join(names))' "$seed" "$set_no")
echo "set $set_no, seed $seed, order: $order"

mkdir -p "$out"
manifest="$out/p1-set$set_no.manifest.jsonl"
prev=""
i=0
for name in $order; do
  i=$((i + 1))
  path=/db/read; [[ "$name" == *noop ]] && path=/noop
  gap=$first_wait
  if [[ -n "$prev" ]]; then
    gap=300; [[ "$prev" == *dsql-each ]] && gap=900
  fi
  echo "[$i/6] $name (wait ${gap}s after ${prev:-start})"
  if [[ $dry_run -eq 1 ]]; then prev=$name; continue; fi
  sleep "$gap"
  url=$(url_of "$name")
  prefix="$out/p1-set$set_no-$i-$name"
  scripts/load-run.sh --out "$prefix" -- "${url%/}" --path "$path" --steps "$steps" --step-seconds "$step_seconds" \
    | grep -v RESULT_JSON | tail -14 | cut -c1-260 || true
  python3 - "$manifest" "$set_no" "$seed" "$i" "$name" "${prev:-}" "$gap" "$prefix" <<'PY'
import json, sys
manifest, set_no, seed, i, name, prev, gap, prefix = sys.argv[1:]
meta = json.load(open(prefix + ".meta.json"))
with open(manifest, "a") as f:
    f.write(json.dumps({"set": int(set_no), "seed": seed, "index": int(i), "name": name, "previous": prev or None,
                        "gapSeconds": int(gap), "prefix": prefix, "startedAt": meta["startedAt"],
                        "stoppedAt": meta["stoppedAt"], "exitCode": meta["exitCode"]}) + "\n")
PY
  prev=$name
done

if [[ $dry_run -eq 0 ]]; then
  # CloudWatch metrics lag by a few minutes; collect each run's window afterwards (the DSQL series are cluster-wide:
  # slice them by the run's own start/end when analysing).
  sleep 420
  while read -r line; do
    prefix=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["prefix"])' "$line")
    fn="gekko10-$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["name"])' "$line")"
    start=$(python3 -c 'import json,sys,datetime as d; t=d.datetime.fromisoformat(json.loads(sys.argv[1])["startedAt"]); print((t-d.timedelta(minutes=2)).astimezone(d.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))' "$line")
    end=$(python3 -c 'import json,sys,datetime as d; t=d.datetime.fromisoformat(json.loads(sys.argv[1])["stoppedAt"]); print((t+d.timedelta(minutes=8)).astimezone(d.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))' "$line")
    npm run -s collect-metrics -- --start "$start" --end "$end" --functions "$fn" --out "$prefix.metrics.json"
  done <"$manifest"
fi
echo "done: $manifest"
