// The log of a suite task (markers written by scripts/suite-runner.ts) and the result files made from it. Pure: used by
// scripts/suite-fetch.ts (local, from CloudWatch Logs) and by scripts/suite-post.ts (inside the task, from memory), so both
// produce the same files and scripts/analyze.ts reads them the same way.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { invokeArgs, type Plan, type PlanRun } from "./suite-plan.js";

export interface LogEvent {
  timestamp: number;
  message: string;
}

/** SUITE_PLAN: the plan the task was given, when it started, and how long it expects to run. */
export interface SuiteStart {
  startedAt: string;
  expectedSeconds: number;
  plan: Plan;
}

export interface RunBegin extends PlanRun {
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
  /** The child's own output between SUITE_RUN_BEGIN and SUITE_RUN_END. */
  lines: string[];
}
export interface ParsedLog {
  start?: SuiteStart;
  runs: FetchedRun[];
  /** done: SUITE_DONE seen; aborted: SUITE_ABORTED seen; incomplete: neither (the task is still running or died). */
  status: "done" | "aborted" | "incomplete";
  aborted?: { reason: string; completed: number; of: number };
  /** Post-processing inside the task (scripts/suite-post.ts): the verdict it computed, or why it failed. */
  verdict?: unknown;
  postFailed?: string;
  /** Per-run payloads the task collected, by file prefix, reassembled from their chunks. */
  metrics: Map<string, string>;
  reports: Map<string, string>;
}

const json = (line: string, marker: string) => JSON.parse(line.slice(marker.length + 1));

// ---- chunked payloads (CloudWatch Logs events are limited to 256 KB; the text is JSON-escaped when logged) ----
export const CHUNK_CHARS = 60_000;

export interface Chunk {
  prefix: string;
  part: number;
  of: number;
  data: string;
}

export function chunkLines(marker: "SUITE_METRICS" | "SUITE_REPORTS", prefix: string, text: string, size = CHUNK_CHARS): string[] {
  const of = Math.max(1, Math.ceil(text.length / size));
  return Array.from({ length: of }, (_, part) => {
    const chunk: Chunk = { prefix, part, of, data: text.slice(part * size, (part + 1) * size) };
    return `${marker} ${JSON.stringify(chunk)}`;
  });
}

/** Joins the chunks of every prefix; a payload with a missing chunk is left out. */
function assemble(chunks: Chunk[]): Map<string, string> {
  const by = new Map<string, Chunk[]>();
  for (const c of chunks) by.set(c.prefix, [...(by.get(c.prefix) ?? []).filter((x) => x.part !== c.part), c]);
  const out = new Map<string, string>();
  for (const [prefix, cs] of by) {
    if (cs.length !== cs[0].of) continue;
    out.set(prefix, [...cs].sort((a, b) => a.part - b.part).map((c) => c.data).join(""));
  }
  return out;
}

export function parseSuiteLog(events: LogEvent[]): ParsedLog {
  const out: ParsedLog = { runs: [], status: "incomplete", metrics: new Map(), reports: new Map() };
  const metricChunks: Chunk[] = [];
  const reportChunks: Chunk[] = [];
  let current: FetchedRun | undefined;
  for (const { message } of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
    const line = message.replace(/\r?\n$/, "");
    if (line.startsWith("SUITE_PLAN ")) out.start = json(line, "SUITE_PLAN");
    else if (line.startsWith("SUITE_RUN_BEGIN ")) {
      current = { begin: json(line, "SUITE_RUN_BEGIN"), lines: [] };
      out.runs.push(current);
    } else if (line.startsWith("SUITE_RUN_END ")) {
      if (current) current.end = json(line, "SUITE_RUN_END");
      current = undefined;
    } else if (line.startsWith("SUITE_DONE")) out.status = "done";
    else if (line.startsWith("SUITE_ABORTED ")) {
      out.status = "aborted";
      out.aborted = json(line, "SUITE_ABORTED");
    } else if (line.startsWith("SUITE_METRICS ")) metricChunks.push(json(line, "SUITE_METRICS"));
    else if (line.startsWith("SUITE_REPORTS ")) reportChunks.push(json(line, "SUITE_REPORTS"));
    else if (line.startsWith("SUITE_VERDICT ")) out.verdict = json(line, "SUITE_VERDICT");
    else if (line.startsWith("SUITE_POST_FAILED ")) out.postFailed = json(line, "SUITE_POST_FAILED").message;
    else if (line.startsWith("SUITE_WAIT ") || line.startsWith("SUITE_POST_")) {
      // not needed after the fact
    } else if (current) current.lines.push(line);
  }
  out.metrics = assemble(metricChunks);
  out.reports = assemble(reportChunks);
  return out;
}

