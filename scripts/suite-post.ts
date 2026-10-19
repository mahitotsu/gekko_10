// Post-processing inside the load task, after the last run: waits until the CloudWatch metrics of every run have arrived,
// collects them (and, for Event Functions, the summary of their REPORT lines), writes the result files exactly as
// scripts/suite-fetch.ts would, analyses them (scripts/analyze.ts) and logs the verdict. Everything is logged (SUITE_METRICS,
// SUITE_REPORTS, SUITE_VERDICT), so a later fetch only has to read the log.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand } from "@aws-sdk/client-cloudwatch-logs";
import { evaluateDir, type Verdict } from "./analyze.js";
import { REGION, assembleMetrics, buildQueries, metricDataQueries, type MetricDataResult, type Query } from "./metrics-lib.js";
import { REPORT_QUERY, parseReportRows, type ReportsFile } from "./reports-lib.js";
import type { RunRecord } from "./suite-runner.js";
import { WINDOW_AFTER_MS, chunkLines, functionOf, isEvent, metricsWindow, runPrefix, writeResults, type FetchedRun, type ParsedLog } from "./suite-files.js";
import type { Plan } from "./suite-plan.js";

export type InsightsRows = { field?: string; value?: string }[][];

export interface PostDeps {
  now(): Date;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  log(line: string): void;
  getMetrics(queries: Query[], start: string, end: string): Promise<MetricDataResult[]>;
  runInsights(logGroup: string, startMs: number, endMs: number): Promise<InsightsRows>;
  makeWorkDir(): string;
  evaluate(dir: string): Verdict;
}

const toFetched = (r: RunRecord): FetchedRun => ({
  begin: { ...r.run, startedAt: r.startedAt },
  end: { exitCode: r.result.exitCode, timedOut: r.result.timedOut, aborted: r.result.aborted, endedAt: r.endedAt },
  lines: r.lines,
});

/** REPORT lines of one run: a little before it starts to a little after it ends (requests answered late). */
const REPORT_BEFORE_MS = 60_000;
const REPORT_AFTER_MS = 3 * 60_000;

export async function postProcess(plan: Plan, records: RunRecord[], startedAt: string, signal: AbortSignal, deps: PostDeps): Promise<void> {
  if (!plan.post) return;
  const lastEnd = Math.max(...records.map((r) => Date.parse(r.endedAt)));
  // The last run's window ends WINDOW_AFTER_MS after it; the metrics of that minute arrive a few minutes later still.
  const readyAt = lastEnd + WINDOW_AFTER_MS + plan.post.metricsLagSeconds * 1000;
  const waitMs = readyAt - deps.now().getTime();
  if (waitMs > 0) {
    deps.log(`SUITE_POST_WAIT ${JSON.stringify({ seconds: Math.round(waitMs / 1000), until: new Date(readyAt).toISOString() })}`);
    await deps.sleep(waitMs, signal);
    if (signal.aborted) return;
  }

  const fetched = records.map(toFetched);
  const metrics = new Map<string, string>();
  const reports = new Map<string, string>();
  for (const run of fetched) {
    const prefix = runPrefix(run);
    const w = metricsWindow(run);
    const queries = buildQueries([functionOf(run.begin.name)], plan.post.clusterId);
    const results = await deps.getMetrics(queries, w.start, w.end);
    const text = JSON.stringify(assembleMetrics(queries, results, { start: w.start, end: w.end, clusterId: plan.post.clusterId }), null, 1);
    metrics.set(prefix, text);
    for (const l of chunkLines("SUITE_METRICS", prefix, text)) deps.log(l);

    if (isEvent(run.begin.name)) {
      const start = Date.parse(run.begin.startedAt) - REPORT_BEFORE_MS;
      const end = Date.parse(run.end!.endedAt) + REPORT_AFTER_MS;
      const logGroup = `/aws/lambda/${functionOf(run.begin.name)}`;
      const file: ReportsFile = {
        logGroup,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        stats: parseReportRows(await deps.runInsights(logGroup, start, end)),
      };
      const reportText = JSON.stringify(file, null, 1);
      reports.set(prefix, reportText);
      for (const l of chunkLines("SUITE_REPORTS", prefix, reportText)) deps.log(l);
    }
  }

  const parsed: ParsedLog = {
    start: { startedAt, expectedSeconds: 0, plan },
    runs: fetched,
    status: "done",
    metrics,
    reports,
  };
  const dir = deps.makeWorkDir();
  writeResults(dir, parsed, "in-task");
  const verdict = deps.evaluate(dir);
  deps.log(`SUITE_VERDICT ${JSON.stringify(verdict)}`);
}

// ---- real dependencies ----
const sleepReal = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

export function realDeps(): PostDeps {
  const cw = new CloudWatchClient({ region: REGION });
  const logs = new CloudWatchLogsClient({ region: REGION });
  return {
    now: () => new Date(),
    sleep: sleepReal,
    log: (l) => console.log(l),
    async getMetrics(queries, start, end) {
      const out: MetricDataResult[] = [];
      let token: string | undefined;
      do {
        const r = await cw.send(
          new GetMetricDataCommand({ StartTime: new Date(start), EndTime: new Date(end), ScanBy: "TimestampAscending", MetricDataQueries: metricDataQueries(queries), NextToken: token }),
        );
        out.push(...(r.MetricDataResults ?? []));
        token = r.NextToken;
      } while (token);
      return out;
    },
    async runInsights(logGroup, startMs, endMs) {
      const { queryId } = await logs.send(
        new StartQueryCommand({ logGroupName: logGroup, startTime: Math.floor(startMs / 1000), endTime: Math.ceil(endMs / 1000), queryString: REPORT_QUERY }),
      );
      for (let i = 0; i < 150; i++) {
        const r = await logs.send(new GetQueryResultsCommand({ queryId }));
        if (r.status === "Complete") return (r.results ?? []) as InsightsRows;
        if (r.status === "Failed" || r.status === "Cancelled" || r.status === "Timeout") throw new Error(`Logs Insights query ${r.status} for ${logGroup}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      throw new Error(`Logs Insights query did not finish for ${logGroup}`);
    },
    makeWorkDir: () => mkdtempSync(path.join(tmpdir(), "suite-post-")),
    evaluate: evaluateDir,
  };
}

export const runPost = (plan: Plan, records: RunRecord[], startedAt: string, signal: AbortSignal) => postProcess(plan, records, startedAt, signal, realDeps());
