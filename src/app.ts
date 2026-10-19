import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { DB_ROWS, DbError, createDbFromEnv, type Db } from "./db.js";
import { ParamError, mergeTraces, scenarios, type ScenarioDeps } from "./scenarios.js";

/** Set by scripts/bundle.mjs (the last commit that touched the code, "-dirty" if it has uncommitted changes). */
declare const __BUILD_ID__: string | undefined;
const build = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";
/** Time from process start to this module being evaluated: the part of start-up that belongs to the app. */
const bootMs = Math.round(performance.now());

const MAX_WAIT_MS = 25_000;

const variant = process.env.APP_VARIANT ?? "local";
const envId = randomUUID();
const envStartedAt = new Date().toISOString();
const startedAtMs = Date.now();

let requestCount = 0;
let inFlight = 0;
let maxInFlight = 0;

type Snapshot = { coldStart: boolean; requestCount: number; inFlight: number; t0: number };
type Env = { Variables: { snapshot: Snapshot } };

export interface AppDeps {
  /** DB access; null means this function has no database (the /db/* routes return 501). Defaults to DB_MODE & co. */
  db?: Db | null;
  /** Wait used by /app/external; tests inject a fake. */
  sleep?: ScenarioDeps["sleep"];
}

export function createApp(deps: AppDeps = {}): Hono<Env> {
  const app = new Hono<Env>();
  const db = deps.db === undefined ? createDbFromEnv() : deps.db;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // Counters are updated before the handler runs and released in finally,
  // so inFlight and requestCount include the current request.
  app.use("*", async (c, next) => {
    requestCount += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    c.set("snapshot", { coldStart: requestCount === 1, requestCount, inFlight, t0: performance.now() });
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
    build,
    bootMs,
  });
  /** Time spent in the handler, taken when the response is built (the client's time minus this is what happens outside the app). */
  const appMs = (snap: Snapshot) => Number((performance.now() - snap.t0).toFixed(2));

  app.get("/noop", (c) =>
    c.json({ ok: true, ...info(c.get("snapshot"), c.req.header("lambda-web-request-id")), appMs: appMs(c.get("snapshot")) }),
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
    return c.json({ ok: true, ...info(snapshot, requestId), waitedMs: ms, appMs: appMs(snapshot) });
  });

  // Runs the work through the configured connection mode and reports how the connections were obtained.
  const dbRoute = async (
    c: Context<Env>,
    work: (db: Db) => Promise<{ traces: Parameters<typeof mergeTraces>[0]; rows: number; extra?: Record<string, unknown> }>,
  ) => {
    if (!db) return c.json({ error: "no database configured (DB_MODE is unset)" }, 501);
    const snap = c.get("snapshot");
    const base = info(snap, c.req.header("lambda-web-request-id"));
    try {
      const { traces, rows, extra } = await work(db);
      return c.json({ ok: true, ...base, ...extra, rows, db: mergeTraces(traces), appMs: appMs(snap) });
    } catch (e) {
      if (e instanceof ParamError) return c.json({ error: e.message }, 400);
      if (!(e instanceof DbError)) throw e;
      return c.json(
        { ok: false, ...base, error: e.message, code: e.errorClass, sqlstate: e.sqlstate ?? null, phase: e.phase, db: e.trace, appMs: appMs(snap) },
        503,
      );
    }
  };
  const single = (text: string, values: unknown[] = []) => async (d: Db) => {
    const { rows, trace } = await d.run(text, values);
    return { traces: [trace], rows: rows.length };
  };

  app.get("/db/ping", (c) => dbRoute(c, single("SELECT 1 AS ok")));

  // One primary-key lookup. id is 1..DB_ROWS; random when omitted.
  app.get("/db/read", (c) => {
    const raw = c.req.query("id");
    if (raw !== undefined && (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > DB_ROWS)) {
      return c.json({ error: `id must be an integer in 1..${DB_ROWS}` }, 400);
    }
    const id = raw === undefined ? 1 + Math.floor(Math.random() * DB_ROWS) : Number(raw);
    return dbRoute(c, single("SELECT id, payload FROM items WHERE id = $1", [id]));
  });

  // Application-shaped requests (src/scenarios.ts): /app/item, /app/detail, /app/report, /app/render, /app/write, /app/external.
  app.get("/app/:scenario", (c) => {
    const scenario = scenarios[c.req.param("scenario")];
    if (!scenario) return c.json({ error: "unknown scenario" }, 404);
    return dbRoute(c, (d) => scenario(d, (name) => c.req.query(name), { sleep }));
  });

  return app;
}