export const runPrefix = (r: Pick<FetchedRun, "begin">) => `${r.begin.case}-set${r.begin.set}-${r.begin.index}-${r.begin.name}`;
export const functionOf = (name: string) => `gekko10-${name}`;
export const isEvent = (name: string) => name.startsWith("event-");

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
  /** Absent when the task did not deliver them (metrics, reports of non-Event runs). */
  metrics?: string;
  reports?: string;
}

export function filesOf(parsed: ParsedLog, taskId: string): RunFiles[] {
  const plan = parsed.start?.plan;
  return parsed.runs.map((run, i) => {
    const prefix = runPrefix(run);
    const previous = parsed.runs[i - 1]?.begin.name ?? null;
    const stoppedAt = run.end?.endedAt ?? null;
    const exitCode = run.end ? run.end.exitCode : null;
    const meta = {
      taskId,
      args: plan ? invokeArgs(plan, run.begin) : [],
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
        case: run.begin.case,
        set: run.begin.set,
        seed: plan?.seed ?? "unknown",
        build: plan?.build ?? "unknown",
        index: run.begin.index,
        name: run.begin.name,
        previous,
        gapSeconds: run.begin.waitSeconds,
        prefix,
        startedAt: run.begin.startedAt,
        stoppedAt,
        exitCode: meta.exitCode,
      }),
      metrics: parsed.metrics.get(prefix),
      reports: parsed.reports.get(prefix),
    };
  });
}

/** CloudWatch window for a run's metrics: a little before the start, and after the end for the lingering Web environments. */
export const WINDOW_BEFORE_MS = 2 * 60_000;
export const WINDOW_AFTER_MS = 8 * 60_000;
export function metricsWindow(run: FetchedRun): { start: string; end: string } {
  const start = new Date(new Date(run.begin.startedAt).getTime() - WINDOW_BEFORE_MS);
  const end = new Date(new Date(run.end?.endedAt ?? run.begin.startedAt).getTime() + WINDOW_AFTER_MS);
  const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "Z");
  return { start: iso(start), end: iso(end) };
}

/** Writes every run's files and the plan under `dir` (the layout scripts/analyze.ts reads). Returns the number of runs written. */
export function writeResults(dir: string, parsed: ParsedLog, taskId: string): number {
  mkdirSync(dir, { recursive: true });
  const files = filesOf(parsed, taskId);
  const manifests = new Map<number, string[]>();
  files.forEach((f, i) => {
    writeFileSync(path.join(dir, `${f.prefix}.log`), f.log);
    writeFileSync(path.join(dir, `${f.prefix}.json`), f.json);
    writeFileSync(path.join(dir, `${f.prefix}.meta.json`), f.meta);
    if (f.metrics) writeFileSync(path.join(dir, `${f.prefix}.metrics.json`), f.metrics);
    if (f.reports) writeFileSync(path.join(dir, `${f.prefix}.reports.json`), f.reports);
    const set = parsed.runs[i].begin.set;
    manifests.set(set, [...(manifests.get(set) ?? []), f.manifestLine]);
  });
  for (const [set, lines] of manifests) writeFileSync(path.join(dir, `suite-set${set}.manifest.jsonl`), lines.join("\n") + "\n");
  if (parsed.start) writeFileSync(path.join(dir, "suite.plan.json"), JSON.stringify({ taskId, ...parsed.start }, null, 1));
  return files.length;
}
