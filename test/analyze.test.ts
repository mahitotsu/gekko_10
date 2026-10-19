import { describe, expect, it } from "vitest";
import { allocate, dsqlCutoff, eventCost, judge, maxIn, PRICE, webCost, webMemoryGbSeconds, type ManifestRow, type RunResult } from "../scripts/analyze.js";

const MIN = 60_000;
const T = Date.parse("2026-10-19T00:00:00Z");
const pts = (...vs: number[]) => vs.map((v, i) => ({ t: T + i * MIN, v }));

describe("allocate", () => {
  it("counts whole minutes inside the window", () => {
    expect(allocate(pts(10, 20, 30), T, T + 3 * MIN)).toBe(60);
  });
  it("weights partial overlap by the share of the minute", () => {
    expect(allocate(pts(60), T + 15_000, T + 45_000)).toBe(30);
    expect(allocate(pts(60, 60), T + 30_000, T + 90_000)).toBe(60);
  });
  it("ignores minutes outside the window", () => {
    expect(allocate(pts(10, 20, 30), T + MIN, T + 2 * MIN)).toBe(20);
    expect(allocate(pts(10), T + MIN, T + 2 * MIN)).toBe(0);
  });
});

describe("maxIn", () => {
  it("takes the maximum of overlapping samples only", () => {
    expect(maxIn(pts(5, 9, 7), T + 30_000, T + 70_000)).toBe(9);
    expect(maxIn(pts(5, 9, 7), T + 2 * MIN, T + 3 * MIN)).toBe(7);
  });
});

describe("cost", () => {
  it("prices Event requests and GB-seconds, rounding duration up by half a millisecond", () => {
    const c = eventCost(1_000_000, 10_000_000);
    expect(c.requests).toBeCloseTo(0.2, 10);
    expect(c.compute).toBeCloseTo(((10_000_000 + 500_000) / 1000) * PRICE.eventGbSecond, 10);
    expect(c.total).toBeCloseTo(c.requests + c.compute, 10);
  });
  it("prices Web requests, CPU and memory separately, and DSQL on top", () => {
    const c = webCost(1_000_000, 2_000_000, 1000, 5000);
    expect(c.requests).toBeCloseTo(0.3, 10);
    expect(c.compute).toBeCloseTo(2000 * PRICE.webVcpuSecond, 10);
    expect(c.memory).toBeCloseTo(1000 * PRICE.webGbSecond, 10);
    expect(c.dsql).toBeCloseTo(0.05, 10);
    expect(c.total).toBeCloseTo(c.requests + c.compute + c.memory + c.dsql, 10);
  });
  it("turns environment time and memory into GB-seconds per minute", () => {
    const gbs = webMemoryGbSeconds(pts(60_000, 30_000), pts(1024, 512));
    expect(gbs.map((p) => p.v)).toEqual([60, 15]);
  });
});

const run = (over: Partial<RunResult> = {}, step: Partial<RunResult["steps"][number]> = {}): RunResult => ({
  startedAt: "2026-10-19T00:00:00Z",
  endedAt: "2026-10-19T00:10:00Z",
  options: { stepSeconds: 90 },
  loadgen: { coresUsed: 0.14, coresAvailable: 2 },
  unfinished: 0,
  steps: [{ rate: 25, scheduled: 2250, sent: 2250, dropped: 0, ok: 2250, failures: {}, lateRate: 0, latencyMs: { p50: 1, p95: 2, p99: 3 }, ...step }],
  ...over,
});

describe("judge (plan.md §8)", () => {
  it("adopts a clean run from set 2", () => {
    expect(judge(2, "0", run())).toEqual({ adopted: true, reasons: [], stepAdopted: [true] });
  });
  it("discards set 1, non-zero exit, unfinished requests and a saturated load generator", () => {
    expect(judge(1, "0", run()).adopted).toBe(false);
    expect(judge(2, "1", run()).adopted).toBe(false);
    expect(judge(2, "0", run({ unfinished: 3 })).adopted).toBe(false);
    expect(judge(2, "0", run({ loadgen: { coresUsed: 1.3, coresAvailable: 2 } })).adopted).toBe(false);
  });
  it("discards only the step when sends were late or dropped more than 5%", () => {
    const late = judge(2, "0", run({}, { lateRate: 0.06 }));
    expect(late.adopted).toBe(true);
    expect(late.stepAdopted).toEqual([false]);
    expect(judge(2, "0", run({}, { dropped: 200 })).stepAdopted).toEqual([false]);
    expect(judge(2, "0", run({}, { lateRate: 0.05 })).stepAdopted).toEqual([true]);
  });
});

describe("dsqlCutoff", () => {
  const row = (startedAt: string, stoppedAt: string): ManifestRow => ({ set: 2, index: 1, name: "x", prefix: "p", startedAt, stoppedAt, exitCode: "0", gapSeconds: 300 });
  it("stops five minutes after the run, or at the next run's start if that is earlier", () => {
    const a = row("2026-10-19T00:00:00Z", "2026-10-19T00:10:00Z");
    expect(dsqlCutoff(a)).toBe(Date.parse("2026-10-19T00:15:00Z"));
    expect(dsqlCutoff(a, row("2026-10-19T00:12:00Z", "2026-10-19T00:20:00Z"))).toBe(Date.parse("2026-10-19T00:12:00Z"));
  });
});
