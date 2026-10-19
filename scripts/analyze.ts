// Aggregates a P1 run set (results/<date>/p1-*) into tables and costs. It reads only the collected files; it does not call AWS.
// Usage: npm run analyze -- results/2026-10-19 [--sets 2,3] [--json <file>]   (default: p1-analysis.json in the directory)
// Adoption rules: docs/plan.md §8. Prices: docs/findings.md §3-2 and §3-3 (Tokyo, AWS Price List API, fetched 2026-10-18).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

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
/** Expected rounding of billed duration to 1 ms: half a millisecond per invocation on average. */
export const EVENT_ROUNDING_MS = 0.5;
export const CONFIG_ORDER = ["event-noop", "event-dsql-reuse", "event-dsql-each", "web-noop", "web-dsql-pool", "web-dsql-each"];
export const MAX_CORE_RATIO = 0.6;
export const MAX_LATE_OR_DROP = 0.05;

// ---- input shapes ----
export interface StepResult {
  rate: number;
  scheduled: number;
  sent: number;
  dropped: number;
  ok: number;
  failures: Record<string, number>;
  lateRate: number;
  latencyMs: { p50: number; p95: number; p99: number };
  db?: { newConnectionPct: number };
  environments?: number;
  coldStarts?: number;
}
export interface RunResult {
  startedAt: string;
  endedAt: string;
  options: { stepSeconds: number };
  loadgen: { coresUsed: number; coresAvailable: number };
  unfinished: number;
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
  set: number;
  index: number;
  name: string;
  prefix: string;
  startedAt: string;
  stoppedAt: string;
  exitCode: string;
  gapSeconds: number;
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
export function judge(set: number, exitCode: string, result: RunResult): Judgement {
  const reasons: string[] = [];
  if (set === 1) reasons.push("セット 1（ウォームアップ）");
  if (exitCode !== "0") reasons.push(`終了コード ${exitCode}`);
  if (result.unfinished > 0) reasons.push(`未完了 ${result.unfinished} 件`);
  const cores = result.loadgen.coresUsed / result.loadgen.coresAvailable;
  if (cores > MAX_CORE_RATIO) reasons.push(`生成側が飽和（${(cores * 100).toFixed(0)}%）`);
  const runReasons = reasons.length;
  const stepAdopted = result.steps.map((s) => {
    const bad = s.lateRate > MAX_LATE_OR_DROP || (s.scheduled ? s.dropped / s.scheduled : 0) > MAX_LATE_OR_DROP;
    if (bad) reasons.push(`${s.rate} RPS の段は送信の遅れかドロップが 5% 超`);
    return !bad;
  });
  return { adopted: runReasons === 0, reasons, stepAdopted };
}

// ---- per-run analysis ----
export interface StepOut {
  rate: number;
  adopted: boolean;
  sent: number;
  ok: number;
  fail53400: number;
  failOther: number;
  p50: number;
  p95: number;
  p99: number;
  environments: number;
  coldStarts: number;
  newConnectionPct: number | null;
  lateRate: number;
  lambdaRequests: number;
  dsqlConnectCalls: number;
  dsqlConnectionsMax: number;
  dpu: number;
  cost: Cost;
}
export interface RunOut {
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
    dsqlConnectCalls: number;
    dpu: number;
    cost: Cost;
    costWebMemoryMaxBound: number | null;
  };
  gapSeconds: number;
}

/**
 * fnUntil: where this function's own metrics stop belonging to the run (the next run of the same function, if it starts inside the
 * metrics window). dsqlUntil: the same for the cluster-wide DSQL metrics, which any run can affect.
 */
