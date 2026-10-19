// Aggregates a suite's result directory (scripts/suite-fetch.ts, or scripts/suite-post.ts inside the task) into tables, costs and the
// acceptance verdict. It reads only the collected files; it does not call AWS.
// Command line: scripts/analyze-cli.ts (kept apart: this module is bundled into the load task, where every module would
// count as the entry point and run its command line).
// Adoption rules and acceptance checks: docs/plan.md §8. Prices: docs/findings.md §3-2 and §3-3 (Tokyo, AWS Price List API, fetched 2026-10-18).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ReportsFile } from "./reports-lib.js";

export const PRICE = {
  eventRequest: 0.2e-6, // APN1-Request-ARM, per request
  eventGbSecond: 0.0000133334, // APN1-Lambda-GB-Second-ARM (first tier)
  webRequest: 0.3e-6, // APN1-Lambda-Web-Request-ARM
  webVcpuSecond: 0.0000322421, // APN1-Lambda-Web-vCPU-Second-ARM
  webGbSecond: 0.0000042688, // APN1-Lambda-Web-Memory-GB-Second-ARM
  dsqlDpu: 0.00001, // APN1-DSQL-DistributedProcessingUnits
  fargateHour: 2 * 0.05056 + 4 * 0.00553 + 0.005, // 2 vCPU / 4 GB x86_64 + public IPv4 (findings.md §3-2)
};
/** Event functions are all 1024 MB (lib/event-stack.ts). */
export const EVENT_MEMORY_GB = 1;
/** Without REPORT lines: expected rounding of billed duration to 1 ms is half a millisecond per invocation. */
export const EVENT_ROUNDING_MS = 0.5;
export const MAX_CORE_RATIO = 0.6;
export const MAX_LATE_OR_DROP = 0.05;
/** Acceptance (a): p50 of /db/read with the instrumented build against the previous measurement (commit 5a769a1, docs/report.md). */
export const REFERENCE_P50_MS: Record<string, number> = { "event-dsql-reuse": 15.7, "web-dsql-pool": 8.6 };
export const REFERENCE_TOLERANCE_MS = 1;
export const MAX_INCONSISTENT_SHARE = 0.001;
export const MAX_SET_DIFFERENCE_MS = 2;
/** Calibration case: the /db/read check of acceptance (a). */
export const CALIBRATION_CASE = "K";

// ---- input shapes ----
export type Quantiles = { p50?: number; p95?: number; p99?: number };
export interface PathSummary {
  ok: number;
  completed: number;
  failures: Record<string, number>;
  latencyMs: Quantiles;
  serviceMs: Quantiles;
  db?: { newConnectionPct: number; acquireMs: Quantiles; queryMs: Quantiles; queriesPerRequest?: number; poolWaitingMax?: number; poolTotalMax?: number };
  app?: { appMs: Quantiles; outsideMs: Quantiles; appOtherMs: Quantiles; inconsistent: number; count: number };
}
export interface StepResult extends PathSummary {
  rate: number;
  scheduled: number;
  sent: number;
  dropped: number;
  lateRate: number;
  environments?: number;
  coldStarts?: number;
  builds?: string[];
  byPath?: Record<string, PathSummary>;
}
export interface RunResult {
  startedAt: string;
  endedAt: string;
  options: { stepSeconds: number };
  loadgen?: { coresUsed: number; coresAvailable: number };
  unfinished?: number;
  partial?: boolean;
  steps: StepResult[];
}
export interface MetricSeries {
  namespace: string;
  metric: string;
  stat: string;
  points: [string, number][];
}
export interface Metrics {
  series: MetricSeries[];
}
export interface ManifestRow {
  case: string;
  set: number;
  index: number;
  name: string;
  prefix: string;
  startedAt: string;
  stoppedAt: string;
  exitCode: string;
  gapSeconds: number;
  build?: string;
}
export interface PlanFile {
  taskId?: string;
  startedAt: string;
  plan: { build: string; seed: string; cases: Record<string, { steps: number[]; stepSeconds: number; path?: string; mix?: string }> };
}

// ---- time series ----
export interface Point {
  t: number;
  v: number;
}
export const PERIOD_MS = 60_000;

export function pointsOf(m: Metrics, metric: string, stat: string, namespace?: string): Point[] {
  const s = m.series.find((x) => x.metric === metric && x.stat === stat && (!namespace || x.namespace === namespace));
  return (s?.points ?? []).map(([t, v]) => ({ t: Date.parse(t), v }));
}

