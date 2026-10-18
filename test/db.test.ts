import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import {
  DbError,
  LOG_FULL_ERRORS_PER_MINUTE,
  classifyDbError,
  createDb,
  createDbFromEnv,
  type ClientLike,
  type ConnectionFactories,
  type PoolClientLike,
  type PoolLike,
} from "../src/db.js";

afterEach(() => vi.restoreAllMocks());

function pgError(message: string, code?: string) {
  return Object.assign(new Error(message), { code });
}

class FakeClient implements ClientLike {
  static instances: FakeClient[] = [];
  static connectError: Error | null = null;
  static queryError: Error | null = null;
  listeners: Record<string, (() => void)[]> = {};
  ended = false;
  queries = 0;
  constructor() {
    FakeClient.instances.push(this);
  }
  async connect() {
    if (FakeClient.connectError) throw FakeClient.connectError;
  }
  async query() {
    this.queries += 1;
    if (FakeClient.queryError) throw FakeClient.queryError;
    return { rows: [{ ok: 1 }] };
  }
  async end() {
    this.ended = true;
    this.listeners.end?.forEach((l) => l());
  }
  on(event: string, l: () => void) {
    (this.listeners[event] ??= []).push(l);
  }
  emit(event: string) {
    this.listeners[event]?.forEach((l) => l());
  }
}

class FakePool implements PoolLike {
  handlers: Record<string, ((...a: any[]) => void)[]> = {};
  clients: (PoolClientLike & { released: (boolean | Error | undefined)[] })[] = [];
  idle: typeof this.clients = [];
  connectError: Error | null = null;
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
  constructor(readonly max: number) {}
  on(event: string, l: (...a: any[]) => void) {
    (this.handlers[event] ??= []).push(l);
  }
  async connect() {
    if (this.connectError) throw this.connectError;
    let c = this.idle.pop();
    if (!c) {
      const released: (boolean | Error | undefined)[] = [];
      const self = this;
      c = {
        released,
        query: async () => ({ rows: [{ ok: 1 }] }),
        release(destroy) {
          released.push(destroy);
          if (!destroy) self.idle.push(c!);
        },
      };
      this.clients.push(c);
      this.totalCount += 1;
      this.handlers.connect?.forEach((h) => h(c));
    }
    return c;
  }
}

function setup() {
  FakeClient.instances = [];
  FakeClient.connectError = null;
  FakeClient.queryError = null;
  let pool!: FakePool;
  const factories: ConnectionFactories = {
    client: () => new FakeClient(),
    pool: (_h, max) => (pool = new FakePool(max)),
  };
  return { factories, getPool: () => pool };
}

describe("classifyDbError", () => {
  it.each([
    [pgError("x", "53400"), "53400"],
    [pgError("Unable to accept connection, rate exceeded."), "53400"],
    [pgError("x", "53300"), "53300"],
    [pgError("Unable to accept connection, too many open connections."), "53300"],
    [pgError("boom", "XX000"), "other"],
    [new Error("timeout"), "other"],
  ])("%s -> %s", (err, expected) => {
    expect(classifyDbError(err)).toBe(expected);
  });
});

describe("each", () => {
  it("opens and closes a connection per request", async () => {
    const { factories } = setup();
    const db = createDb({ mode: "each", host: "h", factories });
    const a = await db.run("SELECT 1");
    const b = await db.run("SELECT 1");
    expect(FakeClient.instances).toHaveLength(2);
    expect(FakeClient.instances.every((c) => c.ended)).toBe(true);
    expect(a.trace.newConnection).toBe(true);
    expect(b.trace.envConnectionsCreated).toBe(2);
  });

  it("counts connect errors by class, logs them, and does not count query errors", async () => {
    const { factories } = setup();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const db = createDb({ mode: "each", host: "h", factories });
    FakeClient.connectError = pgError("Unable to accept connection, rate exceeded.", "53400");
    await expect(db.run("SELECT 1")).rejects.toMatchObject({ errorClass: "53400", phase: "connect" });
    FakeClient.connectError = pgError("Unable to accept connection, too many open connections.", "53300");
    await expect(db.run("SELECT 1")).rejects.toMatchObject({ errorClass: "53300", phase: "connect" });
    FakeClient.connectError = null;
    FakeClient.queryError = pgError("bad", "42601");
    const err = (await db.run("SELECT 1").catch((e) => e)) as DbError;
    expect(err.phase).toBe("query");
    expect(err.trace.envConnectErrors).toEqual({ "53400": 1, "53300": 1, other: 0 });
    expect(log).toHaveBeenCalledTimes(3);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({ event: "db_error", class: "53400", phase: "connect" });
  });
});

