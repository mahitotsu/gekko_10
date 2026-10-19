// Pure helpers for scripts/invoke.ts: summaries and the open-loop (constant arrival rate) dispatcher.
// Kept apart from invoke.ts so they can be unit-tested; invoke.ts runs on import.

import { prng } from "./prng.js";

export interface Result {
  status: number;
  /** The endpoint this request went to (set when a request mix is used). */
  path?: string;
  /** Time from sending the request to reading the response. */
  ms: number;
  body: Record<string, unknown> | null;
  /** Seconds since the run started, when the request finished. */
  t: number;
  /** Platform error type (`lambda-web-error-type` header) or the client-side failure cause (e.g. a connect timeout). */
  errorType?: string;
  /** Open loop only: index of the step the request was scheduled in. */
  step?: number;
  /** Open loop only: how late the request was dispatched versus its scheduled time. */
  lateMs?: number;
  /** Open loop only: time from the scheduled send time to the response (does not hide generator delay). */
  fromScheduleMs?: number;
}

export type Quantiles = { p50?: number; p95?: number; p99?: number };

// ---- request mix ----
export interface MixEntry {
  path: string;
  weight: number;
}

/** Parses "/app/item:70,/app/detail?n=11:15": comma-separated entries, each a path (with optional query) and a weight after the last colon. */
export function parseMix(spec: string): MixEntry[] {
  const entries = spec.split(",").map((part) => {
    const i = part.lastIndexOf(":");
    const weight = Number(part.slice(i + 1));
    const path = part.slice(0, i);
    if (i <= 0 || !path.startsWith("/") || !Number.isFinite(weight) || weight <= 0) throw new Error(`invalid mix entry: "${part}" (expected /path:weight)`);
    return { path, weight };
  });
  if (entries.length === 0) throw new Error("empty mix");
  return entries;
}

/**
 * The endpoint of request `index` in step `step`. It depends only on (seed, step, index), so the sequence is the same on every
 * run and does not shift when an earlier request is dropped.
 */
export function pickPath(mix: MixEntry[], seed: string, step: number, index: number): string {
  const total = mix.reduce((n, m) => n + m.weight, 0);
  let x = prng(`${seed}:${step}:${index}`)() * total;
  for (const m of mix) {
    x -= m.weight;
    if (x < 0) return m.path;
  }
  return mix[mix.length - 1].path;
}

export function quantile(xs: number[], p: number): number | undefined {
  if (xs.length === 0) return undefined;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
}

export function quantiles(xs: number[]): Quantiles {
  return { p50: quantile(xs, 50), p95: quantile(xs, 95), p99: quantile(xs, 99) };
}

const round = (x: number | undefined, digits = 1) => (x === undefined ? undefined : Number(x.toFixed(digits)));
const roundQ = (q: Quantiles): Quantiles => ({ p50: round(q.p50), p95: round(q.p95), p99: round(q.p99) });

/**
 * Failure label: HTTP status plus, where available, the app's DB error class/phase
 * (53400 = DSQL connection rate, 53300 = DSQL connection count) or the platform error type
 * (e.g. Platform.EndpointRequestThrottle). Status 0 is a client-side failure; its label carries the cause.
 */
export function failureKey(r: Result): string {
  const b = r.body as { code?: string; phase?: string } | null;
  if (b?.code) return `${r.status} db:${b.code}/${b.phase}`;
  return r.errorType ? `${r.status} ${r.errorType}` : String(r.status);
}

export function countBy(rs: Result[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of rs) m[failureKey(r)] = (m[failureKey(r)] ?? 0) + 1;
  return m;
}

type DbInfo = {
  newConnection?: boolean;
  acquireMs?: number;
  queryMs?: number;
  releaseMs?: number;
  queries?: number;
  pool?: { total?: number; waiting?: number };
};
const dbOf = (r: Result) => (r.body?.db ?? null) as DbInfo | null;
const numbers = (xs: (number | undefined)[]) => xs.filter((x): x is number => typeof x === "number");
/**
 * Largest value of a list. Math.max(...xs) throws "Maximum call stack size exceeded" once xs has more than about
 * 100,000 entries, which a single step of a high-rate run reaches.
 */
export function maxOf(xs: number[], floor = 0): number {
  let m = floor;
  for (const x of xs) if (x > m) m = x;
  return m;
}

export interface StepCounts {
  scheduled: number;
  sent: number;
  /** Not sent because max-inflight was reached. */
  dropped: number;
}

/** Where the time of a request went, from the app's own timing (response field `appMs`) against the client's. */
export interface AppBreakdown {
  /** Handler time inside the app. */
  appMs: Quantiles;
  /** Client time minus handler time: network, the platform's front end and invocation, the adapter. Per request, so the quantiles are exact. */
  outsideMs: Quantiles;
  /** Handler time minus the DB time (acquire + query + release): CPU work, waits, serialization. */
  appOtherMs: Quantiles;
  /** Responses whose handler time exceeds the client's time (they should not exist; > 0.1% fails the acceptance check). */
  inconsistent: number;
  /** Responses that carried an `appMs`. */
  count: number;
}

