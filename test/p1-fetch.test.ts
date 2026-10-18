import { describe, expect, it } from "vitest";
import { filesOf, metricsWindow, parseP1Log, resultsOf, runPrefix, type LogEvent } from "../scripts/p1-fetch.js";

const ev = (t: number, message: string): LogEvent => ({ timestamp: t, message });
const begin = (set: number, index: number, name: string, at: string, wait = 300) =>
  `P1_RUN_BEGIN ${JSON.stringify({ set, index, name, url: `https://${name}.example`, path: "/db/read", waitSeconds: wait, startedAt: at })}`;
const end = (set: number, index: number, name: string, at: string, exitCode: number | null = 0) =>
  `P1_RUN_END ${JSON.stringify({ set, index, name, exitCode, timedOut: false, aborted: false, endedAt: at })}`;
const step = (rate: number) => `STEP_JSON ${JSON.stringify({ step: 0, rate, ok: 10, sent: 10 })}`;
const result = (rate: number) => `RESULT_JSON ${JSON.stringify({ target: "t", steps: [{ rate }] })}`;

const events: LogEvent[] = [
  ev(1, 'P1_PLAN {"seed":"s1","steps":[25],"stepSeconds":90,"runs":2,"estimateSeconds":900}'),
  ev(2, 'P1_WAIT {"set":1,"index":1,"name":"web-noop","seconds":60}'),
  ev(3, begin(1, 1, "web-noop", "2026-10-19T00:01:00.000Z", 60)),
  ev(4, step(25)),
  ev(5, "step  rate  sent"),
  ev(6, result(25)),
  ev(7, end(1, 1, "web-noop", "2026-10-19T00:03:00.000Z")),
  ev(8, 'P1_WAIT {"set":1,"index":2,"name":"event-dsql-each","seconds":300}'),
  ev(9, begin(1, 2, "event-dsql-each", "2026-10-19T00:08:00.000Z")),
  ev(10, step(25)),
  ev(11, end(1, 2, "event-dsql-each", "2026-10-19T00:09:30.000Z", 1)),
  ev(12, 'P1_DONE {"completed":2}'),
];

describe("parseP1Log", () => {
  it("splits the output into runs, keeps each run's own lines, and reads the plan and the final status", () => {
    const p = parseP1Log(events);
    expect(p.status).toBe("done");
    expect(p.plan?.seed).toBe("s1");
    expect(p.runs.map((r) => r.begin.name)).toEqual(["web-noop", "event-dsql-each"]);
    expect(p.runs[0].lines).toHaveLength(3);
    expect(p.runs[0].end?.exitCode).toBe(0);
    expect(p.runs[1].end?.exitCode).toBe(1);
  });

  it("sorts events by time, so out-of-order delivery does not mix runs", () => {
    const shuffled = [...events].reverse();
    expect(parseP1Log(shuffled).runs.map((r) => r.begin.name)).toEqual(["web-noop", "event-dsql-each"]);
  });

  it("reports an aborted task and an incomplete one", () => {
    const aborted = parseP1Log([...events.slice(0, 7), ev(8, 'P1_ABORTED {"reason":"SIGTERM","completed":1,"of":2}')]);
    expect(aborted.status).toBe("aborted");
    expect(aborted.aborted).toEqual({ reason: "SIGTERM", completed: 1, of: 2 });
    expect(parseP1Log(events.slice(0, 7)).status).toBe("incomplete");
  });

  it("keeps a run that has begun but not ended (the task died in the middle)", () => {
    const p = parseP1Log(events.slice(0, 5));
    expect(p.runs).toHaveLength(1);
    expect(p.runs[0].end).toBeUndefined();
  });
});

describe("resultsOf / filesOf", () => {
  it("uses RESULT_JSON when present, and the finished steps (partial) when only STEP_JSON is", () => {
    const p = parseP1Log(events);
    expect(resultsOf(p.runs[0])).toEqual([{ target: "t", steps: [{ rate: 25 }] }]);
    expect(resultsOf(p.runs[1])).toEqual([{ partial: true, steps: [{ step: 0, rate: 25, ok: 10, sent: 10 }] }]);
  });

  it("names files like scripts/load-run.sh --out, and writes manifest lines with the previous run and the wait", () => {
    const p = parseP1Log(events);
    const files = filesOf(p, "task123", "s1");
    expect(files.map((f) => f.prefix)).toEqual(["p1-set1-1-web-noop", "p1-set1-2-event-dsql-each"]);
    expect(runPrefix(p.runs[1])).toBe("p1-set1-2-event-dsql-each");
    const m = JSON.parse(files[1].manifestLine);
    expect(m).toMatchObject({ set: 1, seed: "s1", index: 2, previous: "web-noop", gapSeconds: 300, exitCode: "1", prefix: "p1-set1-2-event-dsql-each" });
    const meta = JSON.parse(files[0].meta);
    expect(meta).toMatchObject({ taskId: "task123", exitCode: "0", complete: true, startedAt: "2026-10-19T00:01:00.000Z" });
    expect(files[0].log).toContain("step  rate  sent");
  });

  it("marks a run without an end as incomplete", () => {
    const files = filesOf(parseP1Log(events.slice(0, 5)), "t", "s");
    expect(JSON.parse(files[0].meta)).toMatchObject({ complete: false, exitCode: "unknown", stoppedAt: null });
  });
});

describe("metricsWindow", () => {
  it("starts 2 minutes before the run and ends 8 minutes after it", () => {
    const run = parseP1Log(events).runs[0];
    expect(metricsWindow(run)).toEqual({ start: "2026-10-18T23:59:00Z", end: "2026-10-19T00:11:00Z" });
  });
});
