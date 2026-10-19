import { describe, expect, it } from "vitest";
import {
  MIN_SAMPLES_FOR_STOP,
  countBy,
  failureKey,
  maxOf,
  parseMix,
  pickPath,
  quantile,
  runOpenLoop,
  summarizeStep,
  type Result,
} from "../scripts/loadgen-lib.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function result(over: Partial<Result> = {}): Result {
  return { status: 200, ms: 10, body: { envId: "a", coldStart: false, inFlight: 1 }, t: 0, step: 0, lateMs: 0, fromScheduleMs: 12, ...over };
}

describe("summaries", () => {
  it("quantile handles empty and small inputs", () => {
    expect(quantile([], 50)).toBeUndefined();
    expect(quantile([5], 99)).toBe(5);
    expect(quantile([1, 2, 3, 4], 50)).toBe(3);
  });

  it("labels failures by status and DB error class", () => {
    expect(failureKey(result({ status: 503, body: { code: "53400", phase: "connect" } }))).toBe("503 db:53400/connect");
    expect(failureKey(result({ status: 429, body: null }))).toBe("429");
    expect(failureKey(result({ status: 429, body: null, errorType: "Platform.EndpointRequestThrottle" }))).toBe(
      "429 Platform.EndpointRequestThrottle",
    );
    expect(failureKey(result({ status: 0, body: null, errorType: "UND_ERR_CONNECT_TIMEOUT" }))).toBe("0 UND_ERR_CONNECT_TIMEOUT");
    expect(countBy([result({ status: 0, body: null }), result({ status: 0, body: null })])).toEqual({ "0": 2 });
  });

  it("summarises a step: latency from the schedule, failures, DB stats", () => {
    const rs = [
      ...Array.from({ length: 9 }, (_, i) =>
        result({ ms: 10, fromScheduleMs: 20 + i, body: { envId: i % 2 ? "a" : "b", db: { newConnection: i < 3, acquireMs: 5, queryMs: 2 } } }),
      ),
      result({ status: 503, body: { code: "53400", phase: "connect" } }),
    ];
    const s = summarizeStep(0, 10, 1, rs, { scheduled: 10, sent: 10, dropped: 0 }, 0.5);
    expect(s.ok).toBe(9);
    expect(s.failures).toEqual({ "503 db:53400/connect": 1 });
    expect(s.latencyMs.p50).toBe(24);
    expect(s.serviceMs.p50).toBe(10);
    expect(s.environments).toBe(2);
    expect(s.db?.newConnectionPct).toBeCloseTo(33.3, 1);
    expect(s.loadgenCores).toBe(0.5);
  });
});

describe("runOpenLoop", () => {
  it("sends exactly rate x seconds requests at evenly spaced scheduled times, independent of response time", async () => {
    const scheduled: number[] = [];
    const out = await runOpenLoop({
      rates: [100],
      stepSeconds: 1,
      maxInflight: 1000,
      // Slow responses (50 ms each) must not change how many requests are offered.
      send: async (scheduledAt, step) => {
        scheduled.push(scheduledAt);
        const dispatched = performance.now();
        await sleep(50);
        return result({ step, lateMs: dispatched - scheduledAt, fromScheduleMs: performance.now() - scheduledAt });
      },
    });
    expect(scheduled).toHaveLength(100);
    for (let i = 1; i < scheduled.length; i++) expect(scheduled[i] - scheduled[i - 1]).toBeCloseTo(10, 5);
    const [step] = out.steps;
    expect(step).toMatchObject({ scheduled: 100, sent: 100, dropped: 0, completed: 100, ok: 100 });
    expect(step.lateP95Ms ?? 0).toBeLessThan(100);
    expect(out.unfinished).toBe(0);
  });

  it("drops requests beyond max-inflight and counts them", async () => {
    const out = await runOpenLoop({
      rates: [100],
      stepSeconds: 1,
      maxInflight: 5,
      send: async (_s, step) => {
        await sleep(300);
        return result({ step });
      },
    });
    const [step] = out.steps;
    expect(step.dropped).toBeGreaterThan(0);
    expect(step.sent + step.dropped).toBe(step.scheduled);
    expect(step.completed).toBe(step.sent);
  });

  it("stops the ramp after a step whose failure rate reaches the limit", async () => {
    const out = await runOpenLoop({
      rates: [60, 60, 60],
      stepSeconds: 1,
      maxInflight: 1000,
      stopOnErrorRate: 0.5,
      send: async (_s, step) => result({ step, status: 503, body: { code: "53400", phase: "connect" } }),
    });
    expect(MIN_SAMPLES_FOR_STOP).toBeLessThanOrEqual(60);
    expect(out.steps).toHaveLength(1);
    expect(out.stoppedEarly).toEqual({ afterStep: 0, errorRate: 1 });
  });

  it("runs all steps when failures stay below the limit", async () => {
    const out = await runOpenLoop({
      rates: [60, 60],
      stepSeconds: 1,
      maxInflight: 1000,
      stopOnErrorRate: 0.5,
      send: async (_s, step) => result({ step }),
    });
    expect(out.steps).toHaveLength(2);
    expect(out.stoppedEarly).toBeUndefined();
  });

  it("records a request that throws as a client-side failure", async () => {
    const out = await runOpenLoop({
      rates: [20],
      stepSeconds: 1,
      maxInflight: 100,
      send: async () => {
        throw new Error("signing failed");
      },
    });
    expect(out.steps[0].failures).toEqual({ "0": 20 });
  });
});

