// Pure helpers for scripts/invoke.ts: summaries and the open-loop (constant arrival rate) dispatcher.
// Kept apart from invoke.ts so they can be unit-tested; invoke.ts runs on import.

export interface Result {
  status: number;
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

type DbInfo = { newConnection?: boolean; acquireMs?: number; queryMs?: number };
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

export interface StepSummary extends StepCounts {
  step: number;
  rate: number;
  seconds: number;
  completed: number;
  ok: number;
  /** Non-200 responses and client-side failures, by label. */
  failures: Record<string, number>;
  achievedRps: number;
  /** Share of sent requests dispatched more than LATE_MS after their scheduled time. */
  lateRate: number;
  lateP95Ms?: number;
  /** Latency of 200 responses measured from the scheduled send time. */
  latencyMs: Quantiles;
  /** Latency of 200 responses measured from the actual send (server-side view plus network). */
  serviceMs: Quantiles;
  db?: { newConnectionPct: number; acquireMs: Quantiles; queryMs: Quantiles };
  environments: number;
  coldStarts: number;
  /** Highest in-flight count any environment reported in this step. */
  peakInFlight: number;
  loadgenCores?: number;
}

export const LATE_MS = 100;

export function summarizeStep(
  step: number,
  rate: number,
  seconds: number,
  results: Result[],
  counts: StepCounts,
  loadgenCores?: number,
): StepSummary {
  const ok = results.filter((r) => r.status === 200);
  const failed = results.filter((r) => r.status !== 200);
  const dbs = ok.map(dbOf).filter((d): d is DbInfo => d !== null);
  const late = results.filter((r) => (r.lateMs ?? 0) > LATE_MS).length;
  return {
    step,
    rate,
    seconds,
    ...counts,
    completed: results.length,
    ok: ok.length,
    failures: countBy(failed),
    achievedRps: round(ok.length / seconds, 1)!,
    lateRate: counts.sent ? Number((late / counts.sent).toFixed(4)) : 0,
    lateP95Ms: round(quantile(numbers(results.map((r) => r.lateMs)), 95)),
    latencyMs: roundQ(quantiles(numbers(ok.map((r) => r.fromScheduleMs ?? r.ms)))),
    serviceMs: roundQ(quantiles(ok.map((r) => r.ms))),
    db: dbs.length
      ? {
          newConnectionPct: round((100 * dbs.filter((d) => d.newConnection).length) / dbs.length, 1)!,
          acquireMs: roundQ(quantiles(numbers(dbs.map((d) => d.acquireMs)))),
          queryMs: roundQ(quantiles(numbers(dbs.map((d) => d.queryMs)))),
        }
      : undefined,
    environments: new Set(ok.map((r) => r.body?.envId)).size,
    coldStarts: ok.filter((r) => r.body?.coldStart).length,
    peakInFlight: maxOf(ok.map((r) => Number(r.body?.inFlight ?? 0))),
    loadgenCores: round(loadgenCores, 2),
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
  /** Sends one request that was scheduled at `scheduledAt` (performance.now() scale). */
  send: (scheduledAt: number, step: number) => Promise<Result>;
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
        const scheduledAt = stepStart + (dispatched * 1000) / rate;
        dispatched += 1;
        if (inflight >= opts.maxInflight) {
          counts.dropped += 1;
          continue;
        }
        inflight += 1;
        counts.sent += 1;
        const p = opts
          .send(scheduledAt, step)
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