/** Sum of per-minute totals, each weighted by the share of its minute that falls inside [from, to). */
export function allocate(points: Point[], from: number, to: number): number {
  let sum = 0;
  for (const p of points) {
    const overlap = Math.min(p.t + PERIOD_MS, to) - Math.max(p.t, from);
    if (overlap > 0) sum += (p.v * overlap) / PERIOD_MS;
  }
  return sum;
}

/** Maximum of the samples whose minute overlaps [from, to). */
export function maxIn(points: Point[], from: number, to: number): number {
  let max = 0;
  for (const p of points) if (Math.min(p.t + PERIOD_MS, to) > Math.max(p.t, from)) max = Math.max(max, p.v);
  return max;
}

/** Per-minute GB-seconds of Web memory: environment seconds x per-environment memory (MB / 1024). */
export function webMemoryGbSeconds(activeMs: Point[], memoryMb: Point[]): Point[] {
  const mem = new Map(memoryMb.map((p) => [p.t, p.v]));
  return activeMs.map((p) => ({ t: p.t, v: (p.v / 1000) * ((mem.get(p.t) ?? 0) / 1024) }));
}

// ---- cost ----
export interface Cost {
  requests: number;
  compute: number;
  memory: number;
  dsql: number;
  total: number;
}
const sumCost = (c: Omit<Cost, "total">): Cost => ({ ...c, total: c.requests + c.compute + c.memory + c.dsql });

export function eventCost(invocations: number, durationMs: number, dpu = 0): Cost {
  const gbSeconds = ((durationMs + EVENT_ROUNDING_MS * invocations) / 1000) * EVENT_MEMORY_GB;
  return sumCost({ requests: invocations * PRICE.eventRequest, compute: gbSeconds * PRICE.eventGbSecond, memory: 0, dsql: dpu * PRICE.dsqlDpu });
}
/** Event cost from the billed durations of the REPORT lines (no rounding estimate). */
export function eventCostBilled(invocations: number, billedMs: number, dpu = 0): Cost {
  return sumCost({ requests: invocations * PRICE.eventRequest, compute: (billedMs / 1000) * EVENT_MEMORY_GB * PRICE.eventGbSecond, memory: 0, dsql: dpu * PRICE.dsqlDpu });
}
export function webCost(requests: number, cpuMs: number, memoryGbSeconds: number, dpu = 0): Cost {
  return sumCost({
    requests: requests * PRICE.webRequest,
    compute: (cpuMs / 1000) * PRICE.webVcpuSecond,
    memory: memoryGbSeconds * PRICE.webGbSecond,
    dsql: dpu * PRICE.dsqlDpu,
  });
}

// ---- adoption (plan.md §8) ----
export interface Judgement {
  adopted: boolean;
  reasons: string[];
  stepAdopted: boolean[];
}
export function judge(set: number, exitCode: string, result: RunResult, expectedBuild?: string): Judgement {
  const reasons: string[] = [];
  if (set === 1) reasons.push("セット 1（ウォームアップ）");
  if (exitCode !== "0") reasons.push(`終了コード ${exitCode}`);
  if (result.partial || !result.loadgen) reasons.push("結果が途中まで");
  if ((result.unfinished ?? 0) > 0) reasons.push(`未完了 ${result.unfinished} 件`);
  if (result.loadgen) {
    const cores = result.loadgen.coresUsed / result.loadgen.coresAvailable;
    if (cores > MAX_CORE_RATIO) reasons.push(`生成側が飽和（${(cores * 100).toFixed(0)}%）`);
  }
  if (expectedBuild !== undefined) {
    const wrong = [...new Set(result.steps.flatMap((s) => s.builds ?? []))].filter((b) => b !== expectedBuild);
    if (wrong.length) reasons.push(`版の不一致（${wrong.join("、")}）`);
  }
  const runReasons = reasons.length;
  const stepAdopted = result.steps.map((s) => {
    const bad = s.lateRate > MAX_LATE_OR_DROP || (s.scheduled ? s.dropped / s.scheduled : 0) > MAX_LATE_OR_DROP;
    if (bad) reasons.push(`${s.rate} RPS の段は送信の遅れかドロップが 5% 超`);
    return !bad;
  });
  return { adopted: runReasons === 0, reasons, stepAdopted };
}

