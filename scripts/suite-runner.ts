// Runs a suite plan inside one Fargate task: for each run, wait, run scripts/invoke.ts (bundled as invoke.mjs) as a child
// process, and mark the beginning and end in the output (CloudWatch Logs), which scripts/suite-fetch.ts reads later. After the
// last run it collects the CloudWatch metrics and the Event REPORT summaries and analyses everything (scripts/suite-post.ts), so
// the task finishes the whole measurement by itself.
//
//   node suite-runner.mjs '<plan JSON>'      (or '@/path/to/plan.json')
//
// Output markers (one per line): SUITE_PLAN, SUITE_WAIT, SUITE_RUN_BEGIN, SUITE_RUN_END, SUITE_POST_*, SUITE_METRICS,
// SUITE_REPORTS, SUITE_VERDICT, SUITE_DONE, SUITE_ABORTED. The child's own output (STEP_JSON, RESULT_JSON, the table) is
// forwarded unchanged between SUITE_RUN_BEGIN and SUITE_RUN_END.
//
// The runner stops itself when the whole plan exceeds its expected duration plus a margin, and on SIGTERM
// (`aws ecs stop-task`), so a task cannot keep billing unattended.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runPost } from "./suite-post.js";
import { estimateSeconds, invokeArgs, postSeconds, runDuration, type Plan, type PlanRun } from "./suite-plan.js";

/** Extra time allowed for the whole plan beyond its estimate. */
export const DEADLINE_MARGIN_SECONDS = 900;
/** Extra time allowed for one run beyond its steps and start-up. */
export const CHILD_MARGIN_SECONDS = 180;

export interface ChildResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}

/** What the runner knows about a finished run: used by the post-processing. */
export interface RunRecord {
  run: PlanRun;
  startedAt: string;
  endedAt: string;
  result: ChildResult;
  /** The child's own output. */
  lines: string[];
}

export interface RunnerDeps {
  /** Runs one configuration with the load generator; resolves when the child has exited. */
  runChild(run: PlanRun, plan: Plan, onLine: (line: string) => void, timeoutMs: number, signal: AbortSignal): Promise<ChildResult>;
  /** Waits; resolves early (without throwing) when the signal aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  log(line: string): void;
  now(): Date;
  /** Post-processing after the last run (collect metrics and reports, analyse, log the verdict). Optional. */
  post?(plan: Plan, records: RunRecord[], startedAt: string, signal: AbortSignal): Promise<void>;
}

const marker = (name: string, data: unknown) => `${name} ${JSON.stringify(data)}`;

export async function runPlan(plan: Plan, deps: RunnerDeps, signal: AbortSignal): Promise<{ status: "done" | "aborted"; completed: number }> {
  const startedAt = deps.now().toISOString();
  deps.log(marker("SUITE_PLAN", { startedAt, expectedSeconds: estimateSeconds(plan), plan }));
  const records: RunRecord[] = [];
  for (const run of plan.runs) {
    if (signal.aborted) break;
    deps.log(marker("SUITE_WAIT", { set: run.set, index: run.index, case: run.case, name: run.name, seconds: run.waitSeconds, at: deps.now().toISOString() }));
    await deps.sleep(run.waitSeconds * 1000, signal);
    if (signal.aborted) break;

    const runStartedAt = deps.now().toISOString();
    deps.log(marker("SUITE_RUN_BEGIN", { ...run, startedAt: runStartedAt }));
    const timeoutMs = (runDuration(plan, run) + CHILD_MARGIN_SECONDS) * 1000;
    const lines: string[] = [];
    const result = await deps.runChild(
      run,
      plan,
      (line) => {
        lines.push(line);
        deps.log(line);
      },
      timeoutMs,
      signal,
    );
    const endedAt = deps.now().toISOString();
    deps.log(marker("SUITE_RUN_END", { set: run.set, index: run.index, case: run.case, name: run.name, ...result, endedAt }));
    records.push({ run, startedAt: runStartedAt, endedAt, result, lines });
  }

  if (!signal.aborted && plan.post && deps.post) {
    deps.log(marker("SUITE_POST_BEGIN", { at: deps.now().toISOString() }));
    try {
      await deps.post(plan, records, startedAt, signal);
    } catch (e) {
      deps.log(marker("SUITE_POST_FAILED", { message: (e as Error).message ?? String(e) }));
    }
    deps.log(marker("SUITE_POST_END", { at: deps.now().toISOString() }));
  }

  if (signal.aborted) {
    deps.log(marker("SUITE_ABORTED", { reason: String(signal.reason ?? "aborted"), completed: records.length, of: plan.runs.length }));
    return { status: "aborted", completed: records.length };
  }
  deps.log(marker("SUITE_DONE", { completed: records.length }));
  return { status: "done", completed: records.length };
}

/** Builds the real child runner: `node <invokePath> <url> --path|--mix ... --steps ... --step-seconds ...`. */
export function createRunChild(invokePath: string): RunnerDeps["runChild"] {
  return (run, plan, onLine, timeoutMs, signal) =>
    new Promise((resolve) => {
      const args = [invokePath, ...invokeArgs(plan, run)];
      const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      let timedOut = false;
      let aborted = false;
      const stop = () => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      const onAbort = () => {
        aborted = true;
        stop();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });

      for (const stream of [child.stdout, child.stderr]) readline.createInterface({ input: stream }).on("line", onLine);
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve({ exitCode: code, timedOut, aborted });
      });
      child.on("error", (e) => {
        onLine(`runner: failed to start the child: ${e.message}`);
      });
    });
}

const realSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

export function parsePlan(arg: string): Plan {
  const text = arg.startsWith("@") ? readFileSync(arg.slice(1), "utf8") : arg;
  const plan = JSON.parse(text) as Plan;
  if (!Array.isArray(plan.runs) || plan.runs.length === 0 || typeof plan.cases !== "object" || plan.cases === null || typeof plan.urls !== "object") {
    throw new Error("invalid plan: needs runs, cases and urls");
  }
  for (const run of plan.runs) {
    const spec = plan.cases[run.case];
    if (!spec || !Array.isArray(spec.steps) || !(spec.stepSeconds > 0) || !plan.urls[run.name]) throw new Error(`invalid plan: run ${run.case}/${run.name} has no case, steps or url`);
  }
  return plan;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: suite-runner '<plan JSON>' | '@plan.json'");
    process.exit(2);
  }
  const plan = parsePlan(arg);
  const controller = new AbortController();
  const deadlineSeconds = estimateSeconds(plan) + postSeconds(plan) + DEADLINE_MARGIN_SECONDS;
  const deadline = setTimeout(() => controller.abort(`deadline of ${deadlineSeconds}s exceeded`), deadlineSeconds * 1000);
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => controller.abort(sig));

  const invokePath = process.env.SUITE_INVOKE_PATH ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "invoke.mjs");
  const { status } = await runPlan(
    plan,
    { runChild: createRunChild(invokePath), sleep: realSleep, log: (l) => console.log(l), now: () => new Date(), post: runPost },
    controller.signal,
  );
  clearTimeout(deadline);
  process.exit(status === "done" ? 0 : 2);
}

// Run only when executed as the entry point (not when imported by the tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
