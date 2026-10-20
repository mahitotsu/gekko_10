import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PRICE,
  allocate,
  analyzeDir,
  analyzeRun,
  dsqlCutoff,
  eventCost,
  eventCostBilled,
  judge,
  maxIn,
  render,
  verdictOf,
  webCost,
  webMemoryGbSeconds,
  type Analysis,
  type ManifestRow,
  type RunOut,
  type RunResult,
  type StepOut,
  type StepResult,
} from "../scripts/analyze.js";

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
  it("prices Event from the billed durations exactly", () => {
    const c = eventCostBilled(1_000_000, 11_000_000, 100);
    expect(c.compute).toBeCloseTo(11_000 * PRICE.eventGbSecond, 10);
    expect(c.dsql).toBeCloseTo(100 * PRICE.dsqlDpu, 10);
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
    expect(webMemoryGbSeconds(pts(60_000, 30_000), pts(1024, 512)).map((p) => p.v)).toEqual([60, 15]);
  });
});

const sum = (over: Partial<StepResult> = {}): StepResult => ({
  rate: 25,
  scheduled: 2250,
  sent: 2250,
  dropped: 0,
  ok: 2250,
  completed: 2250,
  failures: {},
  lateRate: 0,
  latencyMs: { p50: 1, p95: 2, p99: 3 },
  serviceMs: { p50: 1, p95: 2, p99: 3 },
  builds: ["b1"],
  ...over,
});
const run = (over: Partial<RunResult> = {}): RunResult => ({
  startedAt: "2026-10-19T00:00:00Z",
  endedAt: "2026-10-19T00:10:00Z",
  options: { stepSeconds: 90 },
  loadgen: { coresUsed: 0.14, coresAvailable: 2 },
  unfinished: 0,
  steps: [sum()],
  ...over,
});

describe("judge (plan.md §7)", () => {
  it("adopts a clean run from set 2", () => {
    expect(judge(2, "0", run(), "b1")).toEqual({ adopted: true, reasons: [], stepAdopted: [true] });
  });
  it("discards set 1, non-zero exit, partial results, unfinished requests, a saturated load generator and another build", () => {
    expect(judge(1, "0", run()).adopted).toBe(false);
    expect(judge(2, "1", run()).adopted).toBe(false);
    expect(judge(2, "0", run({ partial: true, loadgen: undefined })).adopted).toBe(false);
    expect(judge(2, "0", run({ unfinished: 3 })).adopted).toBe(false);
    expect(judge(2, "0", run({ loadgen: { coresUsed: 1.3, coresAvailable: 2 } })).adopted).toBe(false);
    const other = judge(2, "0", run({ steps: [sum({ builds: ["b0"] })] }), "b1");
    expect(other.adopted).toBe(false);
    expect(other.reasons[0]).toContain("版の不一致");
  });
  it("discards only the step when sends were late or dropped more than 5%", () => {
    const late = judge(2, "0", run({ steps: [sum({ lateRate: 0.06 })] }));
    expect(late.adopted).toBe(true);
    expect(late.stepAdopted).toEqual([false]);
    expect(judge(2, "0", run({ steps: [sum({ dropped: 200 })] })).stepAdopted).toEqual([false]);
    expect(judge(2, "0", run({ steps: [sum({ lateRate: 0.05 })] })).stepAdopted).toEqual([true]);
  });
});

const row = (startedAt: string, stoppedAt: string, over: Partial<ManifestRow> = {}): ManifestRow => ({
  case: "A",
  set: 2,
  index: 1,
  name: "event-dsql-reuse",
  prefix: "A-set2-1-event-dsql-reuse",
  startedAt,
  stoppedAt,
  exitCode: "0",
  gapSeconds: 300,
  ...over,
});

describe("dsqlCutoff", () => {
  it("stops five minutes after the run, or at the next run's start if that is earlier", () => {
    const a = row("2026-10-19T00:00:00Z", "2026-10-19T00:10:00Z");
    expect(dsqlCutoff(a)).toBe(Date.parse("2026-10-19T00:15:00Z"));
    expect(dsqlCutoff(a, row("2026-10-19T00:12:00Z", "2026-10-19T00:20:00Z"))).toBe(Date.parse("2026-10-19T00:12:00Z"));
  });
});

