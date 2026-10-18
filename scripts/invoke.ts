// SigV4-signed requests to an IAM-authenticated function URL or Web Function endpoint.
// Usage: npm run invoke -- <base-url> [--path /noop] [--count 1] [--concurrency 1] [--region ap-northeast-1]
//        [--duration SECONDS]  run for a fixed time instead of --count, and print a 10-second timeline
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    path: { type: "string", default: "/noop" },
    count: { type: "string", default: "1" },
    concurrency: { type: "string", default: "1" },
    region: { type: "string", default: "ap-northeast-1" },
    duration: { type: "string" },
  },
});

const base = positionals[0];
if (!base) {
  console.error("usage: invoke <base-url> [--path /noop] [--count N] [--concurrency C] [--region R]");
  process.exit(2);
}

const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

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

type Result = { status: number; ms: number; body: Record<string, unknown> | null; t: number };

// Failure label: HTTP status plus, where available, the platform error type or the app's DB error class/phase
// (53400 = DSQL connection rate, 53300 = DSQL connection count). Status 0 is a client-side failure.
function failureKey(r: Result): string {
  const b = r.body as { code?: string; phase?: string } | null;
  return b?.code ? `${r.status} db:${b.code}/${b.phase}` : String(r.status);
}
const countBy = (rs: Result[]) => {
  const m = new Map<string, number>();
  rs.forEach((r) => m.set(failureKey(r), (m.get(failureKey(r)) ?? 0) + 1));
  return Object.fromEntries(m);
};
const dbOf = (r: Result) => (r.body?.db ?? null) as { newConnection?: boolean; acquireMs?: number } | null;
const quantile = (xs: number[], p: number) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : undefined;
};

const runStart = performance.now();
const elapsedSec = () => (performance.now() - runStart) / 1000;

async function once(): Promise<Result> {
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
    console.error(`fetch failed: ${cause?.code ?? (e as Error).message}`);
    return { status: 0, ms: performance.now() - started, body: null, t: elapsedSec() };
  }
  const ms = performance.now() - started;
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON error body (e.g. 403/429 from the platform).
  }
  if (!res.ok) {
    console.error(`${res.status} ${res.headers.get("lambda-web-error-type") ?? ""} ${text.slice(0, 200)}`);
  }
  return { status: res.status, ms, body, t: elapsedSec() };
}

const results: Result[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (duration ? elapsedSec() < duration : next++ < count) results.push(await once());
  }),
);

if (count === 1) {
  console.log(JSON.stringify(results[0].body, null, 2));
} else if (duration) {
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
    const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
    const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))]?.toFixed(0) ?? "-";
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
  console.log(`environments: ${perEnv.size}, per-environment peak concurrency: min ${peaks[0]}, median ${peaks[Math.floor(peaks.length / 2)]}, max ${peaks[peaks.length - 1]}`);
} else {
  const ok = results.filter((r) => r.status === 200);
  const envIds = new Set(ok.map((r) => r.body?.envId));
  const maxInFlight = Math.max(0, ...ok.map((r) => Number(r.body?.inFlight ?? 0)));
  const cold = ok.filter((r) => r.body?.coldStart).length;
  const sorted = ok.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]?.toFixed(0);
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
        latencyMs: { p50: pct(50), p95: pct(95), p99: pct(99) },
      },
      null,
      2,
    ),
  );
}