// ---- per-run analysis ----
export interface PathOut {
  ok: number;
  completed: number;
  p50?: number;
  p99?: number;
  acquireP50?: number;
  queryP50?: number;
  appMsP50?: number;
  outsideP50?: number;
  appOtherP50?: number;
  queriesPerRequest?: number;
  failures: Record<string, number>;
}
export interface StepOut {
  rate: number;
  adopted: boolean;
  scheduled: number;
  sent: number;
  dropped: number;
  ok: number;
  failures: Record<string, number>;
  fail53400: number;
  failOther: number;
  p50?: number;
  p95?: number;
  p99?: number;
  serviceP50?: number;
  environments: number;
  coldStarts: number;
  newConnectionPct: number | null;
  acquireP50?: number;
  acquireP99?: number;
  queryP50?: number;
  appMsP50?: number;
  outsideP50?: number;
  appOtherP50?: number;
  queriesPerRequest?: number;
  poolWaitingMax?: number;
  poolTotalMax?: number;
  inconsistent: number;
  appCount: number;
  lateRate: number;
  builds: string[];
  lambdaRequests: number;
  concurrentMax: number;
  dsqlConnectCalls: number;
  dsqlConnectionsMax: number;
  dpu: number;
  cost: Cost;
  byPath?: Record<string, PathOut>;
}
export interface RunOut {
  case: string;
  set: number;
  index: number;
  name: string;
  adopted: boolean;
  reasons: string[];
  loadgenCores: number;
  steps: StepOut[];
  total: {
    sent: number;
    ok: number;
    lambdaRequests: number;
    /** Requests the platform never counted (client-side failures and 429s). */
    notCounted: number;
    dsqlConnectCalls: number;
    dpu: number;
    cost: Cost;
    /** Event only: the same run priced from the billed durations of the REPORT lines. */
    costBilled?: Cost;
    coldStartsReported?: number;
    initP50Ms?: number;
    costWebMemoryMaxBound: number | null;
  };
  gapSeconds: number;
}

const pathOut = (g: PathSummary): PathOut => ({
  ok: g.ok,
  completed: g.completed,
  p50: g.serviceMs.p50,
  p99: g.serviceMs.p99,
  acquireP50: g.db?.acquireMs.p50,
  queryP50: g.db?.queryMs.p50,
  appMsP50: g.app?.appMs.p50,
  outsideP50: g.app?.outsideMs.p50,
  appOtherP50: g.app?.appOtherMs.p50,
  queriesPerRequest: g.db?.queriesPerRequest,
  failures: g.failures,
});

