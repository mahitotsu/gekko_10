import { randomUUID } from "node:crypto";
import { Hono } from "hono";

const MAX_WAIT_MS = 25_000;

const variant = process.env.APP_VARIANT ?? "local";
const envId = randomUUID();
const envStartedAt = new Date().toISOString();
const startedAtMs = Date.now();

let requestCount = 0;
let inFlight = 0;
let maxInFlight = 0;

type Snapshot = { coldStart: boolean; requestCount: number; inFlight: number };
type Env = { Variables: { snapshot: Snapshot } };

export function createApp(): Hono<Env> {
  const app = new Hono<Env>();

  // Counters are updated before the handler runs and released in finally,
  // so inFlight and requestCount include the current request.
  app.use("*", async (c, next) => {
    requestCount += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    c.set("snapshot", { coldStart: requestCount === 1, requestCount, inFlight });
    try {
      await next();
    } finally {
      inFlight -= 1;
    }
  });

  const info = (snap: Snapshot, requestId: string | undefined) => ({
    variant,
    envId,
    envStartedAt,
    uptimeMs: Date.now() - startedAtMs,
    coldStart: snap.coldStart,
    requestCount: snap.requestCount,
    inFlight: snap.inFlight,
    maxInFlight,
    requestId: requestId ?? null,
  });

  app.get("/noop", (c) =>
    c.json({ ok: true, ...info(c.get("snapshot"), c.req.header("lambda-web-request-id")) }),
  );

  app.get("/wait", async (c) => {
    const raw = c.req.query("ms");
    if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) > MAX_WAIT_MS) {
      return c.json({ error: `ms must be an integer in 0..${MAX_WAIT_MS}` }, 400);
    }
    const ms = Number(raw);
    const snapshot = c.get("snapshot");
    const requestId = c.req.header("lambda-web-request-id");
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    // inFlight/requestCount are as of arrival; maxInFlight and uptimeMs are as of completion.
    return c.json({ ok: true, ...info(snapshot, requestId), waitedMs: ms });
  });

  return app;
}
