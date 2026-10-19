import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const app = createApp();
const get = async (path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

describe("app", () => {
  it("GET /noop returns env info", async () => {
    const { status, body } = await get("/noop");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.envId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.inFlight).toBe(1);
    expect(body.requestCount).toBeGreaterThanOrEqual(1);
  });

  it("GET /wait waits and reports waitedMs", async () => {
    const t = Date.now();
    const { status, body } = await get("/wait?ms=100");
    expect(status).toBe(200);
    expect(body.waitedMs).toBe(100);
    expect(Date.now() - t).toBeGreaterThanOrEqual(95);
  });

  it.each(["/wait", "/wait?ms=-1", "/wait?ms=abc", "/wait?ms=1.5", "/wait?ms=25001"])(
    "GET %s is rejected with 400",
    async (path) => {
      expect((await get(path)).status).toBe(400);
    },
  );

  it("tracks concurrent requests and releases the counter", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => get("/wait?ms=100")));
    const peak = Math.max(...results.map((r) => r.body.inFlight));
    expect(peak).toBe(10);
    const after = await get("/noop");
    expect(after.body.inFlight).toBe(1);
    expect(after.body.maxInFlight).toBeGreaterThanOrEqual(10);
  });

  it("only the first request is a cold start", async () => {
    const { body } = await get("/noop");
    expect(body.coldStart).toBe(false);
  });
});

describe("/app scenarios", () => {
  const trace = (over: Record<string, unknown> = {}) => ({
    mode: "pool" as const,
    newConnection: false,
    acquireMs: 1,
    queryMs: 2,
    releaseMs: 0.5,
    envConnectionsCreated: 1,
    envConnectErrors: { "53400": 0, "53300": 0, other: 0 },
    ...over,
  });
  const calls: { text: string; values?: unknown[] }[] = [];
  const fakeDb = {
    mode: "pool" as const,
    run: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return { rows: text.startsWith("INSERT") ? [] : [{ id: 1, payload: "x" }], trace: trace({ queryMs: calls.length }) };
    },
  };
  const slept: number[] = [];
  const dbApp = createApp({ db: fakeDb, sleep: async (ms) => void slept.push(ms) });
  const getFrom = async (path: string) => {
    calls.length = 0;
    const res = await dbApp.request(path);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  it("reports the handler time, the build and the boot time in every response", async () => {
    const { body } = await getFrom("/app/item");
    expect(body.appMs).toBeGreaterThanOrEqual(0);
    expect(body.build).toBe("dev");
    expect(body.bootMs).toBeGreaterThan(0);
    expect((await get("/noop")).body.appMs).toBeGreaterThanOrEqual(0);
  });

  it("item runs one statement", async () => {
    const { status, body } = await getFrom("/app/item");
    expect(status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(body.db.queries).toBe(1);
  });

  it("detail runs n statements in sequence and sums their times", async () => {
    const { body } = await getFrom("/app/detail?n=5");
    expect(calls).toHaveLength(5);
    expect(body.n).toBe(5);
    expect(body.db.queries).toBe(5);
    expect(body.db.queryMs).toBe(1 + 2 + 3 + 4 + 5);
    expect(body.db.queryMaxMs).toBe(5);
    expect(body.db.acquireMs).toBe(5);
  });

  it("detail defaults to 11 statements", async () => {
    await getFrom("/app/detail");
    expect(calls).toHaveLength(11);
  });

  it("report runs one aggregate over k rows", async () => {
    const { body } = await getFrom("/app/report?k=50");
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("CROSS JOIN");
    expect(calls[0].values).toEqual([50]);
    expect(body.k).toBe(50);
  });

  it("render does a fixed amount of CPU work after one lookup", async () => {
    const a = await getFrom("/app/render?w=100");
    const b = await getFrom("/app/render?w=100");
    expect(calls).toHaveLength(1);
    expect(a.body.w).toBe(100);
    expect(a.body.digest).toBe(b.body.digest);
    expect((await getFrom("/app/render?w=0")).body.digest).not.toBe(a.body.digest);
  });

  it("write inserts one row with a fresh UUID", async () => {
    await getFrom("/app/write");
    const first = calls[0].values![0];
    await getFrom("/app/write");
    expect(calls[0].text).toMatch(/^INSERT INTO events/);
    expect(calls[0].values![0]).not.toBe(first);
  });

  it("external reads, waits, then writes", async () => {
    slept.length = 0;
    const { body } = await getFrom("/app/external?ms=700");
    expect(calls.map((c) => c.text.split(" ")[0])).toEqual(["SELECT", "INSERT"]);
    expect(slept).toEqual([700]);
    expect(body.waitedMs).toBe(700);
    expect(body.db.queries).toBe(2);
  });

  it.each(["/app/detail?n=0", "/app/detail?n=101", "/app/report?k=abc", "/app/render?w=-1", "/app/external?ms=25001"])("%s is rejected with 400 before touching the DB", async (path) => {
    const { status } = await getFrom(path);
    expect(status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("unknown scenarios are 404, and a function without a database answers 501", async () => {
    expect((await getFrom("/app/nope")).status).toBe(404);
    expect((await get("/app/item")).status).toBe(501);
  });
});
