// Plan for a suite of measurements: which case runs on which configuration, in what order, and how long to wait before each run.
// Pure functions, used by scripts/suite-start.ts (local) and read by scripts/suite-runner.ts (inside the Fargate task).
// The plan is built from one definition (cases x configurations x sets, a seed, the waiting rules), so the same inputs give the
// same plan.
import { prng } from "./prng.js";

/** Wait before a run, normally. */
export const GAP_SECONDS = 300;
/**
 * Wait after a "connect every time" run: it uses up the DSQL connection budget, and the budget recovers slower than the
 * documented 100/second (docs/findings.md 2-7).
 */
export const GAP_AFTER_EACH_SECONDS = 900;
/**
 * A function is left alone for at least this long between two of its runs: Web keeps what it learned about concurrency and
 * environments linger for several minutes, so a run must start from an idle function. (The planner's own estimate of a run's
 * length can be a little short, hence the margin on top of 15 minutes.)
 */
export const MIN_SAME_FUNCTION_IDLE_SECONDS = 960;
/** Time a run takes besides its steps: start-up and wrap-up of the generator. */
export const RUN_OVERHEAD_SECONDS = 45;
/** Orders tried per set; the one that needs the least extra waiting is used (the first among equals). */
const ORDER_ATTEMPTS = 24;

/** What a case sends. Either one path, or a weighted mix of paths ("/app/item:70,/app/detail:15"). */
export interface CaseSpec {
  path?: string;
  mix?: string;
  steps: number[];
  stepSeconds: number;
  /** Load generator limits (invoke.ts defaults: 256 sockets, 2,000 requests in flight). A case that needs more sets them here. */
  maxConnections?: number;
  maxInflight?: number;
  /** Expected time of one request in ms (including cold starts and waits): the planner checks the generator can hold rate x this. */
  expectedMs?: number;
}
export interface CaseDef extends CaseSpec {
  id: string;
  /** Configuration names (function names without the "gekko10-" prefix). */
  configs: string[];
}

export interface PlanRun {
  set: number;
  /** 1-based position inside the set. */
  index: number;
  case: string;
  name: string;
  /** Seconds to wait before this run starts. */
  waitSeconds: number;
}

export interface Plan {
  /** Name of the measurement definition, e.g. "v2". */
  protocol: string;
  seed: string;
  /** The build id every response must carry (scripts/bundle.mjs). */
  build: string;
  /** Base URL per configuration used in the plan. */
  urls: Record<string, string>;
  /** The cases used in the plan, by id. */
  cases: Record<string, CaseSpec>;
  runs: PlanRun[];
  /** Post-processing inside the task (scripts/suite-post.ts). Absent: no post-processing. */
  post?: { clusterId: string; metricsLagSeconds: number };
}

