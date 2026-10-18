// Collects the CloudWatch metrics needed to analyse a load test run, for a time window, at 1-minute resolution.
// Usage: npm run collect-metrics -- --start 2026-10-18T10:00:00Z --end 2026-10-18T10:30:00Z --out results/2026-10-18/p1-web-pool.metrics.json
//        [--functions gekko10-web-dsql-pool,gekko10-event-dsql-reuse]   (default: all six)
// Metrics lag by a few minutes, so collect some time after the run.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const REGION = "ap-northeast-1";
const PERIOD = 60;
const ALL_FUNCTIONS = [
  "gekko10-event-noop",
  "gekko10-event-dsql-each",
  "gekko10-event-dsql-reuse",
  "gekko10-web-noop",
  "gekko10-web-dsql-each",
  "gekko10-web-dsql-pool",
];

const { values } = parseArgs({
  options: { start: { type: "string" }, end: { type: "string" }, out: { type: "string" }, functions: { type: "string" } },
});
if (!values.start || !values.end || !values.out) {
  console.error("usage: collect-metrics --start <ISO> --end <ISO> --out <file> [--functions a,b]");
  process.exit(2);
}

const aws = (...args: string[]) => execFileSync("aws", [...args, "--region", REGION], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

const clusterId = aws(
  "cloudformation",
  "describe-stacks",
  "--stack-name",
  "Gekko10DbStack",
  "--query",
  "Stacks[0].Outputs[?OutputKey=='Identifier'].OutputValue | [0]",
  "--output",
  "text",
).trim();

interface Query {
  label: string;
  namespace: string;
  metric: string;
  stat: string;
  dims: Record<string, string>;
}
const queries: Query[] = [];
const add = (namespace: string, metric: string, stats: string[], dims: Record<string, string>, label: string) => {
  for (const stat of stats) queries.push({ label, namespace, metric, stat, dims });
};

const functions = values.functions ? values.functions.split(",") : ALL_FUNCTIONS;
for (const fn of functions) {
  if (fn.startsWith("gekko10-event-")) {
    const d = { FunctionName: fn };
    add("AWS/Lambda", "Invocations", ["Sum"], d, fn);
    add("AWS/Lambda", "Errors", ["Sum"], d, fn);
    add("AWS/Lambda", "Throttles", ["Sum"], d, fn);
    add("AWS/Lambda", "ConcurrentExecutions", ["Maximum"], d, fn);
    add("AWS/Lambda", "Duration", ["Sum", "Average", "Maximum"], d, fn);
    add("AWS/Lambda", "UrlRequestCount", ["Sum"], d, fn);
    add("AWS/Lambda", "UrlRequestLatency", ["Average", "Maximum"], d, fn);
  } else {
    const endpoint = { FunctionName: fn, EndpointName: "main" };
    add("AWS/Lambda/Web", "ExecutedRequests", ["Sum"], endpoint, fn);
    add("AWS/Lambda/Web", "HTTPResponseStatusClass4XX", ["Sum"], endpoint, fn);
    add("AWS/Lambda/Web", "HTTPResponseStatusClass5XX", ["Sum"], endpoint, fn);
    const f = { FunctionName: fn };
    add("AWS/Lambda/Web", "EnvironmentActiveTime", ["Sum"], f, fn);
    add("AWS/Lambda/Web", "EnvironmentCPUTime", ["Sum"], f, fn);
    add("AWS/Lambda/Web", "EnvironmentMaxMemoryUsage", ["Maximum", "Average"], f, fn);
    add("AWS/Lambda/Web", "EnvironmentConcurrentRequests", ["Maximum"], f, fn);
    add("AWS/Lambda/Web", "ResponseBytes", ["Sum"], f, fn);
    const usage = { ...endpoint, ExecutionRegion: REGION };
    add("AWS/Lambda/Web/Usage", "EndpointActiveEnvironments", ["Maximum"], usage, fn);
    for (const m of [
      "EndpointRequestThrottles",
      "AccountRequestThrottles",
      "EndpointActiveEnvironmentThrottles",
      "AccountActiveVCPUArm64Throttles",
    ]) {
      add("AWS/Lambda/Web/Usage", m, ["Sum"], usage, fn);
    }
  }
}

// DSQL (the cluster is shared by all functions): connection attempts, open connections, DPU.
const usageDims = (resource: string, type: string) => ({
  Type: type,
  ResourceId: `cluster/${clusterId}`,
  Resource: resource,
  Service: "AuroraDSQL",
  Class: "None",
});
add("AWS/Usage", "CallCount", ["Sum", "Maximum"], usageDims("DbConnectAdmin", "API"), "dsql:connect-attempts");
add("AWS/Usage", "ResourceCount", ["Maximum"], usageDims("ClusterConnectionCount", "Resource"), "dsql:open-connections");
for (const m of ["TotalDPU", "ComputeDPU", "ReadDPU", "WriteDPU", "TotalTransactions", "ReadOnlyTransactions", "OccConflicts", "QueryTimeouts"]) {
  add("AWS/AuroraDSQL", m, ["Sum"], { ClusterId: clusterId }, "dsql");
}
add("AWS/AuroraDSQL", "CommitLatency", ["Average"], { ClusterId: clusterId }, "dsql");

const metricDataQueries = queries.map((q, i) => ({
  Id: `m${i}`,
  Label: `${q.label} ${q.metric} ${q.stat}`,
  MetricStat: {
    Metric: { Namespace: q.namespace, MetricName: q.metric, Dimensions: Object.entries(q.dims).map(([Name, Value]) => ({ Name, Value })) },
    Period: PERIOD,
    Stat: q.stat,
  },
  ReturnData: true,
}));
const dir = mkdtempSync(path.join(tmpdir(), "collect-metrics-"));
const file = path.join(dir, "queries.json");
writeFileSync(file, JSON.stringify(metricDataQueries));

const raw = JSON.parse(
  aws("cloudwatch", "get-metric-data", "--start-time", values.start, "--end-time", values.end, "--scan-by", "TimestampAscending", "--metric-data-queries", `file://${file}`, "--output", "json"),
);
const results = new Map<string, { Timestamps: string[]; Values: number[] }>();
for (const r of raw.MetricDataResults as { Id: string; Timestamps: string[]; Values: number[] }[]) {
  const prev = results.get(r.Id);
  results.set(r.Id, prev ? { Timestamps: [...prev.Timestamps, ...r.Timestamps], Values: [...prev.Values, ...r.Values] } : r);
}

const series = queries.map((q, i) => {
  const r = results.get(`m${i}`);
  return {
    label: q.label,
    namespace: q.namespace,
    metric: q.metric,
    stat: q.stat,
    dimensions: q.dims,
    points: (r?.Timestamps ?? []).map((t, j) => [t, r!.Values[j]]),
  };
});
mkdirSync(path.dirname(values.out), { recursive: true });
writeFileSync(values.out, JSON.stringify({ region: REGION, periodSeconds: PERIOD, start: values.start, end: values.end, clusterId, series }, null, 1));
const withData = series.filter((s) => s.points.length > 0).length;
console.log(`saved ${values.out}: ${series.length} series, ${withData} with data`);