describe("analyzeRun", () => {
  const series = (metric: string, stat: string, values: number[], namespace = "AWS/Lambda") => ({
    namespace,
    metric,
    stat,
    points: values.map((v, i) => [new Date(T + i * MIN).toISOString(), v] as [string, number]),
  });
  const metrics = { series: [series("Invocations", "Sum", [1000, 1250]), series("Duration", "Sum", [4000, 5000]), series("ConcurrentExecutions", "Maximum", [20, 30]), series("TotalDPU", "Sum", [10, 15], "AWS/AuroraDSQL")] };
  const result = run({ startedAt: new Date(T).toISOString(), steps: [sum({ sent: 2250, ok: 2250 })] });

  it("counts the platform's requests and prices them with the rounding estimate", () => {
    const out = analyzeRun(row(new Date(T).toISOString(), new Date(T + 10 * MIN).toISOString()), result, metrics, Number.MAX_SAFE_INTEGER);
    expect(out.total.lambdaRequests).toBe(2250);
    expect(out.total.dpu).toBe(25);
    expect(out.total.cost.compute).toBeCloseTo(((9000 + 0.5 * 2250) / 1000) * PRICE.eventGbSecond, 10);
    expect(out.total.costBilled).toBeUndefined();
    expect(out.steps[0].concurrentMax).toBe(30);
  });

  it("prices an Event run from the REPORT summary when there is one, and reports the cold starts", () => {
    const reports = { logGroup: "g", start: "s", end: "e", stats: { invocations: 2250, billedMs: 9500, durationMs: 9000, durationP50: 4, durationP99: 20, maxMemoryBytes: 1, coldStarts: 12, initP50: 300 } };
    const out = analyzeRun(row(new Date(T).toISOString(), new Date(T + 10 * MIN).toISOString()), result, metrics, Number.MAX_SAFE_INTEGER, undefined, reports);
    expect(out.total.costBilled?.compute).toBeCloseTo(9.5 * PRICE.eventGbSecond, 10);
    expect(out.total.coldStartsReported).toBe(12);
    expect(out.total.initP50Ms).toBe(300);
  });

  it("does not count requests the platform never saw (client failures and 429)", () => {
    const failing = run({ startedAt: new Date(T).toISOString(), steps: [sum({ sent: 2250, ok: 2150, failures: { "0 UND_ERR_CONNECT_TIMEOUT": 60, "429 Platform.EndpointRequestThrottle": 40 } })] });
    expect(analyzeRun(row(new Date(T).toISOString(), new Date(T + 10 * MIN).toISOString()), failing, metrics, Number.MAX_SAFE_INTEGER).total.notCounted).toBe(100);
  });
});

// ---- the acceptance verdict ----
const cost = { requests: 0, compute: 0, memory: 0, dsql: 0, total: 0 };
const step = (over: Partial<StepOut> = {}): StepOut => ({
  rate: 100,
  adopted: true,
  scheduled: 9000,
  sent: 9000,
  dropped: 0,
  ok: 9000,
  failures: {},
  fail53400: 0,
  failOther: 0,
  p50: 10,
  environments: 5,
  coldStarts: 0,
  newConnectionPct: 0,
  inconsistent: 0,
  appCount: 9000,
  lateRate: 0,
  builds: ["b1"],
  lambdaRequests: 9000,
  concurrentMax: 0,
  dsqlConnectCalls: 0,
  dsqlConnectionsMax: 0,
  dpu: 0,
  cost,
  ...over,
});
const out = (over: Partial<RunOut> = {}, steps: StepOut[] = [step()]): RunOut => ({
  case: "A",
  set: 2,
  index: 1,
  name: "event-dsql-reuse",
  adopted: true,
  reasons: [],
  loadgenCores: 0.1,
  steps,
  total: { sent: 9000, ok: 9000, lambdaRequests: 9000, notCounted: 0, dsqlConnectCalls: 0, dpu: 0, cost, costWebMemoryMaxBound: null },
  gapSeconds: 300,
  ...over,
});
const analysis = (runs: RunOut[]): Analysis => ({ runs, plan: { startedAt: "2026-10-19T00:00:00Z", plan: { build: "b1", seed: "s", cases: {} } }, fargateUsd: 1 });
const status = (a: Analysis, id: string) => verdictOf(a).checks.find((c) => c.id === id)?.status;

