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
