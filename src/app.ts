import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { DB_ROWS, DbError, createDbFromEnv, type Db } from "./db.js";

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

export interface AppDeps {
  /** DB access; null means this function has no database (the /db/* routes return 501). Defaults to DB_MODE & co. */
  db?: Db | null;
}

export function createApp(deps: AppDeps = {}): Hono<Env> {
  const app = new Hono<Env>();
  const db = deps.db === undefined ? createDbFromEnv() : deps.db;

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

  // Runs one statement through the configured connection mode and reports how the connection was obtained.
  const dbRoute = async (c: Context<Env>, text: string, values: unknown[] = []) => {
    if (!db) return c.json({ error: "no database configured (DB_MODE is unset)" }, 501);
    const base = info(c.get("snapshot"), c.req.header("lambda-web-request-id"));
    try {
      const { rows, trace } = await db.run(text, values);
      return c.json({ ok: true, ...base, rows: rows.length, db: trace });
    } catch (e) {
      if (!(e instanceof DbError)) throw e;
      return c.json(
        { ok: false, ...base, error: e.message, code: e.errorClass, sqlstate: e.sqlstate ?? null, phase: e.phase, db: e.trace },
        503,
      );
    }
  };

  app.get("/db/ping", (c) => dbRoute(c, "SELECT 1 AS ok"));

  // One primary-key lookup. id is 1..DB_ROWS; random when omitted.
  app.get("/db/read", (c) => {
    const raw = c.req.query("id");
    if (raw !== undefined && (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > DB_ROWS)) {
      return c.json({ error: `id must be an integer in 1..${DB_ROWS}` }, 400);
    }
    const id = raw === undefined ? 1 + Math.floor(Math.random() * DB_ROWS) : Number(raw);
    return dbRoute(c, "SELECT id, payload FROM items WHERE id = $1", [id]);
  });

  return app;
}