export function analyzeRun(row: ManifestRow, result: RunResult, metrics: Metrics, dsqlUntil: number, fnUntil = Number.MAX_SAFE_INTEGER, reports?: ReportsFile, expectedBuild?: string): RunOut {
  const isWeb = row.name.startsWith("web-");
  const j = judge(row.set, row.exitCode, result, expectedBuild);
  const t0 = Date.parse(result.startedAt);
  const stepMs = result.options.stepSeconds * 1000;
  /** Totals take whole minutes from the one containing the start: the load starts inside that minute, and the function was idle before it. */
  const from = Math.floor(t0 / PERIOD_MS) * PERIOD_MS;

  const requests = isWeb ? pointsOf(metrics, "ExecutedRequests", "Sum", "AWS/Lambda/Web") : pointsOf(metrics, "Invocations", "Sum", "AWS/Lambda");
  const duration = pointsOf(metrics, "Duration", "Sum");
  const cpu = pointsOf(metrics, "EnvironmentCPUTime", "Sum");
  const active = pointsOf(metrics, "EnvironmentActiveTime", "Sum");
  const memAvg = pointsOf(metrics, "EnvironmentMaxMemoryUsage", "Average");
  const memMax = pointsOf(metrics, "EnvironmentMaxMemoryUsage", "Maximum");
  const memGbs = webMemoryGbSeconds(active, memAvg);
  const memGbsMax = webMemoryGbSeconds(active, memMax);
  const dpu = pointsOf(metrics, "TotalDPU", "Sum");
  const calls = pointsOf(metrics, "CallCount", "Sum", "AWS/Usage");
  const conns = pointsOf(metrics, "ResourceCount", "Maximum", "AWS/Usage");
  const concurrent = isWeb ? pointsOf(metrics, "EndpointActiveEnvironments", "Maximum") : pointsOf(metrics, "ConcurrentExecutions", "Maximum");

  const cost = (a: number, b: number, dsqlTo: number): { cost: Cost; req: number } => {
    b = Math.min(b, fnUntil);
    const req = allocate(requests, a, b);
    const d = allocate(dpu, a, Math.min(b, dsqlTo));
    const c = isWeb ? webCost(req, allocate(cpu, a, b), allocate(memGbs, a, b), d) : eventCost(req, allocate(duration, a, b), d);
    return { cost: c, req };
  };

  const steps: StepOut[] = result.steps.map((s, i) => {
    const a = t0 + i * stepMs;
    const b = a + stepMs;
    const { cost: c, req } = cost(a, b, dsqlUntil);
    const fail53400 = Object.entries(s.failures).reduce((n, [k, v]) => n + (k.includes("53400") ? v : 0), 0);
    const failTotal = Object.values(s.failures).reduce((n, v) => n + v, 0);
    return {
      rate: s.rate,
      adopted: j.stepAdopted[i],
      scheduled: s.scheduled,
      sent: s.sent,
      dropped: s.dropped,
      ok: s.ok,
      failures: s.failures,
      fail53400,
      failOther: failTotal - fail53400,
      p50: s.latencyMs.p50,
      p95: s.latencyMs.p95,
      p99: s.latencyMs.p99,
      serviceP50: s.serviceMs.p50,
      environments: s.environments ?? 0,
      coldStarts: s.coldStarts ?? 0,
      newConnectionPct: s.db ? s.db.newConnectionPct : null,
      acquireP50: s.db?.acquireMs.p50,
      acquireP99: s.db?.acquireMs.p99,
      queryP50: s.db?.queryMs.p50,
      appMsP50: s.app?.appMs.p50,
      outsideP50: s.app?.outsideMs.p50,
      appOtherP50: s.app?.appOtherMs.p50,
      queriesPerRequest: s.db?.queriesPerRequest,
      poolWaitingMax: s.db?.poolWaitingMax,
      poolTotalMax: s.db?.poolTotalMax,
      inconsistent: s.app?.inconsistent ?? 0,
      appCount: s.app?.count ?? 0,
      lateRate: s.lateRate,
      builds: s.builds ?? [],
      lambdaRequests: req,
      concurrentMax: maxIn(concurrent, a, Math.min(b, fnUntil)),
      dsqlConnectCalls: allocate(calls, a, Math.min(b, dsqlUntil)),
      dsqlConnectionsMax: maxIn(conns, a, b),
      dpu: allocate(dpu, a, Math.min(b, dsqlUntil)),
      cost: c,
      ...(s.byPath ? { byPath: Object.fromEntries(Object.entries(s.byPath).map(([p, g]) => [p, pathOut(g)])) } : {}),
    };
  });

  // Run total: every function-specific minute in the file (includes the ~5 minutes the Web environments linger), DSQL cut at dsqlUntil.
  const end = fnUntil;
  const { cost: total, req: totalReq } = cost(from, Number.MAX_SAFE_INTEGER, dsqlUntil);
  const maxBound = isWeb ? webCost(totalReq, allocate(cpu, from, end), allocate(memGbsMax, from, end), allocate(dpu, from, dsqlUntil)).total : null;
  const totalDpu = allocate(dpu, from, dsqlUntil);
  const clientNotCounted = steps.reduce(
    (n, s) => n + Object.entries(s.failures).reduce((m, [k, v]) => m + (k.startsWith("0 ") || k === "0" || k.startsWith("429") ? v : 0), 0),
    0,
  );
  return {
    case: row.case,
    set: row.set,
    index: row.index,
    name: row.name,
    adopted: j.adopted,
    reasons: j.reasons,
    loadgenCores: result.loadgen?.coresUsed ?? 0,
    steps,
    total: {
      sent: steps.reduce((n, s) => n + s.sent, 0),
      ok: steps.reduce((n, s) => n + s.ok, 0),
      lambdaRequests: totalReq,
      notCounted: clientNotCounted,
      dsqlConnectCalls: allocate(calls, from, dsqlUntil),
      dpu: totalDpu,
      cost: total,
      ...(reports && !isWeb ? { costBilled: eventCostBilled(reports.stats.invocations, reports.stats.billedMs, totalDpu), coldStartsReported: reports.stats.coldStarts, initP50Ms: reports.stats.initP50 } : {}),
      costWebMemoryMaxBound: maxBound,
    },
    gapSeconds: row.gapSeconds,
  };
}

