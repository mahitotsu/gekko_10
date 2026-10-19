import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPlan, invokeArgs, runDuration, type CaseDef } from "../scripts/suite-plan.js";
import { CHILD_MARGIN_SECONDS, createRunChild, parsePlan, runPlan, type RunnerDeps, type RunRecord } from "../scripts/suite-runner.js";

const urls = {
  "event-noop": "https://a.example/",
  "web-noop": "https://d.example/",
  "web-dsql-each": "https://e.example/",
};
const cases: CaseDef[] = [{ id: "T", path: "/noop", configs: ["event-noop", "web-noop", "web-dsql-each"], steps: [10, 20], stepSeconds: 5 }];
const plan = buildPlan({ protocol: "t", sets: [1], seed: "t", build: "b1", urls, cases, firstWait: 7 });
const withPost = { ...plan, post: { clusterId: "c", metricsLagSeconds: 180 } };

function fakeDeps(over: Partial<RunnerDeps> = {}) {
  const lines: string[] = [];
  const sleeps: number[] = [];
  const timeouts: number[] = [];
  const started: string[] = [];
  const deps: RunnerDeps = {
    log: (l) => lines.push(l),
    now: () => new Date("2026-10-19T00:00:00Z"),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    runChild: async (run, p, onLine, timeoutMs) => {
      started.push(run.name);
      timeouts.push(timeoutMs);
      onLine(`STEP_JSON {"step":0,"run":"${run.name}"}`);
      onLine(`RESULT_JSON {"target":"${p.urls[run.name]}"}`);
      return { exitCode: 0, timedOut: false, aborted: false };
    },
    ...over,
  };
  return { deps, lines, sleeps, timeouts, started };
}

describe("runPlan", () => {
  it("waits, marks the beginning and end of each run, forwards the child's lines in between, and finishes with SUITE_DONE", async () => {
    const { deps, lines, sleeps } = fakeDeps();
    const out = await runPlan(plan, deps, new AbortController().signal);
    expect(out).toEqual({ status: "done", completed: 3 });
    expect(sleeps).toEqual(plan.runs.map((r) => r.waitSeconds * 1000));
    const kinds = lines.map((l) => l.split(" ")[0]);
    expect(kinds[0]).toBe("SUITE_PLAN");
    expect(kinds.slice(1, 6)).toEqual(["SUITE_WAIT", "SUITE_RUN_BEGIN", "STEP_JSON", "RESULT_JSON", "SUITE_RUN_END"]);
    expect(kinds.at(-1)).toBe("SUITE_DONE");
    const begin = JSON.parse(lines.find((l) => l.startsWith("SUITE_RUN_BEGIN"))!.slice("SUITE_RUN_BEGIN ".length));
    expect(begin).toMatchObject({ set: 1, index: 1, case: "T", name: plan.runs[0].name, startedAt: "2026-10-19T00:00:00.000Z" });
    const planLine = JSON.parse(lines[0].slice("SUITE_PLAN ".length));
    expect(planLine.plan).toEqual(plan);
    expect(planLine.startedAt).toBe("2026-10-19T00:00:00.000Z");
  });

  it("gives each child its steps plus the margin as a deadline", async () => {
    const { deps, timeouts } = fakeDeps();
    await runPlan(plan, deps, new AbortController().signal);
    expect(new Set(timeouts)).toEqual(new Set([(runDuration(plan, plan.runs[0]) + CHILD_MARGIN_SECONDS) * 1000]));
  });

  it("goes on with the next run after a failed or timed-out run", async () => {
    let n = 0;
    const { deps, lines, started } = fakeDeps({
      runChild: async (run, _p, onLine) => {
        started.push(run.name);
        n += 1;
        onLine("partial output");
        return n === 1 ? { exitCode: 1, timedOut: false, aborted: false } : n === 2 ? { exitCode: null, timedOut: true, aborted: false } : { exitCode: 0, timedOut: false, aborted: false };
      },
    });
    const out = await runPlan(plan, deps, new AbortController().signal);
    expect(out).toEqual({ status: "done", completed: 3 });
    expect(started).toHaveLength(3);
    const ends = lines.filter((l) => l.startsWith("SUITE_RUN_END")).map((l) => JSON.parse(l.slice("SUITE_RUN_END ".length)));
    expect(ends.map((e) => [e.exitCode, e.timedOut])).toEqual([[1, false], [null, true], [0, false]]);
  });

  it("stops, reports SUITE_ABORTED with the reason, and starts nothing more when aborted during a run", async () => {
    const controller = new AbortController();
    const { deps, lines, started } = fakeDeps({
      runChild: async (run) => {
        started.push(run.name);
        controller.abort("SIGTERM");
        return { exitCode: null, timedOut: false, aborted: true };
      },
    });
    const out = await runPlan(plan, deps, controller.signal);
    expect(out).toEqual({ status: "aborted", completed: 1 });
    expect(started).toHaveLength(1);
    expect(lines.at(-1)).toBe('SUITE_ABORTED {"reason":"SIGTERM","completed":1,"of":3}');
  });

  it("does not start a run when aborted while waiting", async () => {
    const controller = new AbortController();
    const { deps, lines, started } = fakeDeps({
      sleep: async () => {
        controller.abort("deadline of 1s exceeded");
      },
    });
    const out = await runPlan(plan, deps, controller.signal);
    expect(out).toEqual({ status: "aborted", completed: 0 });
    expect(started).toEqual([]);
    expect(lines.some((l) => l.startsWith("SUITE_RUN_BEGIN"))).toBe(false);
    expect(lines.at(-1)).toContain("SUITE_ABORTED");
  });
});

