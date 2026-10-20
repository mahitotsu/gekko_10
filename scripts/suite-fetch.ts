// Fetches the output of a suite task (CloudWatch Logs) after it ran and splits it into one set of files per run: the results, the
// metrics and the Event REPORT summaries the task collected itself (scripts/suite-post.ts), the manifest and the plan.
// It only reads the log, so it needs no timely access to metrics. If the task's post-processing failed, the metrics of the runs
// are collected here instead (AWS CLI, 1-minute metrics are kept for about 15 days).
//
//   npm run suite-fetch -- --task <task id> [--out results/measurement-20261020] [--wait] [--skip-metrics]
//
// Logs are kept for 30 days (Gekko10LoadStack).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { functionOf, metricsWindow, parseSuiteLog, runPrefix, writeResults, type LogEvent } from "./suite-files.js";

const REGION = "ap-northeast-1";
const aws = (...args: string[]) => execFileSync("aws", [...args, "--region", REGION], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const { values } = parseArgs({
    options: {
      task: { type: "string" },
      out: { type: "string" },
      wait: { type: "boolean", default: false },
      "skip-metrics": { type: "boolean", default: false },
    },
  });
  if (!values.task) {
    console.error("usage: suite-fetch --task <task id> [--out DIR] [--wait] [--skip-metrics]");
    process.exit(2);
  }
  const taskId = values.task;
  const out = values.out ?? `results/${new Date().toLocaleDateString("sv-SE")}`;
  const stack = (key: string) =>
    aws("cloudformation", "describe-stacks", "--stack-name", "Gekko10LoadStack", "--query", `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, "--output", "text").trim();
  const cluster = stack("ClusterName");
  const logGroup = stack("LogGroupName");

  if (values.wait) {
    for (;;) {
      const status = aws("ecs", "describe-tasks", "--cluster", cluster, "--tasks", taskId, "--query", "tasks[0].lastStatus", "--output", "text").trim();
      if (status === "STOPPED") break;
      console.log(`task ${taskId}: ${status}; checking again in 60 s`);
      await sleepMs(60_000);
    }
  }

  const raw = JSON.parse(
    aws("logs", "filter-log-events", "--log-group-name", logGroup, "--log-stream-names", `loadgen/Loadgen/${taskId}`, "--output", "json"),
  ) as { events: LogEvent[] };
  const parsed = parseSuiteLog(raw.events);
  console.log(`task ${taskId}: ${parsed.status}, ${parsed.runs.length} runs in the log${parsed.aborted ? ` (${parsed.aborted.reason})` : ""}`);
  if (parsed.runs.length === 0) process.exit(1);

  const n = writeResults(out, parsed, taskId);
  console.log(`saved ${n} runs under ${out}/`);
  if (parsed.verdict) console.log(`verdict from the task: ${JSON.stringify(parsed.verdict)}`);
  if (parsed.postFailed) console.log(`the task's post-processing failed: ${parsed.postFailed}`);

  // Fallback: runs without metrics (post-processing failed or did not run) are collected here.
  const missing = parsed.runs.filter((r) => !parsed.metrics.has(runPrefix(r)) && r.end);
  if (missing.length && !values["skip-metrics"]) {
    console.log(`${missing.length} runs have no metrics from the task; collecting them now (AWS CLI)`);
    for (const run of missing) {
      const w = metricsWindow(run);
      const file = path.join(out, `${runPrefix(run)}.metrics.json`);
      if (existsSync(file)) continue;
      execFileSync("npx", ["tsx", "scripts/collect-metrics.ts", "--start", w.start, "--end", w.end, "--functions", functionOf(run.begin.name), "--out", file], { stdio: "inherit" });
    }
    console.log("note: Event REPORT summaries are only collected by the task; without them the cost uses the rounding estimate");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
