// Which CloudWatch metrics describe a load test run, and how to turn the answers into a metrics file.
// Pure: the callers fetch (scripts/collect-metrics.ts with the AWS CLI; scripts/suite-post.ts with the SDK inside the load task).
export const REGION = "ap-northeast-1";
export const PERIOD = 60;
export const ALL_FUNCTIONS = [
  "gekko10-event-noop",
  "gekko10-event-dsql-each",
  "gekko10-event-dsql-reuse",
  "gekko10-web-noop",
  "gekko10-web-dsql-each",
  "gekko10-web-dsql-pool",
  "gekko10-web-dsql-pool10",
];

export interface Query {
  label: string;
  namespace: string;
  metric: string;
  stat: string;
  dims: Record<string, string>;
}

export function buildQueries(functions: string[], clusterId: string): Query[] {
  const queries: Query[] = [];
  const add = (namespace: string, metric: string, stats: string[], dims: Record<string, string>, label: string) => {
    for (const stat of stats) queries.push({ label, namespace, metric, stat, dims });
  };

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
      for (const m of ["EndpointRequestThrottles", "AccountRequestThrottles", "EndpointActiveEnvironmentThrottles", "AccountActiveVCPUArm64Throttles"]) {
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
  return queries;
}

/** The MetricDataQuery list of GetMetricData (same shape for the CLI's JSON and the SDK). Ids are "m<index>". */
export const metricDataQueries = (queries: Query[]) =>
  queries.map((q, i) => ({
    Id: `m${i}`,
    Label: `${q.label} ${q.metric} ${q.stat}`,
    MetricStat: {
      Metric: { Namespace: q.namespace, MetricName: q.metric, Dimensions: Object.entries(q.dims).map(([Name, Value]) => ({ Name, Value })) },
      Period: PERIOD,
      Stat: q.stat,
    },
    ReturnData: true,
  }));

export interface MetricDataResult {
  Id?: string;
  Timestamps?: (string | Date)[];
  Values?: number[];
}

export interface MetricsFile {
  region: string;
  periodSeconds: number;
  start: string;
  end: string;
  clusterId: string;
  series: { label: string; namespace: string; metric: string; stat: string; dimensions: Record<string, string>; points: [string, number][] }[];
}

/** Pages of one query come back as separate results with the same Id; they are joined here. */
export function assembleMetrics(queries: Query[], results: MetricDataResult[], meta: { start: string; end: string; clusterId: string }): MetricsFile {
  const byId = new Map<string, [string, number][]>();
  for (const r of results) {
    if (!r.Id) continue;
    const points = (r.Timestamps ?? []).map((t, j) => [t instanceof Date ? t.toISOString() : t, r.Values![j]] as [string, number]);
    byId.set(r.Id, [...(byId.get(r.Id) ?? []), ...points]);
  }
  return {
    region: REGION,
    periodSeconds: PERIOD,
    ...meta,
    series: queries.map((q, i) => ({
      label: q.label,
      namespace: q.namespace,
      metric: q.metric,
      stat: q.stat,
      dimensions: q.dims,
      points: (byId.get(`m${i}`) ?? []).sort((a, b) => Date.parse(a[0]) - Date.parse(b[0])),
    })),
  };
}