describe("createRunChild (real child processes)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "p1-runner-test-"));
  const script = (body: string) => {
    const file = path.join(dir, `child-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(file, body);
    return file;
  };
  const run = plan.runs[0];

  it("passes the target and options, forwards stdout and stderr lines, and returns the exit code", async () => {
    const file = script(`console.log("args " + process.argv.slice(2).join(" ")); console.error("to stderr"); process.exit(3);`);
    const lines: string[] = [];
    const out = await createRunChild(file)(run, plan, (l) => lines.push(l), 10_000, new AbortController().signal);
    expect(out).toEqual({ exitCode: 3, timedOut: false, aborted: false });
    expect(lines).toContain(`args ${invokeArgs(plan, run).join(" ")}`);
    expect(invokeArgs(plan, run).join(" ")).toContain("--path /noop --steps 10,20 --step-seconds 5");
    expect(lines).toContain("to stderr");
  });

  it("kills a child that exceeds its deadline", async () => {
    const file = script(`console.log("started"); setInterval(() => {}, 1000);`);
    const lines: string[] = [];
    const out = await createRunChild(file)(run, plan, (l) => lines.push(l), 300, new AbortController().signal);
    expect(out.timedOut).toBe(true);
    expect(out.exitCode).toBeNull();
    expect(lines).toContain("started");
  });

  it("kills the child when the signal aborts", async () => {
    const file = script(`console.log("started"); setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    setTimeout(() => controller.abort("SIGTERM"), 300);
    const out = await createRunChild(file)(run, plan, () => {}, 60_000, controller.signal);
    expect(out.aborted).toBe(true);
    expect(out.timedOut).toBe(false);
  });
});

describe("parsePlan", () => {
  it("reads a JSON string and a @file, and rejects an invalid plan", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "p1-plan-")), "plan.json");
    writeFileSync(file, JSON.stringify(plan));
    expect(parsePlan(JSON.stringify(plan))).toEqual(plan);
    expect(parsePlan(`@${file}`)).toEqual(plan);
    expect(() => parsePlan('{"runs":[]}')).toThrow(/invalid plan/);
    expect(() => parsePlan(JSON.stringify({ ...plan, urls: {} }))).toThrow(/no case, steps or url/);
  });
});


describe("post-processing", () => {
  const postDeps = (calls: unknown[][], over: Partial<RunnerDeps> = {}) =>
    fakeDeps({
      post: async (p, records, startedAt) => {
        calls.push([p, records, startedAt]);
      },
      ...over,
    });

  it("runs after the last run with every run's record and output, then SUITE_DONE", async () => {
    const calls: unknown[][] = [];
    const { deps, lines } = postDeps(calls);
    await runPlan(withPost, deps, new AbortController().signal);
    expect(calls).toHaveLength(1);
    const [p, records, startedAt] = calls[0] as [typeof withPost, RunRecord[], string];
    expect(p).toBe(withPost);
    expect(startedAt).toBe("2026-10-19T00:00:00.000Z");
    expect(records.map((r) => r.run.name)).toEqual(withPost.runs.map((r) => r.name));
    expect(records[0].lines).toEqual(['STEP_JSON {"step":0,"run":"' + records[0].run.name + '"}', expect.stringContaining("RESULT_JSON")]);
    expect(records[0].result).toEqual({ exitCode: 0, timedOut: false, aborted: false });
    const kinds = lines.map((l) => l.split(" ")[0]);
    expect(kinds.slice(-3)).toEqual(["SUITE_POST_BEGIN", "SUITE_POST_END", "SUITE_DONE"]);
  });

  it("does not run without a post configuration, and not when aborted", async () => {
    const calls: unknown[][] = [];
    await runPlan(plan, postDeps(calls).deps, new AbortController().signal);
    expect(calls).toHaveLength(0);
    const controller = new AbortController();
    const aborted = postDeps(calls, {
      runChild: async () => {
        controller.abort("SIGTERM");
        return { exitCode: null, timedOut: false, aborted: true };
      },
    });
    await runPlan(withPost, aborted.deps, controller.signal);
    expect(calls).toHaveLength(0);
  });

  it("reports a failing post-processing and still finishes", async () => {
    const { deps, lines } = fakeDeps({
      post: async () => {
        throw new Error("insights timed out");
      },
    });
    const out = await runPlan(withPost, deps, new AbortController().signal);
    expect(out.status).toBe("done");
    expect(lines.find((l) => l.startsWith("SUITE_POST_FAILED"))).toBe('SUITE_POST_FAILED {"message":"insights timed out"}');
    expect(lines.at(-1)).toBe('SUITE_DONE {"completed":3}');
  });
});
