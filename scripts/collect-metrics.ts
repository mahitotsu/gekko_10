// Collects the CloudWatch metrics needed to analyse a load test run, for a time window, at 1-minute resolution.
// Usage: npm run collect-metrics -- --start 2026-10-18T10:00:00Z --end 2026-10-18T10:30:00Z --out results/2026-10-18/A-set2-1-web-dsql-pool10.metrics.json
//        [--functions gekko10-web-dsql-pool,gekko10-event-dsql-reuse]   (default: all)
// Metrics lag by a few minutes, so collect some time after the run. (The load task collects them itself, scripts/suite-post.ts;
// this script is for collecting by hand, with the AWS CLI.)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { ALL_FUNCTIONS, REGION, assembleMetrics, buildQueries, metricDataQueries, type MetricDataResult } from "./metrics-lib.js";

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

const queries = buildQueries(values.functions ? values.functions.split(",") : ALL_FUNCTIONS, clusterId);
const dir = mkdtempSync(path.join(tmpdir(), "collect-metrics-"));
const file = path.join(dir, "queries.json");
writeFileSync(file, JSON.stringify(metricDataQueries(queries)));

const raw = JSON.parse(
  aws("cloudwatch", "get-metric-data", "--start-time", values.start, "--end-time", values.end, "--scan-by", "TimestampAscending", "--metric-data-queries", `file://${file}`, "--output", "json"),
) as { MetricDataResults: MetricDataResult[] };

const out = assembleMetrics(queries, raw.MetricDataResults, { start: values.start, end: values.end, clusterId });
mkdirSync(path.dirname(values.out), { recursive: true });
writeFileSync(values.out, JSON.stringify(out, null, 1));
console.log(`saved ${values.out}: ${out.series.length} series, ${out.series.filter((s) => s.points.length > 0).length} with data`);
