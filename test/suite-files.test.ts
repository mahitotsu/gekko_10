import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPlan, type CaseDef } from "../scripts/suite-plan.js";
import { chunkLines, filesOf, metricsWindow, parseSuiteLog, resultsOf, runPrefix, writeResults, type LogEvent } from "../scripts/suite-files.js";

const plan = buildPlan({
  protocol: "t",
  sets: [1],
  seed: "s1",
  build: "b1",
  urls: { "web-noop": "https://web-noop.example/", "event-dsql-reuse": "https://event-dsql-reuse.example/" },
  cases: [{ id: "T", path: "/noop", configs: ["web-noop", "event-dsql-reuse"], steps: [25], stepSeconds: 90 } as CaseDef],
  firstWait: 60,
});
const [r1, r2] = plan.runs;

const ev = (t: number, message: string): LogEvent => ({ timestamp: t, message });
const begin = (run: typeof r1, at: string) => `SUITE_RUN_BEGIN ${JSON.stringify({ ...run, startedAt: at })}`;
const end = (run: typeof r1, at: string, exitCode: number | null = 0) =>
  `SUITE_RUN_END ${JSON.stringify({ set: run.set, index: run.index, case: run.case, name: run.name, exitCode, timedOut: false, aborted: false, endedAt: at })}`;
const step = (rate: number) => `STEP_JSON ${JSON.stringify({ step: 0, rate, ok: 10, sent: 10 })}`;
const result = (rate: number) => `RESULT_JSON ${JSON.stringify({ target: "t", steps: [{ rate }] })}`;

const events: LogEvent[] = [
  ev(1, `SUITE_PLAN ${JSON.stringify({ startedAt: "2026-10-19T00:00:00.000Z", expectedSeconds: 900, plan })}`),
  ev(2, `SUITE_WAIT ${JSON.stringify({ set: 1, index: 1, name: r1.name, seconds: 60 })}`),
  ev(3, begin(r1, "2026-10-19T00:01:00.000Z")),
  ev(4, step(25)),
  ev(5, "step  rate  sent"),
  ev(6, result(25)),
  ev(7, end(r1, "2026-10-19T00:03:00.000Z")),
  ev(8, `SUITE_WAIT ${JSON.stringify({ set: 1, index: 2, name: r2.name, seconds: 300 })}`),
  ev(9, begin(r2, "2026-10-19T00:08:00.000Z")),
  ev(10, step(25)),
  ev(11, end(r2, "2026-10-19T00:09:30.000Z", 1)),
  ev(12, 'SUITE_DONE {"completed":2}'),
];

describe("parseSuiteLog", () => {
  it("splits the output into runs, keeps each run's own lines, and reads the plan and the final status", () => {
    const p = parseSuiteLog(events);
    expect(p.status).toBe("done");
    expect(p.start?.plan.seed).toBe("s1");
    expect(p.start?.plan.build).toBe("b1");
    expect(p.runs.map((r) => r.begin.name)).toEqual([r1.name, r2.name]);
    expect(p.runs[0].lines).toHaveLength(3);
    expect(p.runs[0].end?.exitCode).toBe(0);
    expect(p.runs[1].end?.exitCode).toBe(1);
  });

  it("sorts events by time, so out-of-order delivery does not mix runs", () => {
    expect(parseSuiteLog([...events].reverse()).runs.map((r) => r.begin.name)).toEqual([r1.name, r2.name]);
  });

  it("reports an aborted task and an incomplete one", () => {
    const aborted = parseSuiteLog([...events.slice(0, 7), ev(8, 'SUITE_ABORTED {"reason":"SIGTERM","completed":1,"of":2}')]);
    expect(aborted.status).toBe("aborted");
    expect(aborted.aborted).toEqual({ reason: "SIGTERM", completed: 1, of: 2 });
    expect(parseSuiteLog(events.slice(0, 7)).status).toBe("incomplete");
  });

  it("keeps a run that has begun but not ended (the task died in the middle)", () => {
    const p = parseSuiteLog(events.slice(0, 5));
    expect(p.runs).toHaveLength(1);
    expect(p.runs[0].end).toBeUndefined();
  });

  it("does not take the post-processing markers for the output of a run", () => {
    const p = parseSuiteLog([...events.slice(0, 11), ev(12, 'SUITE_POST_BEGIN {"at":"x"}'), ev(13, 'SUITE_POST_WAIT {"seconds":5}'), ev(14, "stray line"), ev(15, 'SUITE_DONE {"completed":2}')]);
    expect(p.runs[1].lines).toEqual([step(25)]);
  });
});