export interface GroupSummary {
  completed: number;
  ok: number;
  failures: Record<string, number>;
  latencyMs: Quantiles;
  serviceMs: Quantiles;
  db?: {
    newConnectionPct: number;
    acquireMs: Quantiles;
    queryMs: Quantiles;
    queriesPerRequest: number;
    /** Largest number of requests waiting for a pooled connection that any response reported (pool mode only). */
    poolWaitingMax?: number;
    poolTotalMax?: number;
  };
  app?: AppBreakdown;
}

export interface StepSummary extends StepCounts, GroupSummary {
  step: number;
  rate: number;
  seconds: number;
  achievedRps: number;
  /** Share of sent requests dispatched more than LATE_MS after their scheduled time. */
  lateRate: number;
  lateP95Ms?: number;
  environments: number;
  coldStarts: number;
  /** Highest in-flight count any environment reported in this step. */
  peakInFlight: number;
  loadgenCores?: number;
  /** Distinct `build` values the responses carried (should be exactly one, the one the plan expects). */
  builds: string[];
  /** The same summary per endpoint, when a request mix is used. */
  byPath?: Record<string, GroupSummary>;
}

export const LATE_MS = 100;

const bodyNumber = (r: Result, key: string): number | undefined => {
  const v = r.body?.[key];
  return typeof v === "number" ? v : undefined;
};

function breakdown(ok: Result[]): AppBreakdown | undefined {
  const withApp = ok.filter((r) => bodyNumber(r, "appMs") !== undefined);
  if (withApp.length === 0) return undefined;
  const dbMs = (r: Result) => {
    const d = dbOf(r);
    return (d?.acquireMs ?? 0) + (d?.queryMs ?? 0) + (d?.releaseMs ?? 0);
  };
  return {
    appMs: roundQ(quantiles(withApp.map((r) => bodyNumber(r, "appMs")!))),
    outsideMs: roundQ(quantiles(withApp.map((r) => r.ms - bodyNumber(r, "appMs")!))),
    appOtherMs: roundQ(quantiles(withApp.map((r) => bodyNumber(r, "appMs")! - dbMs(r)))),
    inconsistent: withApp.filter((r) => bodyNumber(r, "appMs")! > r.ms).length,
    count: withApp.length,
  };
}

/** The part of a summary that does not depend on the step: outcomes, latency, DB and app timing of one group of results. */
export function summarizeGroup(results: Result[]): GroupSummary {
  const ok = results.filter((r) => r.status === 200);
  const failed = results.filter((r) => r.status !== 200);
  const dbs = ok.map(dbOf).filter((d): d is DbInfo => d !== null);
  const pools = dbs.map((d) => d.pool).filter((p): p is NonNullable<DbInfo["pool"]> => p !== undefined);
  return {
    completed: results.length,
    ok: ok.length,
    failures: countBy(failed),
    latencyMs: roundQ(quantiles(numbers(ok.map((r) => r.fromScheduleMs ?? r.ms)))),
    serviceMs: roundQ(quantiles(ok.map((r) => r.ms))),
    db: dbs.length
      ? {
          newConnectionPct: round((100 * dbs.filter((d) => d.newConnection).length) / dbs.length, 1)!,
          acquireMs: roundQ(quantiles(numbers(dbs.map((d) => d.acquireMs)))),
          queryMs: roundQ(quantiles(numbers(dbs.map((d) => d.queryMs)))),
          queriesPerRequest: round(numbers(dbs.map((d) => d.queries ?? 1)).reduce((n, x) => n + x, 0) / dbs.length, 2)!,
          ...(pools.length ? { poolWaitingMax: maxOf(numbers(pools.map((p) => p.waiting))), poolTotalMax: maxOf(numbers(pools.map((p) => p.total))) } : {}),
        }
      : undefined,
    app: breakdown(ok),
  };
}

export function summarizeStep(
  step: number,
  rate: number,
  seconds: number,
  results: Result[],
  counts: StepCounts,
  loadgenCores?: number,
): StepSummary {
  const ok = results.filter((r) => r.status === 200);
  const late = results.filter((r) => (r.lateMs ?? 0) > LATE_MS).length;
  const paths = [...new Set(results.map((r) => r.path).filter((p): p is string => p !== undefined))].sort();
  return {
    step,
    rate,
    seconds,
    ...counts,
    ...summarizeGroup(results),
    achievedRps: round(ok.length / seconds, 1)!,
    lateRate: counts.sent ? Number((late / counts.sent).toFixed(4)) : 0,
    lateP95Ms: round(quantile(numbers(results.map((r) => r.lateMs)), 95)),
    environments: new Set(ok.map((r) => r.body?.envId)).size,
    coldStarts: ok.filter((r) => r.body?.coldStart).length,
    peakInFlight: maxOf(ok.map((r) => Number(r.body?.inFlight ?? 0))),
    loadgenCores: round(loadgenCores, 2),
    builds: [...new Set(ok.map((r) => r.body?.build).filter((b): b is string => typeof b === "string"))].sort(),
    ...(paths.length > 1 ? { byPath: Object.fromEntries(paths.map((p) => [p, summarizeGroup(results.filter((r) => r.path === p))])) } : {}),
  };
}

