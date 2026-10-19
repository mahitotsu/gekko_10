import { AuroraDSQLClient, AuroraDSQLPool } from "@aws/aurora-dsql-node-postgres-connector";

// All three modes use the same connector; they differ only in how connections are held.
//   each:  a new client per request (connect, query, end)
//   reuse: one client per environment, reused across requests (Event Functions)
//   pool:  one AuroraDSQLPool per environment, shared by concurrent requests (Web Functions)
export type DbMode = "each" | "reuse" | "pool";
export type DbPhase = "connect" | "query";
/** "53400" = connection rate exceeded, "53300" = too many connections, anything else is "other". */
export type ErrorClass = "53400" | "53300" | "other";

export const DB_ROWS = 1000;
// DSQL closes connections after 60 minutes; retire ours a little earlier (same value as the connector's default).
const MAX_CONNECTION_AGE_MS = 3300 * 1000;
const POOL_IDLE_TIMEOUT_MS = 60_000;
/**
 * Error log lines per environment per minute that carry the full detail. When the DSQL connection rate is exceeded, a
 * load test can fail hundreds of thousands of requests; the rest are only counted (see `envConnectErrors` in the
 * response and `db_error_suppressed`), which keeps the log volume (and its cost) bounded.
 */
export const LOG_FULL_ERRORS_PER_MINUTE = 20;
const CONNECT_TIMEOUT_MS = 5000;

export interface DbTrace {
  mode: DbMode;
  /** True if this request created the connection it used. For pool this is "first use of a pooled connection". */
  newConnection: boolean;
  /** reuse only: the shared connection was dead, so this request reconnected and retried once. */
  reconnected?: boolean;
  /** Time until a connection was ready: connect (each), connect or 0 (reuse), pool.connect() (pool). */
  acquireMs: number;
  queryMs: number;
  /** Statements run on behalf of one request. Set when traces of several runs are merged (src/scenarios.ts). */
  queries?: number;
  /** Longest single statement, same condition as `queries`. */
  queryMaxMs?: number;
  /** end() for each, release() for pool, 0 for reuse. */
  releaseMs: number;
  connectionAgeMs?: number;
  pool?: { total: number; idle: number; waiting: number };
  envConnectionsCreated: number;
  envConnectErrors: Record<ErrorClass, number>;
}

export class DbError extends Error {
  constructor(
    message: string,
    readonly errorClass: ErrorClass,
    readonly phase: DbPhase,
    readonly sqlstate: string | undefined,
    readonly trace: Pick<DbTrace, "mode" | "envConnectionsCreated" | "envConnectErrors">,
  ) {
    super(message);
  }
}

export interface Db {
  readonly mode: DbMode;
  run(text: string, values?: unknown[]): Promise<{ rows: unknown[]; trace: DbTrace }>;
}

// Minimal shapes of the pg objects we use, so tests can substitute fakes.
export interface ClientLike {
  connect(): Promise<unknown>;
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
  on(event: "error" | "end", listener: (...args: any[]) => void): unknown;
}
export interface PoolClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  release(destroy?: boolean | Error): void;
}
export interface PoolLike {
  connect(): Promise<PoolClientLike>;
  on(event: "error" | "connect", listener: (...args: any[]) => void): unknown;
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}
export interface ConnectionFactories {
  client(host: string): ClientLike;
  pool(host: string, max: number): PoolLike;
}

const defaultFactories: ConnectionFactories = {
  // user defaults to "admin" and credentials to the default provider chain inside the connector.
  client: (host) => new AuroraDSQLClient({ host, connectionTimeoutMillis: CONNECT_TIMEOUT_MS }) as unknown as ClientLike,
  pool: (host, max) =>
    new AuroraDSQLPool({
      host,
      max,
      idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
      maxLifetimeSeconds: MAX_CONNECTION_AGE_MS / 1000,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    }) as unknown as PoolLike,
};

type PgError = Error & { code?: string };

export function classifyDbError(e: unknown): ErrorClass {
  const err = e as PgError;
  const message = err?.message ?? "";
  // The DSQL docs list the SQLSTATEs and messages; we check both because the SQLSTATE on the wire is unconfirmed.
  if (err?.code === "53400" || /rate exceeded/i.test(message)) return "53400";
  if (err?.code === "53300" || /too many open connections/i.test(message)) return "53300";
  return "other";
}