describe("chunked payloads and the verdict", () => {
  const prefix = runPrefix(parseSuiteLog(events).runs[0]);

  it("reassembles a payload that was split into chunks, whatever the order they arrived in", () => {
    const text = JSON.stringify({ a: "x".repeat(250) });
    const lines = chunkLines("SUITE_METRICS", prefix, text, 100);
    expect(lines).toHaveLength(Math.ceil(text.length / 100));
    const p = parseSuiteLog([...events, ...lines.map((l, i) => ev(100 - i, l))]);
    expect(p.metrics.get(prefix)).toBe(text);
  });

  it("leaves out a payload with a missing chunk", () => {
    const lines = chunkLines("SUITE_REPORTS", prefix, "y".repeat(250), 100);
    const p = parseSuiteLog([...events, ...lines.slice(0, 2).map((l, i) => ev(100 + i, l))]);
    expect(p.reports.has(prefix)).toBe(false);
  });

  it("reads the verdict and a failure of the post-processing", () => {
    const p = parseSuiteLog([...events, ev(20, 'SUITE_VERDICT {"pass":true,"checks":[]}'), ev(21, 'SUITE_POST_FAILED {"message":"boom"}')]);
    expect(p.verdict).toEqual({ pass: true, checks: [] });
    expect(p.postFailed).toBe("boom");
  });

  it("keeps a payload of one chunk intact when the text contains quotes and newlines", () => {
    const text = JSON.stringify({ s: 'he said "hi"\nline2' }, null, 1);
    const p = parseSuiteLog([...events, ...chunkLines("SUITE_METRICS", prefix, text).map((l, i) => ev(100 + i, l))]);
    expect(p.metrics.get(prefix)).toBe(text);
  });
});

describe("resultsOf / filesOf", () => {
  it("uses RESULT_JSON when present, and the finished steps (partial) when only STEP_JSON is", () => {
    const p = parseSuiteLog(events);
    expect(resultsOf(p.runs[0])).toEqual([{ target: "t", steps: [{ rate: 25 }] }]);
    expect(resultsOf(p.runs[1])).toEqual([{ partial: true, steps: [{ step: 0, rate: 25, ok: 10, sent: 10 }] }]);
  });

  it("names files by case, set, position and configuration, and writes manifest lines with the previous run, the wait and the build", () => {
    const p = parseSuiteLog(events);
    const files = filesOf(p, "task123");
    expect(files.map((f) => f.prefix)).toEqual([`T-set1-1-${r1.name}`, `T-set1-2-${r2.name}`]);
    const m = JSON.parse(files[1].manifestLine);
    expect(m).toMatchObject({ case: "T", set: 1, seed: "s1", build: "b1", index: 2, previous: r1.name, gapSeconds: 300, exitCode: "1" });
    const meta = JSON.parse(files[0].meta);
    expect(meta).toMatchObject({ taskId: "task123", exitCode: "0", complete: true, startedAt: "2026-10-19T00:01:00.000Z" });
    expect(meta.args).toEqual(["https://" + r1.name + ".example", "--path", "/noop", "--steps", "25", "--step-seconds", "90"]);
    expect(files[0].log).toContain("step  rate  sent");
  });

  it("marks a run without an end as incomplete", () => {
    const files = filesOf(parseSuiteLog(events.slice(0, 5)), "t");
    expect(JSON.parse(files[0].meta)).toMatchObject({ complete: false, exitCode: "unknown", stoppedAt: null });
  });
});

describe("metricsWindow", () => {
  it("starts 2 minutes before the run and ends 8 minutes after it", () => {
    expect(metricsWindow(parseSuiteLog(events).runs[0])).toEqual({ start: "2026-10-18T23:59:00Z", end: "2026-10-19T00:11:00Z" });
  });
});

describe("writeResults", () => {
  it("writes the run files, the metrics and reports that arrived, the manifest per set and the plan", () => {
    const prefix1 = `T-set1-1-${r1.name}`;
    const parsed = parseSuiteLog([...events, ...chunkLines("SUITE_METRICS", prefix1, '{"series":[]}').map((l, i) => ev(100 + i, l)), ...chunkLines("SUITE_REPORTS", `T-set1-2-${r2.name}`, '{"stats":{}}').map((l, i) => ev(200 + i, l))]);
    const dir = mkdtempSync(path.join(tmpdir(), "suite-files-"));
    expect(writeResults(dir, parsed, "task123")).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(
      [
        `${prefix1}.json`, `${prefix1}.log`, `${prefix1}.meta.json`, `${prefix1}.metrics.json`,
        `T-set1-2-${r2.name}.json`, `T-set1-2-${r2.name}.log`, `T-set1-2-${r2.name}.meta.json`, `T-set1-2-${r2.name}.reports.json`,
        "suite-set1.manifest.jsonl", "suite.plan.json",
      ].sort(),
    );
    expect(readFileSync(path.join(dir, `${prefix1}.metrics.json`), "utf8")).toBe('{"series":[]}');
    expect(JSON.parse(readFileSync(path.join(dir, "suite.plan.json"), "utf8"))).toMatchObject({ taskId: "task123", plan: { build: "b1" } });
    expect(readFileSync(path.join(dir, "suite-set1.manifest.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  });
});
