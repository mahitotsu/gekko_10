// Fetches the output of a P1 task (CloudWatch Logs) after it ran, splits it into one set of files per run in the same
// format as scripts/load-run.sh --out, and saves the CloudWatch metrics of each run's time window.
//
//   npm run p1-fetch -- --task <task id> [--out results/2026-10-19] [--wait] [--skip-metrics]
//
// Logs are kept for 30 days (Gekko10LoadStack), 1-minute metrics for about 15 days: fetch within that time.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export interface LogEvent {
  timestamp: number;
  message: string;
}

export interface RunBegin {
  set: number;
  index: number;
  name: string;
  url: string;
  path: string;
  waitSeconds: number;
  startedAt: string;
}
export interface RunEnd {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  endedAt: string;
}
export interface FetchedRun {
  begin: RunBegin;
  end?: RunEnd;
  /** The child's own output between P1_RUN_BEGIN and P1_RUN_END. */
  lines: string[];
}
export interface ParsedLog {
  plan?: { seed: string; steps: number[]; stepSeconds: number; runs: number; estimateSeconds: number };
  runs: FetchedRun[];
  /** done: P1_DONE seen; aborted: P1_ABORTED seen; incomplete: neither (the task is still running or died). */
  status: "done" | "aborted" | "incomplete";
  aborted?: { reason: string; completed: number; of: number };
}

const json = (line: string, marker: string) => JSON.parse(line.slice(marker.length + 1));

export function parseP1Log(events: LogEvent[]): ParsedLog {
  const out: ParsedLog = { runs: [], status: "incomplete" };
  let current: FetchedRun | undefined;
  for (const { message } of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
    const line = message.replace(/\r?\n$/, "");
    if (line.startsWith("P1_PLAN ")) out.plan = json(line, "P1_PLAN");
    else if (line.startsWith("P1_RUN_BEGIN ")) {
      current = { begin: json(line, "P1_RUN_BEGIN"), lines: [] };
      out.runs.push(current);
    } else if (line.startsWith("P1_RUN_END ")) {
      if (current) current.end = json(line, "P1_RUN_END");
      current = undefined;
    } else if (line.startsWith("P1_DONE")) out.status = "done";
    else if (line.startsWith("P1_ABORTED ")) {
      out.status = "aborted";
      out.aborted = json(line, "P1_ABORTED");
    } else if (line.startsWith("P1_WAIT ")) {
      // not needed after the fact
    } else if (current) current.lines.push(line);
  }
  return out;
}

export const runPrefix = (r: FetchedRun) => `p1-set${r.begin.set}-${r.begin.index}-${r.begin.name}`;

/** The results of one run: its RESULT_JSON lines, or, if the generator died early, the steps it finished. */
export function resultsOf(run: FetchedRun): unknown[] {
  const results: unknown[] = [];
  const steps: unknown[] = [];
  for (const line of run.lines) {
    const r = line.indexOf("RESULT_JSON ");
    if (r >= 0) results.push(JSON.parse(line.slice(r + "RESULT_JSON ".length)));
    const s = line.indexOf("STEP_JSON ");
    if (s >= 0) steps.push(JSON.parse(line.slice(s + "STEP_JSON ".length)));
  }
  return results.length === 0 && steps.length > 0 ? [{ partial: true, steps }] : results;
}

export interface RunFiles {
  prefix: string;
  log: string;
  json: string;
  meta: string;
  manifestLine: string;
}

export function filesOf(parsed: ParsedLog, taskId: string, seed: string): RunFiles[] {
  return parsed.runs.map((run, i) => {
    const prefix = runPrefix(run);
    const previous = parsed.runs[i - 1]?.begin.name ?? null;
    const stoppedAt = run.end?.endedAt ?? null;
    const exitCode = run.end ? run.end.exitCode : null;
    const meta = {
      taskId,
      args: [run.begin.url, "--path", run.begin.path],
      exitCode: exitCode === null ? "unknown" : String(exitCode),
      timedOut: run.end?.timedOut ?? null,
      aborted: run.end?.aborted ?? null,
      startedAt: run.begin.startedAt,
      stoppedAt,
      waitSeconds: run.begin.waitSeconds,
      complete: Boolean(run.end),
    };
    return {
      prefix,
      log: run.lines.join("\n") + "\n",
      json: JSON.stringify(resultsOf(run), null, 1),
      meta: JSON.stringify(meta, null, 1),
      manifestLine: JSON.stringify({
        set: run.begin.set,
        seed,
        index: run.begin.index,
        name: run.begin.name,
        previous,
        gapSeconds: run.begin.waitSeconds,
        prefix,
        startedAt: run.begin.startedAt,
        stoppedAt,
        exitCode: meta.exitCode,
      }),
    };
  });
}

/** CloudWatch window for a run's metrics: a little before the start, and after the end for the lingering Web environments. */
export function metricsWindow(run: FetchedRun): { start: string; end: string } {
  const start = new Date(new Date(run.begin.startedAt).getTime() - 2 * 60_000);
  const end = new Date(new Date(run.end?.endedAt ?? run.begin.startedAt).getTime() + 8 * 60_000);
  const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "Z");
  return { start: iso(start), end: iso(end) };
}

// ---- command line ----

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
    console.error("usage: p1-fetch --task <task id> [--out DIR] [--wait] [--skip-metrics]");
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
  const parsed = parseP1Log(raw.events);
  console.log(`task ${taskId}: ${parsed.status}, ${parsed.runs.length} runs in the log${parsed.aborted ? ` (${parsed.aborted.reason})` : ""}`);
  if (parsed.runs.length === 0) process.exit(1);

  mkdirSync(out, { recursive: true });
  const seed = parsed.plan?.seed ?? "unknown";
  const files = filesOf(parsed, taskId, seed);
  const manifests = new Map<number, string[]>();
  files.forEach((f, i) => {
    writeFileSync(path.join(out, `${f.prefix}.log`), f.log);
    writeFileSync(path.join(out, `${f.prefix}.json`), f.json);
    writeFileSync(path.join(out, `${f.prefix}.meta.json`), f.meta);
    const set = parsed.runs[i].begin.set;
    manifests.set(set, [...(manifests.get(set) ?? []), f.manifestLine]);
  });
  for (const [set, lines] of manifests) writeFileSync(path.join(out, `p1-set${set}.manifest.jsonl`), lines.join("\n") + "\n");
  console.log(`saved ${files.length} runs under ${out}/`);

  if (!values["skip-metrics"]) {
    // Metrics lag by a few minutes: wait until the last window is complete.
    const last = metricsWindow(parsed.runs[parsed.runs.length - 1]);
    const waitMs = new Date(last.start).getTime() + 2 * 60_000 + 9 * 60_000 - Date.now();
    if (waitMs > 0) {
      console.log(`waiting ${Math.ceil(waitMs / 1000)} s for the last metrics to arrive`);
      await sleepMs(waitMs);
    }
    for (const run of parsed.runs) {
      const w = metricsWindow(run);
      execFileSync(
        "npx",
        ["tsx", "scripts/collect-metrics.ts", "--start", w.start, "--end", w.end, "--functions", `gekko10-${run.begin.name}`, "--out", path.join(out, `${runPrefix(run)}.metrics.json`)],
        { stdio: "inherit" },
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
