import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPlan, runSeconds } from "../scripts/p1-plan.js";
import { CHILD_MARGIN_SECONDS, createRunChild, parsePlan, runPlan, type RunnerDeps } from "../scripts/p1-runner.js";

const urls = {
  "event-noop": "https://a.example/",
  "event-dsql-each": "https://b.example/",
  "event-dsql-reuse": "https://c.example/",
  "web-noop": "https://d.example/",
  "web-dsql-each": "https://e.example/",
  "web-dsql-pool": "https://f.example/",
};
const plan = buildPlan({ sets: [1], seed: "t", urls, only: ["event-noop", "web-noop", "web-dsql-each"], steps: [10, 20], stepSeconds: 5, firstWait: 7 });

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
    runChild: async (run, _plan, onLine, timeoutMs) => {
      started.push(run.name);
      timeouts.push(timeoutMs);
      onLine(`STEP_JSON {"step":0,"run":"${run.name}"}`);
      onLine(`RESULT_JSON {"target":"${run.url}${run.path}"}`);
      return { exitCode: 0, timedOut: false, aborted: false };
    },
    ...over,
  };
  return { deps, lines, sleeps, timeouts, started };
}

describe("runPlan", () => {
  it("waits, marks the beginning and end of each run, forwards the child's lines in between, and finishes with P1_DONE", async () => {
    const { deps, lines, sleeps } = fakeDeps();
    const out = await runPlan(plan, deps, new AbortController().signal);
    expect(out).toEqual({ status: "done", completed: 3 });
    expect(sleeps).toEqual(plan.runs.map((r) => r.waitSeconds * 1000));
    const kinds = lines.map((l) => l.split(" ")[0]);
    expect(kinds[0]).toBe("P1_PLAN");
    expect(kinds.slice(1, 6)).toEqual(["P1_WAIT", "P1_RUN_BEGIN", "STEP_JSON", "RESULT_JSON", "P1_RUN_END"]);
    expect(kinds.at(-1)).toBe("P1_DONE");
    const begin = JSON.parse(lines.find((l) => l.startsWith("P1_RUN_BEGIN"))!.slice("P1_RUN_BEGIN ".length));
    expect(begin).toMatchObject({ set: 1, index: 1, name: plan.runs[0].name, startedAt: "2026-10-19T00:00:00.000Z" });
  });

  it("gives each child its steps plus the margin as a deadline", async () => {
    const { deps, timeouts } = fakeDeps();
    await runPlan(plan, deps, new AbortController().signal);
    expect(new Set(timeouts)).toEqual(new Set([(runSeconds(plan) + CHILD_MARGIN_SECONDS) * 1000]));
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
    const ends = lines.filter((l) => l.startsWith("P1_RUN_END")).map((l) => JSON.parse(l.slice("P1_RUN_END ".length)));
    expect(ends.map((e) => [e.exitCode, e.timedOut])).toEqual([[1, false], [null, true], [0, false]]);
  });

  it("stops, reports P1_ABORTED with the reason, and starts nothing more when aborted during a run", async () => {
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
    expect(lines.at(-1)).toBe('P1_ABORTED {"reason":"SIGTERM","completed":1,"of":3}');
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
    expect(lines.some((l) => l.startsWith("P1_RUN_BEGIN"))).toBe(false);
    expect(lines.at(-1)).toContain("P1_ABORTED");
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
    expect(lines).toContain(`args ${run.url} --path ${run.path} --steps 10,20 --step-seconds 5`);
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
  });
});