export function analyzeRun(row: ManifestRow, result: RunResult, metrics: Metrics, dsqlUntil: number, fnUntil = Number.MAX_SAFE_INTEGER): RunOut {
  const isWeb = row.name.startsWith("web-");
  const j = judge(row.set, row.exitCode, result);
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
      sent: s.sent,
      ok: s.ok,
      fail53400,
      failOther: failTotal - fail53400,
      p50: s.latencyMs.p50,
      p95: s.latencyMs.p95,
      p99: s.latencyMs.p99,
      environments: s.environments ?? 0,
      coldStarts: s.coldStarts ?? 0,
      newConnectionPct: s.db ? s.db.newConnectionPct : null,
      lateRate: s.lateRate,
      lambdaRequests: req,
      dsqlConnectCalls: allocate(calls, a, Math.min(b, dsqlUntil)),
      dsqlConnectionsMax: maxIn(conns, a, b),
      dpu: allocate(dpu, a, Math.min(b, dsqlUntil)),
      cost: c,
    };
  });

  // Run total: every function-specific minute in the file (includes the ~5 minutes the Web environments linger), DSQL cut at dsqlUntil.
  const end = fnUntil;
  const { cost: total, req: totalReq } = cost(from, Number.MAX_SAFE_INTEGER, dsqlUntil);
  const maxBound = isWeb ? webCost(totalReq, allocate(cpu, from, end), allocate(memGbsMax, from, end), allocate(dpu, from, dsqlUntil)).total : null;
  return {
    set: row.set,
    index: row.index,
    name: row.name,
    adopted: j.adopted,
    reasons: j.reasons,
    loadgenCores: result.loadgen.coresUsed,
    steps,
    total: {
      sent: steps.reduce((n, s) => n + s.sent, 0),
      ok: steps.reduce((n, s) => n + s.ok, 0),
      lambdaRequests: totalReq,
      dsqlConnectCalls: allocate(calls, from, dsqlUntil),
      dpu: allocate(dpu, from, dsqlUntil),
      cost: total,
      costWebMemoryMaxBound: maxBound,
    },
    gapSeconds: row.gapSeconds,
  };
}