describe("large runs", () => {
  it("summarises a step with far more than 100,000 results without overflowing the stack", () => {
    const n = 250_000;
    const rs = Array.from({ length: n }, (_, i) => result({ body: { envId: `e${i % 7}`, inFlight: (i % 50) + 1 }, fromScheduleMs: i % 100 }));
    const s = summarizeStep(0, 1600, 90, rs, { scheduled: n, sent: n, dropped: 0 });
    expect(s.ok).toBe(n);
    expect(s.peakInFlight).toBe(50);
    expect(s.environments).toBe(7);
  });

  it("maxOf handles empty lists and a floor", () => {
    expect(maxOf([])).toBe(0);
    expect(maxOf([3, 9, 4])).toBe(9);
    expect(maxOf([-5], -10)).toBe(-5);
  });

  it("reports each finished step through onStep", async () => {
    const seen: number[] = [];
    await runOpenLoop({
      rates: [20, 20],
      stepSeconds: 1,
      maxInflight: 100,
      onStep: (s) => seen.push(s.step),
      send: async (_s, step) => result({ step }),
    });
    expect(seen).toEqual([0, 1]);
  });
});


describe("request mix", () => {
  it("parses weighted entries, with queries in the path", () => {
    expect(parseMix("/app/item:70,/app/detail?n=11:15")).toEqual([
      { path: "/app/item", weight: 70 },
      { path: "/app/detail?n=11", weight: 15 },
    ]);
  });

  it.each(["", "/app/item", "/app/item:0", "/app/item:x", "app/item:5", ":5"])("rejects %j", (spec) => {
    expect(() => parseMix(spec)).toThrow();
  });

  it("picks the same endpoint for the same (seed, step, index), whatever was dropped before", () => {
    const mix = parseMix("/a:1,/b:1,/c:1");
    const seq = (seed: string) => Array.from({ length: 50 }, (_, i) => pickPath(mix, seed, 2, i));
    expect(seq("s")).toEqual(seq("s"));
    expect(seq("s")).not.toEqual(seq("t"));
    expect(pickPath(mix, "s", 2, 7)).toBe(seq("s")[7]);
  });

  it("follows the weights", () => {
    const mix = parseMix("/item:70,/detail:15,/report:5,/render:5,/write:5");
    const n = 20_000;
    const counts: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const p = pickPath(mix, "w", 0, i);
      counts[p] = (counts[p] ?? 0) + 1;
    }
    expect(counts["/item"] / n).toBeCloseTo(0.7, 1);
    expect(counts["/detail"] / n).toBeCloseTo(0.15, 1);
    for (const p of ["/report", "/render", "/write"]) expect(counts[p] / n).toBeCloseTo(0.05, 1);
  });
});

describe("app timing and per-endpoint summaries", () => {
  const withApp = (path: string, ms: number, appMs: number, over: Record<string, unknown> = {}) =>
    result({ path, ms, fromScheduleMs: ms + 1, body: { envId: "a", build: "abc", appMs, db: { newConnection: false, acquireMs: 1, queryMs: 3, releaseMs: 0.5, queries: 2, ...over } } });

  it("splits the client's time into outside, app and DB, request by request", () => {
    const rs = [withApp("/x", 20, 8), withApp("/x", 30, 10), withApp("/x", 40, 12)];
    const s = summarizeStep(0, 10, 1, rs, { scheduled: 3, sent: 3, dropped: 0 });
    expect(s.app?.appMs.p50).toBe(10);
    expect(s.app?.outsideMs.p50).toBe(20);
    expect(s.app?.appOtherMs.p50).toBe(10 - 4.5);
    expect(s.app?.inconsistent).toBe(0);
    expect(s.app?.count).toBe(3);
  });

  it("counts responses whose app time exceeds the client's time", () => {
    const s = summarizeStep(0, 10, 1, [withApp("/x", 5, 9), withApp("/x", 20, 8)], { scheduled: 2, sent: 2, dropped: 0 });
    expect(s.app?.inconsistent).toBe(1);
  });

  it("has no breakdown when the responses carry no appMs", () => {
    expect(summarizeStep(0, 10, 1, [result()], { scheduled: 1, sent: 1, dropped: 0 }).app).toBeUndefined();
  });

  it("reports the builds seen and the pool's waiting peak", () => {
    const rs = [withApp("/x", 20, 8, { pool: { total: 10, idle: 0, waiting: 4 } }), withApp("/x", 20, 8, { pool: { total: 7, idle: 1, waiting: 0 } })];
    rs[1].body!.build = "def";
    const s = summarizeStep(0, 10, 1, rs, { scheduled: 2, sent: 2, dropped: 0 });
    expect(s.builds).toEqual(["abc", "def"]);
    expect(s.db?.poolWaitingMax).toBe(4);
    expect(s.db?.poolTotalMax).toBe(10);
    expect(s.db?.queriesPerRequest).toBe(2);
  });

  it("summarises each endpoint separately when more than one was used", () => {
    const rs = [withApp("/a", 10, 5), withApp("/a", 12, 5), withApp("/b", 100, 90), result({ path: "/b", status: 503, body: { code: "53400", phase: "connect" } })];
    const s = summarizeStep(0, 10, 1, rs, { scheduled: 4, sent: 4, dropped: 0 });
    expect(Object.keys(s.byPath!)).toEqual(["/a", "/b"]);
    expect(s.byPath!["/a"].ok).toBe(2);
    expect(s.byPath!["/b"].ok).toBe(1);
    expect(s.byPath!["/b"].failures).toEqual({ "503 db:53400/connect": 1 });
    expect(s.byPath!["/b"].serviceMs.p50).toBe(100);
    expect(summarizeStep(0, 10, 1, [withApp("/a", 10, 5)], { scheduled: 1, sent: 1, dropped: 0 }).byPath).toBeUndefined();
  });
});