export function loadManifest(dir: string): ManifestRow[] {
  return readdirSync(dir)
    .filter((f) => /^suite-set\d+\.manifest\.jsonl$/.test(f))
    .flatMap((f) =>
      readFileSync(path.join(dir, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as ManifestRow),
    )
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

/** DSQL metrics are cluster-wide: cut each run at min(stop + 5 min, next run's start) so neighbouring runs are not mixed in. */
export const dsqlCutoff = (row: ManifestRow, next?: ManifestRow) =>
  Math.min(Date.parse(row.stoppedAt) + 5 * 60_000, next ? Date.parse(next.startedAt) : Number.MAX_SAFE_INTEGER);

export interface Analysis {
  runs: RunOut[];
  plan: PlanFile;
  fargateUsd: number;
}

export function analyzeDir(dir: string): Analysis {
  const rows = loadManifest(dir);
  const plan = JSON.parse(readFileSync(path.join(dir, "suite.plan.json"), "utf8")) as PlanFile;
  const runs = rows.map((row, i) => {
    const raw = JSON.parse(readFileSync(path.join(dir, `${row.prefix}.json`), "utf8")) as RunResult[];
    const result = raw[0] ?? { startedAt: row.startedAt, endedAt: row.stoppedAt, options: { stepSeconds: 90 }, partial: true, steps: [] };
    const metricsFile = path.join(dir, `${row.prefix}.metrics.json`);
    const metrics: Metrics = existsSync(metricsFile) ? JSON.parse(readFileSync(metricsFile, "utf8")) : { series: [] };
    const reportsFile = path.join(dir, `${row.prefix}.reports.json`);
    const reports: ReportsFile | undefined = existsSync(reportsFile) ? JSON.parse(readFileSync(reportsFile, "utf8")) : undefined;
    const sameNext = rows.slice(i + 1).find((r) => r.name === row.name);
    return analyzeRun(
      row,
      result,
      metrics,
      dsqlCutoff(row, rows[i + 1]),
      sameNext ? Math.floor(Date.parse(sameNext.startedAt) / PERIOD_MS) * PERIOD_MS : undefined,
      reports,
      plan.plan.build,
    );
  });
  const lastStop = rows.length ? Date.parse(rows[rows.length - 1].stoppedAt) : Date.parse(plan.startedAt);
  const hours = (lastStop - Date.parse(plan.startedAt)) / 3_600_000;
  return { runs, plan, fargateUsd: hours * PRICE.fargateHour };
}

// ---- acceptance (docs/plan.md §8) ----
export type CheckStatus = "pass" | "fail" | "na" | "note" | "hold";
export interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
}
export interface Verdict {
  /** No check failed. Cases whose contention point was not reached are "hold" and do not fail the verdict. */
  pass: boolean;
  checks: Check[];
}

const measured = (runs: RunOut[]) => runs.filter((r) => r.set !== 1);
const label = (r: RunOut) => `${r.case}-set${r.set}-${r.index}-${r.name}`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Where each case is supposed to reach the contention point it was designed for (plan.md §8, acceptance (g)). */
export const REACH: Record<string, (runs: RunOut[]) => { reached: boolean; detail: string }> = {
  A: (runs) => {
    const event = runs.filter((r) => r.name.startsWith("event-"));
    const top = event.map((r) => ({ r, peak: Math.max(...r.steps.map((s) => s.concurrentMax)) }));
    const reached = top.length > 0 && top.every((t) => t.peak >= 320);
    return { reached, detail: `Event の同時実行の最大: ${top.map((t) => `${label(t.r)}=${t.peak}`).join("、") || "なし"}（400 の 8 割 = 320 以上が必要）` };
  },
  B: (runs) => {
    const paths = runs.map((r) => ({ r, n: Object.keys(r.steps[r.steps.length - 1]?.byPath ?? {}).length }));
    const reached = paths.length > 0 && paths.every((p) => p.n >= 5);
    return { reached, detail: `最終段で観測したエンドポイント数: ${paths.map((p) => `${label(p.r)}=${p.n}`).join("、") || "なし"}（5 が必要）` };
  },
  C: (runs) => {
    const spikes = runs.flatMap((r) => r.steps.filter((s) => s.rate >= 1000).map((s) => ({ r, s })));
    const bad = spikes.filter(({ s }) => s.scheduled === 0 || s.sent < 0.95 * s.scheduled);
    return { reached: spikes.length > 0 && bad.length === 0, detail: `スパイクの段 ${spikes.length} 個のうち、送信が予定の 95% 未満: ${bad.length}` };
  },
  D: (runs) => {
    const small = runs.filter((r) => r.name === "web-dsql-pool10");
    const waited = small.filter((r) => r.steps.some((s) => (s.poolWaitingMax ?? 0) > 0));
    return { reached: small.length > 0 && waited.length === small.length, detail: `pool10 でプール待ちが出た回: ${waited.length} / ${small.length}` };
  },
};

export function verdictOf(analysis: Analysis): Verdict {
  const checks: Check[] = [];
  const runs = analysis.runs;
  const m = measured(runs);
  const add = (id: string, title: string, status: CheckStatus, detail: string) => checks.push({ id, title, status, detail });

  // (a) the instrumented build does not distort /db/read
  const cal = runs.filter((r) => r.case === CALIBRATION_CASE);
  if (cal.length === 0) add("a", "計測が測定を歪めない（較正の /db/read）", "na", "較正のケースなし");
  else {
    const rows = Object.entries(REFERENCE_P50_MS).map(([name, ref]) => {
      const p50s = cal.filter((r) => r.name === name).flatMap((r) => r.steps.filter((s) => s.rate >= 50 && s.p50 !== undefined).map((s) => s.p50!));
      return { name, ref, got: p50s.length ? mean(p50s) : undefined };
    });
    const bad = rows.filter((r) => r.got !== undefined && Math.abs(r.got - r.ref) > REFERENCE_TOLERANCE_MS);
    const missing = rows.filter((r) => r.got === undefined);
    add("a", "計測が測定を歪めない（較正の /db/read）", bad.length ? "fail" : missing.length === rows.length ? "na" : "pass", rows.map((r) => `${r.name}: ${r.got === undefined ? "-" : r.got.toFixed(1)} ms（参考 ${r.ref}、許容 ±${REFERENCE_TOLERANCE_MS}）`).join("、"));
  }

  // (b) the breakdown closes
  const steps = runs.flatMap((r) => r.steps);
  const count = steps.reduce((n, s) => n + s.appCount, 0);
  const inconsistent = steps.reduce((n, s) => n + s.inconsistent, 0);
  add(
    "b",
    "内訳が閉じる（appMs ≤ serviceMs）",
    count === 0 ? "fail" : inconsistent / count <= MAX_INCONSISTENT_SHARE ? "pass" : "fail",
    count === 0 ? "応答に appMs がない" : `${inconsistent} / ${count} 件が矛盾（許容 ${MAX_INCONSISTENT_SHARE * 100}%）`,
  );

  // (c) generator not saturated, no late/dropped sends, exit code 0 -- for the measured sets
  const cBad = m.filter((r) => r.reasons.some((x) => !x.startsWith("版の不一致")));
  add("c", "生成側・送信・終了コード", cBad.length ? "fail" : "pass", cBad.length ? cBad.map((r) => `${label(r)}: ${r.reasons.join("、")}`).join(" / ") : `測定した ${m.length} 回すべて基準内`);

  // (d) every response came from the planned build
  const dBad = runs.filter((r) => r.reasons.some((x) => x.startsWith("版の不一致")));
  const seen = [...new Set(runs.flatMap((r) => r.steps.flatMap((s) => s.builds)))];
  add("d", "版の一致", dBad.length || seen.length === 0 ? "fail" : "pass", `期待 ${analysis.plan.plan.build}、観測 ${seen.join("、") || "なし"}`);

  // (e) sent == requests counted by the platform
  const eBad = runs.filter((r) => {
    const expected = r.total.sent - r.total.notCounted;
    return expected > 0 && Math.abs(r.total.lambdaRequests - expected) / expected > 0.001;
  });
  add("e", "送信数と AWS 側の件数の一致", eBad.length ? "fail" : "pass", eBad.length ? eBad.map((r) => `${label(r)}: 送信 ${r.total.sent}、AWS 側 ${Math.round(r.total.lambdaRequests)}`).join(" / ") : `${runs.length} 回すべて 0.1% 以内`);

  // (f) repeatability between the measured sets
  const cells = new Map<string, number[]>();
  for (const r of m) {
    if (r.case === CALIBRATION_CASE) continue;
    r.steps.forEach((s, i) => {
      if (s.adopted && s.p50 !== undefined) cells.set(`${r.case}/${r.name}/${s.rate}#${i}`, [...(cells.get(`${r.case}/${r.name}/${s.rate}#${i}`) ?? []), s.p50]);
    });
  }
  const fBad = [...cells.entries()].filter(([, v]) => v.length >= 2 && Math.max(...v) - Math.min(...v) > MAX_SET_DIFFERENCE_MS);
  add("f", "セット間の p50 の差が 2 ms 以内", fBad.length ? "note" : "pass", fBad.length ? `${fBad.length} / ${cells.size} の段で超過（注記する）: ${fBad.slice(0, 6).map(([k]) => k.split("#")[0]).join("、")}${fBad.length > 6 ? " ほか" : ""}` : `${cells.size} の段すべて以内`);

  // (g) each case reached the contention point it was designed for
  for (const id of [...new Set(m.map((r) => r.case))].sort()) {
    const rule = REACH[id];
    if (!rule) continue;
    const r = rule(m.filter((x) => x.case === id && x.adopted));
    add(`g:${id}`, `ケース ${id} が競合の点に到達した`, r.reached ? "pass" : "hold", r.detail);
  }
  return { pass: !checks.some((c) => c.status === "fail"), checks };
}

export function evaluateDir(dir: string): Verdict {
  return verdictOf(analyzeDir(dir));
}

// ---- rendering ----
const fmt = (n: number | undefined, d = 1) => (n === undefined ? "-" : n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
const usd = (n: number, d = 4) => `$${n.toFixed(d)}`;

function table(header: string[], rows: string[][]): string {
  return [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

/** One row per configuration, one column per step; each cell lists the adopted sets' values joined by " ; ". */
function perStep(runs: RunOut[], pick: (s: StepOut, r: RunOut) => string): string {
  if (runs.length === 0) return "（該当なし）";
  const rates = runs[0].steps.map((s) => s.rate);
  const names = [...new Set(runs.map((r) => r.name))];
  const rows = names.map((name) => {
    const rs = runs.filter((r) => r.name === name).sort((a, b) => a.set - b.set);
    return [name, ...rates.map((_, i) => rs.map((r) => (r.steps[i] ? pick(r.steps[i], r) : "-")).join(" ; "))];
  });
  return table(["構成", ...rates.map((r, i) => `${i + 1}: ${r} RPS`)], rows);
}

export function render(analysis: Analysis, sets: number[]): string {
  const all = analysis.runs;
  const adopted = all.filter((r) => r.adopted && sets.includes(r.set));
  const out: string[] = [];
  out.push(
    "## 採用の判定",
    table(["ケース", "セット", "#", "構成", "生成側のコア", "判定"], all.map((r) => [r.case, String(r.set), String(r.index), r.name, fmt(r.loadgenCores, 2), r.adopted && sets.includes(r.set) ? "採用" : `不採用: ${r.reasons.join("、") || "対象外のセット"}`])),
  );

  for (const id of [...new Set(adopted.map((r) => r.case))].sort()) {
    const rs = adopted.filter((r) => r.case === id);
    const spec = analysis.plan.plan.cases[id];
    out.push(`# ケース ${id}`, `\`${spec?.mix ?? spec?.path ?? ""}\` 段: ${spec?.steps.join("・")} RPS × ${spec?.stepSeconds} 秒。表の値は、採用したセットを「 ; 」で区切って小さい番号から並べる。`);
    out.push("## p50 (ms)", perStep(rs, (s) => fmt(s.p50)), "## p99 (ms)", perStep(rs, (s) => fmt(s.p99)));
    out.push("## 成功 / 送信", perStep(rs, (s) => `${s.ok} of ${s.sent}${s.fail53400 ? ` (53400: ${s.fail53400})` : ""}${s.failOther ? ` (他: ${JSON.stringify(s.failures)})` : ""}`));
    out.push("## 内訳 p50 (ms): DB の接続取得 + クエリ | アプリ内の DB 以外 | アプリの外", perStep(rs, (s) => `${fmt(s.acquireP50)}+${fmt(s.queryP50)} | ${fmt(s.appOtherP50)} | ${fmt(s.outsideP50)}`));
    out.push("## 環境数（コールドスタート）/ 同時実行・稼働環境の最大", perStep(rs, (s) => `${s.environments}(${s.coldStarts}) / ${fmt(s.concurrentMax, 0)}`));
    out.push("## プール: 待ちの最大 / 接続数の最大（プールのある構成）", perStep(rs.filter((r) => r.steps.some((s) => s.poolTotalMax !== undefined)), (s) => `${s.poolWaitingMax ?? "-"} / ${s.poolTotalMax ?? "-"}`));

    if (rs.some((r) => r.steps.some((s) => s.byPath))) {
      const paths = [...new Set(rs.flatMap((r) => r.steps.flatMap((s) => Object.keys(s.byPath ?? {}))))].sort();
      const names = [...new Set(rs.map((r) => r.name))];
      const lastIdx = (r: RunOut) => r.steps.length - 1;
      for (const [title, pick] of [
        ["p50 (ms)", (p: PathOut) => fmt(p.p50)],
        ["p99 (ms)", (p: PathOut) => fmt(p.p99)],
        ["アプリ内の DB 以外 p50 (ms)", (p: PathOut) => fmt(p.appOtherP50)],
      ] as const) {
        out.push(
          `## エンドポイント別 ${title}（最終段、${rs[0].steps[lastIdx(rs[0])]?.rate} RPS）`,
          table(["エンドポイント", ...names], paths.map((p) => [p, ...names.map((n) => rs.filter((r) => r.name === n).sort((a, b) => a.set - b.set).map((r) => (r.steps[lastIdx(r)]?.byPath?.[p] ? pick(r.steps[lastIdx(r)].byPath![p]) : "-")).join(" ; "))])),
        );
      }
    }
  }

  out.push(
    "## DB: 接続の試行（CallCount）、DPU（1 回の合計）",
    table(
      ["ケース", "構成", "セット", "送信", "CallCount", "DPU", "DPU/成功1件"],
      adopted.map((r) => [r.case, r.name, String(r.set), String(r.total.sent), fmt(r.total.dsqlConnectCalls, 0), fmt(r.total.dpu, 1), fmt(r.total.dpu / Math.max(1, r.total.ok), 4)]),
    ),
    "## 1 回あたりのコスト（採用したセットの平均、USD）。Event は REPORT の課金時間があればそれで計算し、近似との差も出す",
    table(
      ["ケース", "構成", "リクエスト", "CPU/時間", "メモリ", "DSQL", "合計", "100 万件あたり", "近似の合計（Event）", "初期化 p50 (ms)"],
      [...new Set(adopted.map((r) => `${r.case}/${r.name}`))].sort().map((key) => {
        const rs = adopted.filter((r) => `${r.case}/${r.name}` === key);
        const c = (k: keyof Cost) => mean(rs.map((r) => (r.total.costBilled ?? r.total.cost)[k]));
        const sent = mean(rs.map((r) => r.total.sent));
        return [rs[0].case, rs[0].name, usd(c("requests")), usd(c("compute")), usd(c("memory")), usd(c("dsql")), usd(c("total")), usd((c("total") / sent) * 1e6, 2), rs[0].total.costBilled ? usd(mean(rs.map((r) => r.total.cost.total))) : "-", fmt(mean(rs.map((r) => r.total.initP50Ms ?? 0)), 0)];
      }),
    ),
    "## 突き合わせ: クライアントの送信数と、AWS 側のリクエスト数",
    table(["ケース", "セット", "#", "構成", "送信", "AWS 側", "差", "AWS が数えない失敗"], all.map((r) => [r.case, String(r.set), String(r.index), r.name, String(r.total.sent), fmt(r.total.lambdaRequests, 0), fmt(r.total.lambdaRequests - r.total.sent, 0), String(r.total.notCounted)])),
  );
  const lambdaDsql = all.reduce((n, r) => n + (r.total.costBilled ?? r.total.cost).total, 0);
  out.push(
    "## 全体の費用（概算）",
    table(["項目", "USD"], [["Lambda + DSQL（全回）", usd(lambdaDsql, 2)], ["Fargate（タスクの実行時間 × 単価）", usd(analysis.fargateUsd, 2)], ["合計", usd(lambdaDsql + analysis.fargateUsd, 2)]]),
  );
  return out.join("\n\n");
}

export function renderVerdict(v: Verdict): string {
  return [`## 合格基準の判定: ${v.pass ? "通過" : "不合格"}`, table(["", "項目", "結果", "詳細"], v.checks.map((c) => [c.id, c.title, c.status, c.detail]))].join("\n\n");
}
