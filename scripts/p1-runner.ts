// Runs a P1 plan inside one Fargate task: for each run, wait, run scripts/invoke.ts (bundled as invoke.mjs) as a child
// process, and mark the beginning and end in the output (CloudWatch Logs), which scripts/p1-fetch.ts reads later.
//
//   node p1-runner.mjs '<plan JSON>'      (or '@/path/to/plan.json')
//
// Output markers (one per line): P1_PLAN, P1_WAIT, P1_RUN_BEGIN, P1_RUN_END, P1_DONE, P1_ABORTED. The child's own output
// (STEP_JSON, RESULT_JSON, the table) is forwarded unchanged between P1_RUN_BEGIN and P1_RUN_END.
//
// The runner stops itself when the whole plan exceeds its expected duration plus a margin, and on SIGTERM
// (`aws ecs stop-task`), so a task cannot keep billing unattended.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { estimateSeconds, runSeconds, type Plan, type PlanRun } from "./p1-plan.js";

/** Extra time allowed for the whole plan beyond its estimate. */
export const DEADLINE_MARGIN_SECONDS = 900;
/** Extra time allowed for one run beyond its steps and start-up. */
export const CHILD_MARGIN_SECONDS = 180;

export interface ChildResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}

export interface RunnerDeps {
  /** Runs one configuration with the load generator; resolves when the child has exited. */
  runChild(run: PlanRun, plan: Plan, onLine: (line: string) => void, timeoutMs: number, signal: AbortSignal): Promise<ChildResult>;
  /** Waits; resolves early (without throwing) when the signal aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  log(line: string): void;
  now(): Date;
}

const marker = (name: string, data: unknown) => `${name} ${JSON.stringify(data)}`;

export async function runPlan(plan: Plan, deps: RunnerDeps, signal: AbortSignal): Promise<{ status: "done" | "aborted"; completed: number }> {
  deps.log(marker("P1_PLAN", { seed: plan.seed, steps: plan.steps, stepSeconds: plan.stepSeconds, runs: plan.runs.length, estimateSeconds: estimateSeconds(plan) }));
  let completed = 0;
  for (const run of plan.runs) {
    if (signal.aborted) break;
    deps.log(marker("P1_WAIT", { set: run.set, index: run.index, name: run.name, seconds: run.waitSeconds, at: deps.now().toISOString() }));
    await deps.sleep(run.waitSeconds * 1000, signal);
    if (signal.aborted) break;

    deps.log(marker("P1_RUN_BEGIN", { ...run, startedAt: deps.now().toISOString() }));
    const timeoutMs = (runSeconds(plan) + CHILD_MARGIN_SECONDS) * 1000;
    const result = await deps.runChild(run, plan, deps.log, timeoutMs, signal);
    deps.log(marker("P1_RUN_END", { set: run.set, index: run.index, name: run.name, ...result, endedAt: deps.now().toISOString() }));
    completed += 1;
  }
  if (signal.aborted) {
    deps.log(marker("P1_ABORTED", { reason: String(signal.reason ?? "aborted"), completed, of: plan.runs.length }));
    return { status: "aborted", completed };
  }
  deps.log(marker("P1_DONE", { completed }));
  return { status: "done", completed };
}

/** Builds the real child runner: `node <invokePath> <url> --path ... --steps ... --step-seconds ...`. */
export function createRunChild(invokePath: string): RunnerDeps["runChild"] {
  return (run, plan, onLine, timeoutMs, signal) =>
    new Promise((resolve) => {
      const args = [invokePath, run.url, "--path", run.path, "--steps", plan.steps.join(","), "--step-seconds", String(plan.stepSeconds)];
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
  if (!Array.isArray(plan.runs) || plan.runs.length === 0 || !Array.isArray(plan.steps) || !(plan.stepSeconds > 0)) {
    throw new Error("invalid plan: needs runs, steps and stepSeconds");
  }
  return plan;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: p1-runner '<plan JSON>' | '@plan.json'");
    process.exit(2);
  }
  const plan = parsePlan(arg);
  const controller = new AbortController();
  const deadlineSeconds = estimateSeconds(plan) + DEADLINE_MARGIN_SECONDS;
  const deadline = setTimeout(() => controller.abort(`deadline of ${deadlineSeconds}s exceeded`), deadlineSeconds * 1000);
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => controller.abort(sig));

  const invokePath = process.env.P1_INVOKE_PATH ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "invoke.mjs");
  const { status } = await runPlan(
    plan,
    { runChild: createRunChild(invokePath), sleep: realSleep, log: (l) => console.log(l), now: () => new Date() },
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
