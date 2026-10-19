// Analyses a suite's result directory: tables, costs and the acceptance verdict (scripts/analyze.ts). Reads files only; no AWS calls.
// Usage: npm run analyze -- results/2026-10-19 [--sets 2,3] [--json <file>]   (default: analysis.json in the directory)
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { PRICE, analyzeDir, render, renderVerdict, verdictOf } from "./analyze.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { sets: { type: "string" }, json: { type: "string" } } });
const dir = positionals[0];
if (!dir) {
  console.error("usage: analyze <results dir> [--sets 2,3] [--json file]");
  process.exit(2);
}
const analysis = analyzeDir(dir);
const sets = values.sets ? values.sets.split(",").map(Number) : [...new Set(analysis.runs.map((r) => r.set))].filter((s) => s !== 1);
const verdict = verdictOf(analysis);
console.log(render(analysis, sets));
console.log(renderVerdict(verdict));
writeFileSync(values.json ?? path.join(dir, "analysis.json"), JSON.stringify({ sets, prices: PRICE, verdict, ...analysis }, null, 1));