describe("error logging", () => {
  it("logs the first errors of each minute in full, counts the rest, and reports the count in the next window", async () => {
    const { factories } = setup();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let clock = 1_000_000;
    const db = createDb({ mode: "each", host: "h", factories, now: () => clock });
    FakeClient.connectError = pgError("rate exceeded", "53400");
    const total = LOG_FULL_ERRORS_PER_MINUTE + 15;
    for (let i = 0; i < total; i++) await db.run("SELECT 1").catch(() => {});
    expect(log).toHaveBeenCalledTimes(LOG_FULL_ERRORS_PER_MINUTE);

    // The next minute starts with a summary of what was left out, then logs in full again.
    clock += 61_000;
    const err = (await db.run("SELECT 1").catch((e) => e)) as DbError;
    const lines = log.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(lines[LOG_FULL_ERRORS_PER_MINUTE]).toEqual({ event: "db_error_suppressed", mode: "each", count: 15 });
    expect(lines[LOG_FULL_ERRORS_PER_MINUTE + 1]).toMatchObject({ event: "db_error", class: "53400" });
    // Counting is not sampled: every failure is in the counters.
    expect(err.trace.envConnectErrors["53400"]).toBe(total + 1);
  });
});

describe("reuse", () => {
  it("connects once and reuses the connection", async () => {
    const { factories } = setup();
    const db = createDb({ mode: "reuse", host: "h", factories });
    const a = await db.run("SELECT 1");
    const b = await db.run("SELECT 1");
    expect(FakeClient.instances).toHaveLength(1);
    expect(a.trace.newConnection).toBe(true);
    expect(b.trace.newConnection).toBe(false);
    expect(b.trace.connectionAgeMs).toBeGreaterThanOrEqual(0);
  });

  it("reconnects on the next request after the server closes the connection", async () => {
    const { factories } = setup();
    const db = createDb({ mode: "reuse", host: "h", factories });
    await db.run("SELECT 1");
    FakeClient.instances[0].emit("error");
    const b = await db.run("SELECT 1");
    expect(FakeClient.instances).toHaveLength(2);
    expect(b.trace.newConnection).toBe(true);
    expect(b.trace.reconnected).toBeUndefined();
  });

  it("retries once on a dead connection that was not reported", async () => {
    const { factories } = setup();
    const db = createDb({ mode: "reuse", host: "h", factories });
    await db.run("SELECT 1");
    FakeClient.queryError = new Error("Connection terminated unexpectedly");
    const original = FakeClient.instances[0];
    const q = original.query.bind(original);
    original.query = async (...a) => {
      try {
        return await q(...(a as []));
      } finally {
        FakeClient.queryError = null;
      }
    };
    const b = await db.run("SELECT 1");
    expect(b.trace).toMatchObject({ reconnected: true, newConnection: true });
    expect(FakeClient.instances).toHaveLength(2);
    expect(original.ended).toBe(true);
  });

  it("does not retry a statement error", async () => {
    const { factories } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = createDb({ mode: "reuse", host: "h", factories });
    await db.run("SELECT 1");
    FakeClient.queryError = pgError("syntax", "42601");
    await expect(db.run("SELECT 1")).rejects.toMatchObject({ phase: "query" });
    expect(FakeClient.instances).toHaveLength(1);
  });
});

