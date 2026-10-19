import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { postProcess, type InsightsRows, type PostDeps } from "../scripts/suite-post.js";
import { parseSuiteLog, runPrefix, type LogEvent } from "../scripts/suite-files.js";
import { buildPlan, type CaseDef } from "../scripts/suite-plan.js";
import type { RunRecord } from "../scripts/suite-runner.js";

const cases: CaseDef[] = [{ id: "T", path: "/noop", configs: ["event-dsql-reuse", "web-dsql-pool10"], steps: [25], stepSeconds: 90 }];
const plan = buildPlan({
  protocol: "t",
  sets: [2],
  seed: "s",
  build: "b1",
  urls: { "event-dsql-reuse": "https://e.example", "web-dsql-pool10": "https://w.example" },
  cases,
  firstWait: 60,
  post: { clusterId: "cid", metricsLagSeconds: 180 },
});

const at = (iso: string) => new Date(iso).toISOString();
const records: RunRecord[] = plan.runs.map((run, i) => ({
  run,
  startedAt: at(`2026-10-19T0${i}:00:00Z`),
  endedAt: at(`2026-10-19T0${i}:10:00Z`),
  result: { exitCode: 0, timedOut: false, aborted: false },
  lines: [`RESULT_JSON ${JSON.stringify({ startedAt: at(`2026-10-19T0${i}:00:00Z`), steps: [{ rate: 25 }] })}`],
}));
const lastEnd = Date.parse(records[records.length - 1].endedAt);

function fakeDeps(over: Partial<PostDeps> = {}) {
  const lines: string[] = [];
  const sleeps: number[] = [];
  const metricCalls: { functions: string[]; start: string; end: string }[] = [];
  const insights: { logGroup: string; start: number; end: number }[] = [];
  const dirs: string[] = [];
  const deps: PostDeps = {
    now: () => new Date(lastEnd + 60_000),
    sleep: async (ms) => void sleeps.push(ms),
    log: (l) => lines.push(l),
    getMetrics: async (queries, start, end) => {
      metricCalls.push({ functions: [...new Set(queries.map((q) => q.label).filter((l) => l.startsWith("gekko10-")))], start, end });
      return [{ Id: "m0", Timestamps: [new Date(lastEnd)], Values: [7] }];
    },
    runInsights: async (logGroup, start, end): Promise<InsightsRows> => {
      insights.push({ logGroup, start, end });
      return [[{ field: "invocations", value: "2250" }, { field: "billedMs", value: "9000" }, { field: "coldStarts", value: "3" }]];
    },
    makeWorkDir: () => {
      const d = mkdtempSync(path.join(tmpdir(), "suite-post-test-"));
      dirs.push(d);
      return d;
    },
    evaluate: () => ({ pass: true, checks: [{ id: "b", title: "t", status: "pass", detail: "d" }] }),
    ...over,
  };
  return { deps, lines, sleeps, metricCalls, insights, dirs };
}

describe("postProcess", () => {
  it("waits until the metrics of the last run's window have arrived", async () => {
    const { deps, sleeps } = fakeDeps();
    await postProcess(plan, records, "2026-10-19T00:00:00.000Z", new AbortController().signal, deps);
    // the window ends 8 minutes after the last run; the metrics lag 180 s on top; one minute has passed already
    expect(sleeps).toEqual([8 * 60_000 + 180_000 - 60_000]);
  });

  it("does not wait when everything has arrived already", async () => {
    const { deps, sleeps } = fakeDeps({ now: () => new Date(lastEnd + 60 * 60_000) });
    await postProcess(plan, records, "x", new AbortController().signal, deps);
    expect(sleeps).toEqual([]);
  });

  it("collects each run's own function and the DSQL cluster, and the REPORT summary for Event runs only", async () => {
    const { deps, metricCalls, insights } = fakeDeps();
    await postProcess(plan, records, "2026-10-19T00:00:00.000Z", new AbortController().signal, deps);
    expect(metricCalls.map((c) => c.functions)).toEqual(plan.runs.map((r) => [`gekko10-${r.name}`]));
    expect(insights.map((i) => i.logGroup)).toEqual(["/aws/lambda/gekko10-event-dsql-reuse"]);
    const event = records.find((r) => r.run.name.startsWith("event-"))!;
    expect(insights[0].start).toBe(Date.parse(event.startedAt) - 60_000);
    expect(insights[0].end).toBe(Date.parse(event.endedAt) + 3 * 60_000);
  });

  it("logs the metrics, the reports and the verdict, in a form suite-fetch reads back into the same files", async () => {
    const { deps, lines } = fakeDeps();
    await postProcess(plan, records, "2026-10-19T00:00:00.000Z", new AbortController().signal, deps);
    expect(lines.at(-1)!.startsWith("SUITE_VERDICT ")).toBe(true);

    const events: LogEvent[] = lines.map((message, i) => ({ timestamp: i, message }));
    const parsed = parseSuiteLog(events);
    expect(parsed.verdict).toMatchObject({ pass: true });
    const eventPrefix = `T-set2-${plan.runs.findIndex((r) => r.name.startsWith("event-")) + 1}-event-dsql-reuse`;
    const webPrefix = `T-set2-${plan.runs.findIndex((r) => r.name.startsWith("web-")) + 1}-web-dsql-pool10`;
    expect([...parsed.metrics.keys()].sort()).toEqual([eventPrefix, webPrefix].sort());
    expect([...parsed.reports.keys()]).toEqual([eventPrefix]);
    expect(JSON.parse(parsed.reports.get(eventPrefix)!).stats).toMatchObject({ invocations: 2250, billedMs: 9000, coldStarts: 3 });
    expect(JSON.parse(parsed.metrics.get(webPrefix)!)).toMatchObject({ clusterId: "cid", region: "ap-northeast-1" });
  });

  it("writes the result directory the analysis reads, and evaluates it", async () => {
    let evaluated = "";
    const { deps, dirs } = fakeDeps({
      evaluate: (dir) => {
        evaluated = dir;
        return { pass: true, checks: [] };
      },
    });
    await postProcess(plan, records, "2026-10-19T00:00:00.000Z", new AbortController().signal, deps);
    expect(evaluated).toBe(dirs[0]);
    expect(existsSync(path.join(evaluated, "suite.plan.json"))).toBe(true);
    expect(existsSync(path.join(evaluated, "suite-set2.manifest.jsonl"))).toBe(true);
    for (const r of records) {
      const prefix = runPrefix({ begin: { ...r.run, startedAt: r.startedAt } });
      expect(existsSync(path.join(evaluated, `${prefix}.metrics.json`))).toBe(true);
      expect(readFileSync(path.join(evaluated, `${prefix}.json`), "utf8")).toContain("rate");
    }
  });

  it("stops without a verdict when aborted while waiting, and does nothing without a post configuration", async () => {
    const controller = new AbortController();
    const first = fakeDeps({
      sleep: async () => {
        controller.abort("SIGTERM");
      },
    });
    await postProcess(plan, records, "x", controller.signal, first.deps);
    expect(first.lines.some((l) => l.startsWith("SUITE_VERDICT"))).toBe(false);
    expect(first.metricCalls).toEqual([]);

    const second = fakeDeps();
    await postProcess({ ...plan, post: undefined }, records, "x", new AbortController().signal, second.deps);
    expect(second.lines).toEqual([]);
  });
});