export function shuffled<T>(items: readonly T[], seed: string): T[] {
  const a = [...items];
  const rand = prng(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface PlanOptions {
  protocol: string;
  sets: number[];
  seed: string;
  build: string;
  /** Base URL per configuration name. */
  urls: Record<string, string>;
  cases: CaseDef[];
  /** Restrict to these configurations. */
  only?: string[];
  /** Wait before the very first run. */
  firstWait: number;
  /** Least idle time of a function between two of its runs (default MIN_SAME_FUNCTION_IDLE_SECONDS; calibration uses less). */
  minIdleSeconds?: number;
  post?: Plan["post"];
}

export const runSeconds = (spec: Pick<CaseSpec, "steps" | "stepSeconds">) => spec.steps.length * spec.stepSeconds + RUN_OVERHEAD_SECONDS;

interface Cursor {
  /** Seconds since the plan started, at the end of the last scheduled run. */
  t: number;
  lastEnd: Map<string, number>;
  prev?: string;
}

/** Waits for a list of runs from a given point, and how much of the waiting was added to keep a function idle. */
function schedule(order: { case: string; name: string }[], cases: Record<string, CaseSpec>, start: Cursor, firstWait: number, minIdle: number) {
  let t = start.t;
  const lastEnd = new Map(start.lastEnd);
  let prev = start.prev;
  let extension = 0;
  const waits: number[] = [];
  for (const o of order) {
    const base = prev === undefined ? firstWait : prev.endsWith("dsql-each") ? GAP_AFTER_EACH_SECONDS : GAP_SECONDS;
    const last = lastEnd.get(o.name);
    const wait = last === undefined ? base : Math.max(base, minIdle - (t - last));
    extension += wait - base;
    t += wait + runSeconds(cases[o.case]);
    lastEnd.set(o.name, t);
    prev = o.name;
    waits.push(wait);
  }
  return { waits, extension, cursor: { t, lastEnd, prev } as Cursor };
}

export function buildPlan(opts: PlanOptions): Plan {
  const combos = opts.cases.flatMap((c) => c.configs.filter((n) => !opts.only || opts.only.includes(n)).map((name) => ({ case: c.id, name })));
  if (combos.length === 0) throw new Error("no configuration selected");
  const names = [...new Set(combos.map((c) => c.name))];
  const missing = names.filter((n) => !opts.urls[n]);
  if (missing.length) throw new Error(`no URL for: ${missing.join(", ")}`);
  const usedCases = [...new Set(combos.map((c) => c.case))];
  const specs = Object.fromEntries(opts.cases.filter((c) => usedCases.includes(c.id)).map(({ id, configs: _configs, ...spec }) => [id, spec]));

  const runs: PlanRun[] = [];
  let cursor: Cursor = { t: 0, lastEnd: new Map() };
  for (const set of opts.sets) {
    let best: { order: typeof combos; sched: ReturnType<typeof schedule> } | undefined;
    for (let attempt = 0; attempt < ORDER_ATTEMPTS; attempt++) {
      const order = shuffled(combos, attempt === 0 ? `${opts.seed}-${set}` : `${opts.seed}-${set}-${attempt}`);
      const sched = schedule(order, specs, cursor, opts.firstWait, opts.minIdleSeconds ?? MIN_SAME_FUNCTION_IDLE_SECONDS);
      if (!best || sched.extension < best.sched.extension) best = { order, sched };
      if (sched.extension === 0) break;
    }
    best!.order.forEach((o, i) => runs.push({ set, index: i + 1, case: o.case, name: o.name, waitSeconds: best!.sched.waits[i] }));
    cursor = best!.sched.cursor;
  }

  return {
    protocol: opts.protocol,
    seed: opts.seed,
    build: opts.build,
    urls: Object.fromEntries(names.map((n) => [n, opts.urls[n].replace(/\/$/, "")])),
    cases: specs,
    runs,
    ...(opts.post ? { post: opts.post } : {}),
  };
}

export const specOf = (plan: Plan, run: Pick<PlanRun, "case">): CaseSpec => plan.cases[run.case];
export const runDuration = (plan: Plan, run: PlanRun) => runSeconds(specOf(plan, run));

/** Expected total duration of the plan in seconds (waits and runs; the post-processing is separate). */
export function estimateSeconds(plan: Plan): number {
  return plan.runs.reduce((sum, r) => sum + r.waitSeconds + runDuration(plan, r), 0);
}

/** How long the post-processing takes at most: the metrics of the last run's window must have arrived. */
export const POST_WINDOW_AFTER_SECONDS = 8 * 60;
export const POST_MARGIN_SECONDS = 20 * 60;
export const postSeconds = (plan: Plan) => (plan.post ? POST_WINDOW_AFTER_SECONDS + plan.post.metricsLagSeconds + POST_MARGIN_SECONDS : 0);

/** The arguments after the script path for `invoke` (scripts/invoke.ts): the url, what to send, and the steps. */
export function invokeArgs(plan: Plan, run: PlanRun): string[] {
  const spec = specOf(plan, run);
  const target = spec.mix ? ["--mix", spec.mix, "--mix-seed", `${plan.seed}:${run.case}:${run.set}`] : ["--path", spec.path ?? "/noop"];
  const limits = [...(spec.maxConnections ? ["--max-connections", String(spec.maxConnections)] : []), ...(spec.maxInflight ? ["--max-inflight", String(spec.maxInflight)] : [])];
  return [plan.urls[run.name], ...target, "--steps", spec.steps.join(","), "--step-seconds", String(spec.stepSeconds), ...limits];
}

export const DEFAULT_MAX_CONNECTIONS = 256;
export const DEFAULT_MAX_INFLIGHT = 2000;
/** The generator must stay well inside its limits: sockets up to 60%, requests in flight up to 80%. */
export const CONNECTION_HEADROOM = 0.6;
export const INFLIGHT_HEADROOM = 0.8;

/**
 * Cases whose load needs more concurrent requests (peak rate x expected time) than the generator can hold. A generator that hits its
 * limit queues the requests itself and the step measures the generator, not the platform (the 400 RPS step of case A in v2.0 did).
 */
export function capacityProblems(cases: Record<string, CaseSpec>): string[] {
  return Object.entries(cases).flatMap(([id, c]) => {
    if (c.expectedMs === undefined) return [];
    const needed = Math.max(...c.steps) * (c.expectedMs / 1000);
    const conns = c.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    const inflight = c.maxInflight ?? DEFAULT_MAX_INFLIGHT;
    const problems: string[] = [];
    if (needed > CONNECTION_HEADROOM * conns) problems.push(`case ${id}: about ${Math.ceil(needed)} concurrent requests at the peak, but max-connections is ${conns} (keep it above ${Math.ceil(needed / CONNECTION_HEADROOM)})`);
    if (needed > INFLIGHT_HEADROOM * inflight) problems.push(`case ${id}: about ${Math.ceil(needed)} requests in flight at the peak, but max-inflight is ${inflight} (keep it above ${Math.ceil(needed / INFLIGHT_HEADROOM)})`);
    return problems;
  });
}
