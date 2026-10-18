// SigV4-signed requests to an IAM-authenticated function URL or Web Function endpoint.
// Usage: npm run invoke -- <base-url> [--path /noop] [--count 1] [--concurrency 1] [--region ap-northeast-1]
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
  },
});

const base = positionals[0];
if (!base) {
  console.error("usage: invoke <base-url> [--path /noop] [--count N] [--concurrency C] [--region R]");
  process.exit(2);
}

const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const count = Number(values.count);
const concurrency = Number(values.concurrency);
const url = new URL(values.path!, base);

// Function URLs and Web Function endpoints both sign with the service name "lambda".
const signer = new SignatureV4({
  service: "lambda",
  region: values.region!,
  credentials: defaultProvider(),
  sha256: Sha256,
});

type Result = { status: number; ms: number; body: Record<string, unknown> | null };

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
    return { status: 0, ms: performance.now() - started, body: null };
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
  return { status: res.status, ms, body };
}

const results: Result[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (next++ < count) results.push(await once());
  }),
);

if (count === 1) {
  console.log(JSON.stringify(results[0].body, null, 2));
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