describe("pool", () => {
  it("creates the pool lazily with the configured max and shares connections", async () => {
    const { factories, getPool } = setup();
    const db = createDb({ mode: "pool", host: "h", poolMax: 7, factories });
    expect(getPool()).toBeUndefined();
    const a = await db.run("SELECT 1");
    const b = await db.run("SELECT 1");
    expect(getPool().max).toBe(7);
    expect(getPool().clients).toHaveLength(1);
    expect(a.trace.newConnection).toBe(true);
    expect(b.trace.newConnection).toBe(false);
    expect(b.trace.pool).toEqual({ total: 1, idle: 0, waiting: 0 });
    expect(b.trace.envConnectionsCreated).toBe(1);
  });

  it("destroys a connection that failed at the connection level", async () => {
    const { factories, getPool } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = createDb({ mode: "pool", host: "h", factories });
    await db.run("SELECT 1");
    getPool().clients[0].query = async () => {
      throw new Error("Connection terminated unexpectedly");
    };
    await expect(db.run("SELECT 1")).rejects.toMatchObject({ phase: "query" });
    expect(getPool().clients[0].released).toEqual([undefined, true]);
  });

  it("classifies pool.connect failures", async () => {
    const { factories, getPool } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = createDb({ mode: "pool", host: "h", factories });
    await db.run("SELECT 1");
    getPool().connectError = pgError("rate exceeded", "53400");
    const err = (await db.run("SELECT 1").catch((e) => e)) as DbError;
    expect(err).toMatchObject({ errorClass: "53400", phase: "connect" });
    expect(err.trace.envConnectErrors["53400"]).toBe(1);
  });

  it("registers an error listener on the pool", async () => {
    const { factories, getPool } = setup();
    const db = createDb({ mode: "pool", host: "h", factories });
    await db.run("SELECT 1");
    expect(getPool().handlers.error).toHaveLength(1);
  });
});

describe("createDbFromEnv", () => {
  it("returns null without DB_MODE", () => {
    expect(createDbFromEnv({})).toBeNull();
  });
  it("validates the settings", () => {
    expect(() => createDbFromEnv({ DB_MODE: "x", DSQL_ENDPOINT: "h" })).toThrow(/DB_MODE/);
    expect(() => createDbFromEnv({ DB_MODE: "pool" })).toThrow(/DSQL_ENDPOINT/);
    expect(() => createDbFromEnv({ DB_MODE: "pool", DSQL_ENDPOINT: "h", DB_POOL_MAX: "0" })).toThrow(/DB_POOL_MAX/);
    expect(createDbFromEnv({ DB_MODE: "pool", DSQL_ENDPOINT: "h", DB_POOL_MAX: "16" })?.mode).toBe("pool");
  });
});

describe("/db routes", () => {
  it("return 501 when no database is configured", async () => {
    const app = createApp({ db: null });
    for (const path of ["/db/ping", "/db/read"]) expect((await app.request(path)).status).toBe(501);
  });

  it("returns env info and the connection trace", async () => {
    const { factories } = setup();
    const app = createApp({ db: createDb({ mode: "pool", host: "h", factories }) });
    const res = await app.request("/db/read?id=5");
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, rows: 1, db: { mode: "pool", newConnection: true } });
    expect(body.envId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each(["/db/read?id=0", "/db/read?id=1001", "/db/read?id=abc"])("%s is rejected with 400", async (path) => {
    const { factories } = setup();
    const app = createApp({ db: createDb({ mode: "each", host: "h", factories }) });
    expect((await app.request(path)).status).toBe(400);
  });

  it("returns 503 with the error class and phase when the connection fails", async () => {
    const { factories } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    FakeClient.connectError = pgError("rate exceeded", "53400");
    const app = createApp({ db: createDb({ mode: "each", host: "h", factories }) });
    const res = await app.request("/db/ping");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: "53400", phase: "connect", db: { envConnectErrors: { "53400": 1 } } });
  });
});
