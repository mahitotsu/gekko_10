// SigV4-signed requests to an IAM-authenticated function URL or Web Function endpoint.
// Usage: npm run invoke -- <base-url> [--path /noop] [--count 1] [--concurrency 1] [--region ap-northeast-1]
//        [--duration SECONDS]  run for a fixed time instead of --count, and print a 10-second timeline
//
// Constant arrival rate (open loop): the offered load does not depend on how fast the target answers.
//        --rate R --duration SECONDS                 R requests/s for SECONDS
//        --steps 25,50,100 [--step-seconds 90]       a ramp, one rate per step
//        [--max-inflight 2000]                       drop (and count) new requests while this many are in flight
//        [--stop-on-error-rate 0.5]                  stop the ramp after a step whose failure share reaches this
// Prints a table and one `RESULT_JSON {...}` line with per-step summaries.
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";
import os from "node:os";
import { parseArgs } from "node:util";
import { countBy, quantile, runOpenLoop, type Result } from "./loadgen-lib.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    path: { type: "string", default: "/noop" },
    count: { type: "string", default: "1" },
    concurrency: { type: "string", default: "1" },
    region: { type: "string", default: "ap-northeast-1" },
    duration: { type: "string" },
    rate: { type: "string" },
    steps: { type: "string" },
    "step-seconds": { type: "string" },
    "max-inflight": { type: "string", default: "2000" },
    "stop-on-error-rate": { type: "string" },
  },
});

const base = positionals[0];
if (!base) {
  console.error(
    "usage: invoke <base-url> [--path /noop] [--count N] [--concurrency C] [--duration S] [--rate R | --steps R1,R2,...] [--step-seconds S] [--region R]",
  );
  process.exit(2);
}

const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const openLoop = values.rate !== undefined || values.steps !== undefined;
const duration = values.duration ? Number(values.duration) : undefined;
const count = duration ? Number.POSITIVE_INFINITY : Number(values.count);
const concurrency = Number(values.concurrency);
const url = new URL(values.path!, base);

// Function URLs and Web Function endpoints both sign with the service name "lambda".
const signer = new SignatureV4({
  service: "lambda",
  region: values.region!,
  credentials: defaultProvider(),
  sha256: Sha256,
});

const startedAt = new Date().toISOString();
const cpuStart = process.cpuUsage();
const runStart = performance.now();
const elapsedSec = () => (performance.now() - runStart) / 1000;

// In the open loop, failures are counted by type and not printed one by one: a rate-limited run can fail hundreds
// of thousands of requests.
async function once(quiet: boolean): Promise<Result> {
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => (query[k] = v));
  const signed = await signer.sign({
    method: "GET",
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    query,
    headers: {
      host: url.hostname,
      // Required by Web Function endpoints even for empty bodies. Function URLs reject UNSIGNED-PAYLOAD
      // (signature mismatch), so send the real SHA-256 of the empty body, which both accept.
      "x-amz-content-sha256": EMPTY_BODY_SHA256,
    },
  });
  const started = performance.now();
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, { headers: signed.headers as Record<string, string> });
    text = await res.text();
  } catch (e) {
    // Client-side failure (connect timeout etc.): count it, don't abort the whole run.
    const cause = (e as Error & { cause?: { code?: string } }).cause;
    const errorType = cause?.code ?? (e as Error).message;
    if (!quiet) console.error(`fetch failed: ${errorType}`);
    return { status: 0, ms: performance.now() - started, body: null, t: elapsedSec(), errorType };
  }
  const ms = performance.now() - started;
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON error body (e.g. 403/429 from the platform).
  }
  const errorType = res.ok ? undefined : (res.headers.get("lambda-web-error-type") ?? undefined);
  if (!res.ok && !quiet) {
    console.error(`${res.status} ${errorType ?? ""} ${text.slice(0, 200)}`);
  }
  return { status: res.status, ms, body, t: elapsedSec(), errorType };
}