export function loadManifest(dir: string): ManifestRow[] {
  return readdirSync(dir)
    .filter((f) => /^p1-set\d+\.manifest\.jsonl$/.test(f))
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

export function analyzeDir(dir: string): { runs: RunOut[]; fargateUsd: number } {
  const rows = loadManifest(dir);
  const runs = rows.map((row, i) => {
    const result = (JSON.parse(readFileSync(path.join(dir, `${row.prefix}.json`), "utf8")) as RunResult[])[0];
    const metrics = JSON.parse(readFileSync(path.join(dir, `${row.prefix}.metrics.json`), "utf8")) as Metrics;
    const sameNext = rows.slice(i + 1).find((r) => r.name === row.name);
    return analyzeRun(row, result, metrics, dsqlCutoff(row, rows[i + 1]), sameNext ? Math.floor(Date.parse(sameNext.startedAt) / PERIOD_MS) * PERIOD_MS : undefined);
  });
  const plan = JSON.parse(readdirSync(dir).filter((f) => f.endsWith(".plan.json")).map((f) => readFileSync(path.join(dir, f), "utf8"))[0]) as { startedAt: string };
  const hours = (Date.parse(rows[rows.length - 1].stoppedAt) - Date.parse(plan.startedAt)) / 3_600_000;
  return { runs, fargateUsd: hours * PRICE.fargateHour };
}

// ---- rendering ----
const fmt = (n: number, d = 1) => n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const usd = (n: number, d = 4) => `$${n.toFixed(d)}`;

function table(header: string[], rows: string[][]): string {
  return [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

/** One row per configuration, one column per rate; each cell lists the adopted sets' values joined by " / ". */
function perRate(runs: RunOut[], pick: (s: StepOut, r: RunOut) => string): string {
  const rates = runs[0].steps.map((s) => s.rate);
  const rows = CONFIG_ORDER.map((name) => {
    const rs = runs.filter((r) => r.name === name).sort((a, b) => a.set - b.set);
    return [name, ...rates.map((_, i) => rs.map((r) => pick(r.steps[i], r)).join(" ; "))];
  });
  return table(["構成", ...rates.map((r) => `${r} RPS`)], rows);
}

export function render(all: RunOut[], sets: number[], fargateUsd: number): string {
  const out: string[] = [];
  const adopted = all.filter((r) => r.adopted && sets.includes(r.set));
  out.push("## 採用の判定", table(["セット", "#", "構成", "生成側のコア", "判定"], all.map((r) => [String(r.set), String(r.index), r.name, fmt(r.loadgenCores, 2), r.adopted && sets.includes(r.set) ? "採用" : `不採用: ${r.reasons.join("、") || "対象外のセット"}`])));
  out.push("## p50 (ms)。セット 2 ; セット 3 の順", perRate(adopted, (s) => fmt(s.p50)));
  out.push("## p99 (ms)", perRate(adopted, (s) => fmt(s.p99)));
  out.push("## 成功件数と送信件数（53400 の失敗数）", perRate(adopted, (s) => `${s.ok} of ${s.sent}${s.fail53400 ? ` (53400: ${s.fail53400})` : ""}${s.failOther ? ` (他: ${s.failOther})` : ""}`));
  out.push("## 環境数（コールドスタート）", perRate(adopted, (s) => `${s.environments}(${s.coldStarts})`));
  out.push("## 新規接続の割合 %, DSQL の接続数（ClusterConnectionCount の最大。1 分に 1 サンプルで、直前の段の接続を含む。参考値）", perRate(adopted.filter((r) => r.name.includes("dsql")), (s) => `${s.newConnectionPct ?? "-"}%, ${fmt(s.dsqlConnectionsMax, 0)}`).split("\n").filter((l) => !/^\| (event|web)-noop/.test(l)).join("\n"));
  out.push(
    "## DSQL: 接続の試行（CallCount）、最大接続数、DPU（1 回の合計。段への配分は 1 分粒度の境界で崩れるので、回の合計で見る）",
    table(
      ["構成", "セット", "送信", "CallCount", "最大接続数", "DPU", "DPU/成功1件"],
      CONFIG_ORDER.filter((n) => n.includes("dsql")).flatMap((n) =>
        adopted
          .filter((r) => r.name === n)
          .sort((a, b) => a.set - b.set)
          .map((r) => [n, String(r.set), String(r.total.sent), fmt(r.total.dsqlConnectCalls, 0), fmt(Math.max(...r.steps.map((s) => s.dsqlConnectionsMax)), 0), fmt(r.total.dpu, 1), fmt(r.total.dpu / r.total.ok, 4)]),
      ),
    ),
  );

  const sums = (name: string) => adopted.filter((r) => r.name === name);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  out.push(
    "## 1 回（7 段、1 構成）あたりのコスト（採用セットの平均、USD）",
    table(
      ["構成", "リクエスト", "CPU/時間", "メモリ", "DSQL", "合計", "メモリ上限で計算した合計", "成功 100 万件あたり", "送信 100 万件あたり", "DPU/成功1件"],
      CONFIG_ORDER.map((n) => {
        const rs = sums(n);
        const c = (k: keyof Cost) => mean(rs.map((r) => r.total.cost[k]));
        const ok = mean(rs.map((r) => r.total.ok));
        const sent = mean(rs.map((r) => r.total.sent));
        return [n, usd(c("requests")), usd(c("compute")), usd(c("memory")), usd(c("dsql")), usd(c("total")), rs[0]?.total.costWebMemoryMaxBound == null ? "-" : usd(mean(rs.map((r) => r.total.costWebMemoryMaxBound ?? 0))), usd((c("total") / ok) * 1e6, 2), usd((c("total") / sent) * 1e6, 2), fmt(mean(rs.map((r) => r.total.dpu)) / ok, 4)];
      }),
    ),
  );
  out.push("## 段ごとのコスト（Lambda のみ・DSQL を除く）送信 100 万件あたり USD（段の時間に配分。負荷の後に残る環境の分は含まない）", perRate(adopted, (s) => usd(((s.cost.total - s.cost.dsql) / s.sent) * 1e6, 2)));
  out.push("## 段ごとの DSQL のコスト 送信 100 万件あたり USD", perRate(adopted, (s) => usd((s.cost.dsql / s.sent) * 1e6, 2)));
  out.push(
    "## 突き合わせ: クライアントの送信数と、AWS 側のリクエスト数（全 18 回）",
    table(["セット", "#", "構成", "送信", "AWS 側", "差"], all.map((r) => [String(r.set), String(r.index), r.name, String(r.total.sent), fmt(r.total.lambdaRequests, 0), fmt(r.total.lambdaRequests - r.total.sent, 0)])),
  );
  const lambdaDsql = all.reduce((n, r) => n + r.total.cost.total, 0);
  const sel = adopted.reduce((n, r) => n + r.total.cost.total, 0);
  out.push(
    "## P1 全体の費用（概算）",
    table(["項目", "USD"], [["Lambda + DSQL（全 18 回）", usd(lambdaDsql, 2)], ["Fargate（タスクの実行時間 × 単価）", usd(fargateUsd, 2)], ["合計", usd(lambdaDsql + fargateUsd, 2)], ["（うち採用した回）", usd(sel, 2)]]),
  );
  return out.join("\n\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { sets: { type: "string", default: "2,3" }, json: { type: "string" } } });
  const dir = positionals[0];
  if (!dir) {
    console.error("usage: analyze <results dir> [--sets 2,3] [--json file]");
    process.exit(2);
  }
  const sets = values.sets!.split(",").map(Number);
  const { runs, fargateUsd } = analyzeDir(dir);
  console.log(render(runs, sets, fargateUsd));
  writeFileSync(values.json ?? path.join(dir, "p1-analysis.json"), JSON.stringify({ sets, fargateUsd, prices: PRICE, runs }, null, 1));
}