export interface OpenLoopOptions {
  /** One entry per step: requests per second. */
  rates: number[];
  stepSeconds: number;
  /** New requests are dropped (and counted) while this many are in flight. */
  maxInflight: number;
  /** Stop after a step whose failure share reaches this (0..1). Needs at least MIN_SAMPLES_FOR_STOP requests in the step. */
  stopOnErrorRate?: number;
  /** Sends request number `index` of `step`, scheduled at `scheduledAt` (performance.now() scale). */
  send: (scheduledAt: number, step: number, index: number) => Promise<Result>;
  /** CPU time used by this process so far, in seconds (user + system). */
  cpuSeconds?: () => number;
  drainTimeoutMs?: number;
  /** Called with each step's summary as soon as the step ends, so that partial results survive a later failure. */
  onStep?: (summary: StepSummary) => void;
}

export interface OpenLoopOutcome {
  results: Result[];
  steps: StepSummary[];
  stoppedEarly?: { afterStep: number; errorRate: number };
  /** Requests still unanswered when the drain timeout ended. */
  unfinished: number;
}

export const MIN_SAMPLES_FOR_STOP = 50;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Sends requests at a constant arrival rate, step by step. Request i of a step is scheduled at
 * stepStart + i / rate regardless of how earlier requests are doing, so a slow or failing target cannot
 * change the offered load (unlike a fixed number of workers). Lateness is recorded rather than hidden.
 */
export async function runOpenLoop(opts: OpenLoopOptions): Promise<OpenLoopOutcome> {
  const results: Result[] = [];
  const summaries: StepSummary[] = [];
  const pending = new Set<Promise<void>>();
  let inflight = 0;
  let stoppedEarly: OpenLoopOutcome["stoppedEarly"];
  const cpu = opts.cpuSeconds ?? (() => 0);

  for (let step = 0; step < opts.rates.length; step++) {
    const rate = opts.rates[step];
    const stepStart = performance.now();
    const cpuStart = cpu();
    const total = Math.round(rate * opts.stepSeconds);
    const counts: StepCounts = { scheduled: total, sent: 0, dropped: 0 };
    let dispatched = 0;

    while (dispatched < total) {
      // Number of requests whose scheduled time has arrived (request 0 is due at the step start).
      const due = Math.min(total, Math.floor(((performance.now() - stepStart) / 1000) * rate) + 1);
      while (dispatched < due) {
        const index = dispatched;
        const scheduledAt = stepStart + (index * 1000) / rate;
        dispatched += 1;
        if (inflight >= opts.maxInflight) {
          counts.dropped += 1;
          continue;
        }
        inflight += 1;
        counts.sent += 1;
        const p = opts
          .send(scheduledAt, step, index)
          .then((r) => {
            results.push(r);
          })
          // A request that throws (e.g. signing failed) counts as a client-side failure instead of crashing the run.
          .catch(() => {
            results.push({ status: 0, ms: 0, body: null, t: 0, step, lateMs: 0 });
          })
          .finally(() => {
            inflight -= 1;
            pending.delete(p);
          });
        pending.add(p);
      }
      if (dispatched < total) await sleep(1);
    }
    const remaining = stepStart + opts.stepSeconds * 1000 - performance.now();
    if (remaining > 0) await sleep(remaining);

    const elapsedSec = (performance.now() - stepStart) / 1000;
    const stepResults = results.filter((r) => r.step === step);
    const summary = summarizeStep(step, rate, opts.stepSeconds, stepResults, counts, (cpu() - cpuStart) / elapsedSec);
    summaries.push(summary);
    opts.onStep?.(summary);

    if (opts.stopOnErrorRate !== undefined && stepResults.length >= MIN_SAMPLES_FOR_STOP) {
      const errorRate = (stepResults.length - summary.ok) / stepResults.length;
      if (errorRate >= opts.stopOnErrorRate && step < opts.rates.length - 1) {
        stoppedEarly = { afterStep: step, errorRate: Number(errorRate.toFixed(3)) };
        break;
      }
    }
  }

  // Let the requests still in flight finish, so the last step is not cut short.
  const drain = Promise.allSettled([...pending]);
  await Promise.race([drain, sleep(opts.drainTimeoutMs ?? 30_000)]);
  const unfinished = pending.size;

  // Responses that arrived after a step was summarised belong to that step; recompute with the final data.
  const final = summaries.map((s) =>
    summarizeStep(
      s.step,
      s.rate,
      s.seconds,
      results.filter((r) => r.step === s.step),
      { scheduled: s.scheduled, sent: s.sent, dropped: s.dropped },
      s.loadgenCores,
    ),
  );
  return { results, steps: final, stoppedEarly, unfinished };
}
