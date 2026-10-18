// Plan for P1 (step-up load): which configuration runs when, and how long to wait before each run.
// Pure functions, used by scripts/p1-start.ts (local) and read by scripts/p1-runner.ts (inside the Fargate task).

export const CONFIGS = [
  "event-noop",
  "event-dsql-each",
  "event-dsql-reuse",
  "web-noop",
  "web-dsql-each",
  "web-dsql-pool",
] as const;

/** Wait before a run, normally. */
export const GAP_SECONDS = 300;
/**
 * Wait after a "connect every time" run: it uses up the DSQL connection budget, and the budget recovers slower than the
 * documented 100/second (docs/findings.md 2-7).
 */
export const GAP_AFTER_EACH_SECONDS = 900;

export interface PlanRun {
  set: number;
  /** 1-based position inside the set. */
  index: number;
  name: string;
  url: string;
  path: string;
  /** Seconds to wait before this run starts. */
  waitSeconds: number;
}

export interface Plan {
  seed: string;
  steps: number[];
  stepSeconds: number;
  runs: PlanRun[];
}

// Small deterministic PRNG (FNV-1a hash of the seed string, then mulberry32), so an order can be reproduced from its seed.
function prng(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
  sets: number[];
  seed: string;
  /** Base URL per configuration name. */
  urls: Record<string, string>;
  /** Restrict to these configurations (default: all six). */
  only?: string[];
  steps: number[];
  stepSeconds: number;
  /** Wait before the very first run. */
  firstWait: number;
}

export function buildPlan(opts: PlanOptions): Plan {
  const names = CONFIGS.filter((c) => !opts.only || opts.only.includes(c));
  if (names.length === 0) throw new Error("no configuration selected");
  const missing = names.filter((n) => !opts.urls[n]);
  if (missing.length) throw new Error(`no URL for: ${missing.join(", ")}`);

  const runs: PlanRun[] = [];
  let previous: string | undefined;
  for (const set of opts.sets) {
    shuffled(names, `${opts.seed}-${set}`).forEach((name, i) => {
      const waitSeconds = previous === undefined ? opts.firstWait : previous.endsWith("dsql-each") ? GAP_AFTER_EACH_SECONDS : GAP_SECONDS;
      runs.push({
        set,
        index: i + 1,
        name,
        url: opts.urls[name].replace(/\/$/, ""),
        path: name.endsWith("noop") ? "/noop" : "/db/read",
        waitSeconds,
      });
      previous = name;
    });
  }
  return { seed: opts.seed, steps: opts.steps, stepSeconds: opts.stepSeconds, runs };
}

/** Time a run takes, besides its wait: the steps plus start-up and wrap-up of the generator. */
export const RUN_OVERHEAD_SECONDS = 45;

export function runSeconds(plan: Pick<Plan, "steps" | "stepSeconds">): number {
  return plan.steps.length * plan.stepSeconds + RUN_OVERHEAD_SECONDS;
}

/** Expected total duration of the plan in seconds. */
export function estimateSeconds(plan: Plan): number {
  return plan.runs.reduce((sum, r) => sum + r.waitSeconds + runSeconds(plan), 0);
}