// Average number of CPU cores this load generator used. Close to the cores available means the generator itself
// is the bottleneck and the measured latency/throughput is not trustworthy.
const cpuSeconds = () => {
  const used = process.cpuUsage();
  return (used.user + used.system) / 1e6;
};
function loadgenCores(): number {
  const used = process.cpuUsage(cpuStart);
  return (used.user + used.system) / 1e6 / elapsedSec();
}

if (openLoop) {
  const stepSeconds = values.steps ? Number(values["step-seconds"] ?? 90) : duration;
  const rates = values.steps ? values.steps.split(",").map(Number) : [Number(values.rate)];
  if (!stepSeconds || !(stepSeconds > 0) || rates.some((r) => !Number.isFinite(r) || r <= 0)) {
    console.error("open loop needs --rate R --duration S, or --steps R1,R2,... [--step-seconds S] (all positive numbers)");
    process.exit(2);
  }
  const stopOnErrorRate = values["stop-on-error-rate"] ? Number(values["stop-on-error-rate"]) : undefined;
  const maxInflight = Number(values["max-inflight"]);

  const out = await runOpenLoop({
    rates,
    stepSeconds,
    maxInflight,
    stopOnErrorRate,
    cpuSeconds,
    send: async (scheduledAt, step) => {
      const dispatchedAt = performance.now();
      const r = await once(true);
      return { ...r, step, lateMs: dispatchedAt - scheduledAt, fromScheduleMs: performance.now() - scheduledAt };
    },
  });

  const f = (x: number | undefined, d = 0) => (x === undefined ? "-" : x.toFixed(d));
  console.log("step  rate  sent  drop    ok   err  okRPS  late%  p50ms  p95ms  p99ms svcP50 svcP95  newConn%  acqP50  acqP95  envs  cores");
  for (const s of out.steps) {
    const err = s.completed - s.ok;
    console.log(
      [
        String(s.step).padStart(4),
        String(s.rate).padStart(5),
        String(s.sent).padStart(5),
        String(s.dropped).padStart(5),
        String(s.ok).padStart(5),
        String(err).padStart(5),
        f(s.achievedRps).padStart(6),
        f(s.lateRate * 100, 1).padStart(6),
        f(s.latencyMs.p50).padStart(6),
        f(s.latencyMs.p95).padStart(6),
        f(s.latencyMs.p99).padStart(6),
        f(s.serviceMs.p50).padStart(6),
        f(s.serviceMs.p95).padStart(6),
        (s.db ? f(s.db.newConnectionPct) : "-").padStart(9),
        (s.db ? f(s.db.acquireMs.p50, 1) : "-").padStart(7),
        (s.db ? f(s.db.acquireMs.p95, 1) : "-").padStart(7),
        String(s.environments).padStart(5),
        f(s.loadgenCores, 2).padStart(6),
      ].join(" "),
    );
    if (err) console.log(`      failures: ${JSON.stringify(s.failures)}`);
  }
  if (out.stoppedEarly) console.log(`stopped early after step ${out.stoppedEarly.afterStep}: failure rate ${out.stoppedEarly.errorRate}`);
  if (out.unfinished) console.log(`unfinished requests at the end: ${out.unfinished}`);
  console.log(`load generator: ${loadgenCores().toFixed(2)} cores used on average (${os.availableParallelism()} available)`);
  console.log(
    `RESULT_JSON ${JSON.stringify({
      target: url.href,
      startedAt,
      endedAt: new Date().toISOString(),
      options: { rates, stepSeconds, maxInflight, stopOnErrorRate },
      loadgen: { coresUsed: Number(loadgenCores().toFixed(2)), coresAvailable: os.availableParallelism() },
      stoppedEarly: out.stoppedEarly,
      unfinished: out.unfinished,
      steps: out.steps,
    })}`,
  );
  process.exit(0);
}

const results: Result[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (duration ? elapsedSec() < duration : next++ < count) results.push(await once(false));
  }),
);

