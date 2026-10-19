// Event Functions write one REPORT line per invocation (duration, billed duration, memory, init duration). A CloudWatch Logs
// Insights query summarises them for a run's time window: exact billed time for the cost, and the cold start (init) times.
// Pure: scripts/suite-post.ts runs the query with the SDK.

export const REPORT_QUERY = [
  'filter @type = "REPORT"',
  "| stats count(*) as invocations, sum(@billedDuration) as billedMs, sum(@duration) as durationMs,",
  "pct(@duration, 50) as durationP50, pct(@duration, 99) as durationP99, max(@maxMemoryUsed) as maxMemoryBytes,",
  "count(@initDuration) as coldStarts, avg(@initDuration) as initAvgMs, pct(@initDuration, 50) as initP50, max(@initDuration) as initMaxMs",
].join(" ");

export interface ReportStats {
  invocations: number;
  billedMs: number;
  durationMs: number;
  durationP50: number;
  durationP99: number;
  maxMemoryBytes: number;
  coldStarts: number;
  initAvgMs?: number;
  initP50?: number;
  initMaxMs?: number;
}

export interface ReportsFile {
  logGroup: string;
  start: string;
  end: string;
  stats: ReportStats;
}

/** The first row of a Logs Insights result ([{field, value}, ...]) as numbers. A window with no REPORT lines gives zero invocations. */
export function parseReportRows(rows: { field?: string; value?: string }[][]): ReportStats {
  const row = rows[0] ?? [];
  const n = (field: string): number | undefined => {
    const v = row.find((f) => f.field === field)?.value;
    return v === undefined || v === "" ? undefined : Number(v);
  };
  const stats: ReportStats = {
    invocations: n("invocations") ?? 0,
    billedMs: n("billedMs") ?? 0,
    durationMs: n("durationMs") ?? 0,
    durationP50: n("durationP50") ?? 0,
    durationP99: n("durationP99") ?? 0,
    maxMemoryBytes: n("maxMemoryBytes") ?? 0,
    coldStarts: n("coldStarts") ?? 0,
  };
  for (const key of ["initAvgMs", "initP50", "initMaxMs"] as const) {
    const v = n(key);
    if (v !== undefined && !Number.isNaN(v)) stats[key] = v;
  }
  return stats;
}
