import { describe, expect, it } from "vitest";
import {
  MIN_SAMPLES_FOR_STOP,
  countBy,
  failureKey,
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