if (count === 1) {
  console.log(JSON.stringify(results[0].body, null, 2));
} else if (duration) {
  const dbOf = (r: Result) => (r.body?.db ?? null) as { newConnection?: boolean; acquireMs?: number } | null;
  // Timeline per 10-second window: how many environments served requests, and how many requests
  // each environment handled at the same time (inFlight is as of arrival, maxInFlight is the environment's peak).
  const seen = new Set<unknown>();
  console.log("window  req  err  envs(window) envs(total)  maxInFlight(window)  p50ms  p95ms  newConn%  acqP50ms  acqP95ms");
  for (let w = 0; w * 10 < duration + 10; w++) {
    const inWin = results.filter((r) => r.t >= w * 10 && r.t < (w + 1) * 10);
    if (inWin.length === 0) continue;
    const ok = inWin.filter((r) => r.status === 200);
    const winEnvs = new Set(ok.map((r) => r.body?.envId));
    winEnvs.forEach((e) => seen.add(e));
    const lat = ok.map((r) => r.ms);
    const q = (p: number) => quantile(lat, p)?.toFixed(0) ?? "-";
    const peak = Math.max(0, ...ok.map((r) => Number(r.body?.inFlight ?? 0)));
    // DB columns stay "-" for the noop functions. acquire = time until a connection was ready.
    const dbs = ok.map(dbOf).filter((d) => d !== null);
    const newPct = dbs.length ? ((100 * dbs.filter((d) => d!.newConnection).length) / dbs.length).toFixed(0) : "-";
    const acq = dbs.map((d) => d!.acquireMs).filter((x): x is number => typeof x === "number");
    const acqQ = (p: number) => quantile(acq, p)?.toFixed(1) ?? "-";
    console.log(
      `${String(w * 10).padStart(4)}s ${String(inWin.length).padStart(5)} ${String(inWin.length - ok.length).padStart(4)} ${String(winEnvs.size).padStart(12)} ${String(seen.size).padStart(11)} ${String(peak).padStart(19)} ${q(50).padStart(6)} ${q(95).padStart(6)} ${newPct.padStart(9)} ${acqQ(50).padStart(9)} ${acqQ(95).padStart(9)}`,
    );
  }
  const perEnv = new Map<unknown, number>();
  results.forEach((r) => r.body && perEnv.set(r.body.envId, Math.max(perEnv.get(r.body.envId) ?? 0, Number(r.body.maxInFlight ?? 0))));
  const peaks = [...perEnv.values()].sort((a, b) => a - b);
  const failed = results.filter((r) => r.status !== 200);
  if (failed.length) console.log(`failures: ${JSON.stringify(countBy(failed))}`);
  console.log(`load generator: ${loadgenCores().toFixed(2)} cores used on average (${os.availableParallelism()} available)`);
  console.log(`environments: ${perEnv.size}, per-environment peak concurrency: min ${peaks[0]}, median ${peaks[Math.floor(peaks.length / 2)]}, max ${peaks[peaks.length - 1]}`);
} else {
  const ok = results.filter((r) => r.status === 200);
  const envIds = new Set(ok.map((r) => r.body?.envId));
  const maxInFlight = Math.max(0, ...ok.map((r) => Number(r.body?.inFlight ?? 0)));
  const cold = ok.filter((r) => r.body?.coldStart).length;
  const lat = ok.map((r) => r.ms);
  const pct = (p: number) => quantile(lat, p)?.toFixed(0);
  console.log(
    JSON.stringify(
      {
        requests: count,
        ok: ok.length,
        otherStatus: results.length - ok.length,
        failures: countBy(results.filter((r) => r.status !== 200)),
        distinctEnvironments: envIds.size,
        maxInFlightObserved: maxInFlight,
        coldStarts: cold,
        loadgenCoresUsed: Number(loadgenCores().toFixed(2)),
        loadgenCoresAvailable: os.availableParallelism(),
        latencyMs: { p50: pct(50), p95: pct(95), p99: pct(99) },
      },
      null,
      2,
    ),
  );
}