/** A broken connection (as opposed to an error the server returned for the statement). */
function isConnectionLevelError(e: unknown): boolean {
  const err = e as PgError;
  if (classifyDbError(e) !== "other") return false;
  if (!err?.code || /^E[A-Z_]+$/.test(err.code)) return true;
  return /terminated|closed|ECONNRESET/i.test(err.message ?? "");
}

const ms = (since: number) => performance.now() - since;

export function createDb(opts: {
  mode: DbMode;
  host: string;
  poolMax?: number;
  factories?: ConnectionFactories;
  /** Clock for the error-log window; tests inject their own. */
  now?: () => number;
}): Db {
  const { mode, host } = opts;
  const factories = opts.factories ?? defaultFactories;
  const poolMax = opts.poolMax ?? 64;
  const now = opts.now ?? Date.now;

  let logWindowStart = Number.NEGATIVE_INFINITY;
  let logged = 0;
  let suppressed = 0;
  function logError(entry: Record<string, unknown>) {
    const t = now();
    if (t - logWindowStart >= 60_000) {
      if (suppressed > 0) console.log(JSON.stringify({ event: "db_error_suppressed", mode, count: suppressed }));
      logWindowStart = t;
      logged = 0;
      suppressed = 0;
    }
    if (logged < LOG_FULL_ERRORS_PER_MINUTE) {
      logged += 1;
      console.log(JSON.stringify(entry));
    } else {
      suppressed += 1;
    }
  }

  let connectionsCreated = 0;
  const connectErrors: Record<ErrorClass, number> = { "53400": 0, "53300": 0, other: 0 };
  const counters = () => ({
    mode,
    envConnectionsCreated: connectionsCreated,
    envConnectErrors: { ...connectErrors },
  });

  function fail(e: unknown, phase: DbPhase): DbError {
    const errorClass = classifyDbError(e);
    if (phase === "connect") connectErrors[errorClass] += 1;
    const err = e as PgError;
    const dbError = new DbError(err?.message ?? String(e), errorClass, phase, err?.code, counters());
    // Successful requests are not logged, and failures are sampled (LOG_FULL_ERRORS_PER_MINUTE), to keep the log volume down.
    logError({ event: "db_error", mode, phase, class: errorClass, sqlstate: err?.code ?? null, message: dbError.message });
    return dbError;
  }

  const base = (): DbTrace => ({
    ...counters(),
    newConnection: false,
    acquireMs: 0,
    queryMs: 0,
    releaseMs: 0,
  });

  async function runEach(text: string, values?: unknown[]) {
    const trace = base();
    const client = factories.client(host);
    // An 'error' event with no listener would crash the process.
    client.on("error", () => {});
    let t = performance.now();
    try {
      await client.connect();
    } catch (e) {
      client.end().catch(() => {});
      throw fail(e, "connect");
    }
    connectionsCreated += 1;
    trace.newConnection = true;
    trace.acquireMs = ms(t);
    let result: { rows: unknown[] };
    t = performance.now();
    try {
      result = await client.query(text, values);
      trace.queryMs = ms(t);
    } catch (e) {
      client.end().catch(() => {});
      throw fail(e, "query");
    }
    t = performance.now();
    await client.end().catch(() => {});
    trace.releaseMs = ms(t);
    return { rows: result.rows, trace: { ...trace, ...counters() } };
  }

  // reuse: one shared client. Event Functions handle one request at a time per environment,
  // but the connect is guarded anyway so that two callers never open two connections.
  let shared: { client: ClientLike; createdAt: number } | null = null;
  let connecting: Promise<{ client: ClientLike; createdAt: number }> | null = null;

  function drop(client: ClientLike) {
    if (shared?.client === client) shared = null;
    client.end().catch(() => {});
  }

  async function openShared() {
    const client = factories.client(host);
    const entry = { client, createdAt: Date.now() };
    // A server-side close (e.g. the 60 minute limit, or a frozen environment resuming) invalidates the shared client.
    client.on("error", () => {
      if (shared?.client === client) shared = null;
    });
    client.on("end", () => {
      if (shared?.client === client) shared = null;
    });
    try {
      await client.connect();
    } catch (e) {
      client.end().catch(() => {});
      throw fail(e, "connect");
    }
    connectionsCreated += 1;
    shared = entry;
    return entry;
  }

  async function getShared(): Promise<{ entry: { client: ClientLike; createdAt: number }; created: boolean }> {
    if (shared && Date.now() - shared.createdAt >= MAX_CONNECTION_AGE_MS) drop(shared.client);
    if (shared) return { entry: shared, created: false };
    if (!connecting) connecting = openShared().finally(() => (connecting = null));
    return { entry: await connecting, created: true };
  }

  async function runReuse(text: string, values?: unknown[]) {
    const trace = base();
    let t = performance.now();
    let { entry, created } = await getShared();
    trace.acquireMs = ms(t);
    trace.newConnection = created;
    t = performance.now();
    try {
      const result = await entry.client.query(text, values);
      trace.queryMs = ms(t);
      trace.connectionAgeMs = Date.now() - entry.createdAt;
      return { rows: result.rows, trace: { ...trace, ...counters() } };
    } catch (e) {
      // Retry once on a dead reused connection. A connection created for this very request is not retried.
      if (created || !isConnectionLevelError(e)) throw fail(e, "query");
      drop(entry.client);
    }
    t = performance.now();
    ({ entry, created } = await getShared());
    trace.acquireMs += ms(t);
    trace.newConnection = true;
    trace.reconnected = true;
    t = performance.now();
    try {
      const result = await entry.client.query(text, values);
      trace.queryMs = ms(t);
      trace.connectionAgeMs = Date.now() - entry.createdAt;
      return { rows: result.rows, trace: { ...trace, ...counters() } };
    } catch (e) {
      throw fail(e, "query");
    }
  }

  // pool: created on first use so that environments that never touch the DB do not pay for it.
  let pool: PoolLike | null = null;
  const poolClients = new WeakMap<object, { createdAt: number; uses: number }>();

  function getPool(): PoolLike {
    if (pool) return pool;
    const p = factories.pool(host, poolMax);
    // Without an 'error' listener, an error on an idle connection would crash the process.
    p.on("error", (e: Error) => console.log(JSON.stringify({ event: "db_pool_error", message: e.message })));
    p.on("connect", (c: object) => {
      connectionsCreated += 1;
      poolClients.set(c, { createdAt: Date.now(), uses: 0 });
    });
    return (pool = p);
  }

  async function runPool(text: string, values?: unknown[]) {
    const trace = base();
    const p = getPool();
    let t = performance.now();
    let client: PoolClientLike;
    try {
      client = await p.connect();
    } catch (e) {
      throw fail(e, "connect");
    }
    trace.acquireMs = ms(t);
    const meta = poolClients.get(client) ?? { createdAt: Date.now(), uses: 0 };
    trace.newConnection = meta.uses === 0;
    meta.uses += 1;
    trace.connectionAgeMs = Date.now() - meta.createdAt;
    t = performance.now();
    let result: { rows: unknown[] };
    try {
      result = await client.query(text, values);
      trace.queryMs = ms(t);
    } catch (e) {
      client.release(isConnectionLevelError(e) ? true : undefined);
      throw fail(e, "query");
    }
    t = performance.now();
    client.release();
    trace.releaseMs = ms(t);
    trace.pool = { total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount };
    return { rows: result.rows, trace: { ...trace, ...counters() } };
  }

  const run = { each: runEach, reuse: runReuse, pool: runPool }[mode];
  return { mode, run };
}

/** Builds the Db from DB_MODE / DSQL_ENDPOINT / DB_POOL_MAX. Returns null when DB_MODE is unset (the noop functions). */
export function createDbFromEnv(env: NodeJS.ProcessEnv = process.env): Db | null {
  const mode = env.DB_MODE;
  if (!mode) return null;
  if (mode !== "each" && mode !== "reuse" && mode !== "pool") throw new Error(`invalid DB_MODE: ${mode}`);
  const host = env.DSQL_ENDPOINT;
  if (!host) throw new Error("DSQL_ENDPOINT is required when DB_MODE is set");
  const poolMax = env.DB_POOL_MAX ? Number(env.DB_POOL_MAX) : undefined;
  if (poolMax !== undefined && (!Number.isInteger(poolMax) || poolMax < 1)) throw new Error(`invalid DB_POOL_MAX: ${env.DB_POOL_MAX}`);
  return createDb({ mode, host, poolMax });
}