describe("verdictOf", () => {
  it("passes a clean measurement", () => {
    const v = verdictOf(analysis([out({}, [step({ concurrentMax: 400 })])]));
    expect(v.pass).toBe(true);
    expect(v.checks.filter((c) => ["b", "c", "d", "e"].includes(c.id)).every((c) => c.status === "pass")).toBe(true);
    expect(status(analysis([out()]), "a")).toBe("na");
  });

  it("(b) fails when responses carry no app time, or too many are inconsistent", () => {
    expect(status(analysis([out({}, [step({ appCount: 0 })])]), "b")).toBe("fail");
    expect(status(analysis([out({}, [step({ inconsistent: 10 })])]), "b")).toBe("fail");
    expect(status(analysis([out({}, [step({ inconsistent: 9 })])]), "b")).toBe("pass");
  });

  it("(c) fails for a measured run that was not adopted for a reason other than the build, but not for the warm-up", () => {
    expect(status(analysis([out({ set: 1, adopted: false, reasons: ["セット 1（ウォームアップ）"] })]), "c")).toBe("pass");
    expect(status(analysis([out({ adopted: false, reasons: ["生成側が飽和（70%）"] })]), "c")).toBe("fail");
  });

  it("(d) fails on another build, and when no build was seen", () => {
    expect(status(analysis([out({ adopted: false, reasons: ["版の不一致（b0）"] }, [step({ builds: ["b0"] })])]), "d")).toBe("fail");
    expect(status(analysis([out({}, [step({ builds: [] })])]), "d")).toBe("fail");
  });

  it("(e) compares sent with the platform's count, leaving out what the platform never saw", () => {
    expect(status(analysis([out({ total: { ...out().total, lambdaRequests: 8000 } })]), "e")).toBe("fail");
    expect(status(analysis([out({ total: { ...out().total, lambdaRequests: 8900, notCounted: 100 } })]), "e")).toBe("pass");
    expect(status(analysis([out({ total: { ...out().total, lambdaRequests: 8995 } })]), "e")).toBe("pass");
  });

  it("(a) compares the calibration's /db/read p50 with the reference", () => {
    const cal = (name: string, p50: number) => out({ case: "K", set: 2, name }, [step({ rate: 50, p50 }), step({ rate: 100, p50 })]);
    expect(status(analysis([cal("event-dsql-reuse", 15.9), cal("web-dsql-pool", 8.9)]), "a")).toBe("pass");
    expect(status(analysis([cal("event-dsql-reuse", 17.5), cal("web-dsql-pool", 8.9)]), "a")).toBe("fail");
  });

  it("(f) only notes a difference between the sets", () => {
    const sets = [out({ set: 2 }, [step({ p50: 10 })]), out({ set: 3 }, [step({ p50: 14 })])];
    const v = verdictOf(analysis(sets));
    expect(v.checks.find((c) => c.id === "f")?.status).toBe("note");
    expect(v.pass).toBe(true);
  });

  it("(g) holds a case whose contention point was not reached, without failing the verdict", () => {
    const low = verdictOf(analysis([out({}, [step({ concurrentMax: 100 })])]));
    expect(low.checks.find((c) => c.id === "g:A")?.status).toBe("hold");
    expect(low.pass).toBe(true);
    expect(verdictOf(analysis([out({}, [step({ concurrentMax: 380 })])])).checks.find((c) => c.id === "g:A")?.status).toBe("pass");
  });

  it("(g) D wants pool waiting on the pool of 10 in every run", () => {
    const d = (waiting: number) => out({ case: "D", name: "web-dsql-pool10" }, [step({ poolWaitingMax: waiting })]);
    expect(status(analysis([d(3)]), "g:D")).toBe("pass");
    expect(status(analysis([d(0)]), "g:D")).toBe("hold");
  });

  it("(g) C wants the spikes to have been delivered", () => {
    const c = (sent: number) => out({ case: "C" }, [step({ rate: 1500, scheduled: 45000, sent })]);
    expect(status(analysis([c(45000)]), "g:C")).toBe("pass");
    expect(status(analysis([c(30000)]), "g:C")).toBe("hold");
  });
});

describe("analyzeDir and render", () => {
  it("reads a result directory and renders tables and the verdict", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "analyze-"));
    const prefix = "A-set2-1-event-dsql-reuse";
    const started = new Date(T).toISOString();
    const stopped = new Date(T + 10 * MIN).toISOString();
    writeFileSync(path.join(dir, "suite-set2.manifest.jsonl"), JSON.stringify(row(started, stopped, { prefix })) + "\n");
    writeFileSync(path.join(dir, "suite.plan.json"), JSON.stringify({ startedAt: started, plan: { build: "b1", seed: "s", cases: { A: { path: "/app/external?ms=1000", steps: [25], stepSeconds: 90 } } } }));
    writeFileSync(path.join(dir, `${prefix}.json`), JSON.stringify([run({ startedAt: started, endedAt: stopped, steps: [sum({ app: { appMs: { p50: 5 }, outsideMs: { p50: 6 }, appOtherMs: { p50: 1 }, inconsistent: 0, count: 2250 } })] })]));
    writeFileSync(path.join(dir, `${prefix}.metrics.json`), JSON.stringify({ series: [{ namespace: "AWS/Lambda", metric: "Invocations", stat: "Sum", points: [[started, 2250]] }] }));
    const a = analyzeDir(dir);
    expect(a.runs).toHaveLength(1);
    expect(a.runs[0].total.lambdaRequests).toBe(2250);
    expect(a.runs[0].adopted).toBe(true);
    const md = render(a, [2, 3]);
    expect(md).toContain("# ケース A");
    expect(md).toContain("| event-dsql-reuse |");
    expect(md).toContain("/app/external?ms=1000");
  });
});
