import { describe, expect, it } from "vitest";
import {
  GAP_AFTER_EACH_SECONDS,
  GAP_SECONDS,
  MIN_SAME_FUNCTION_IDLE_SECONDS,
  buildPlan,
  capacityProblems,
  estimateSeconds,
  invokeArgs,
  runDuration,
  shuffled,
  type CaseDef,
} from "../scripts/suite-plan.js";

const CONFIGS = ["event-dsql-reuse", "web-dsql-pool10", "web-dsql-pool"];
const urls = Object.fromEntries(CONFIGS.map((c) => [c, `https://${c}.example/`]));
const cases: CaseDef[] = [
  { id: "A", path: "/app/external?ms=1000", configs: ["event-dsql-reuse", "web-dsql-pool10"], steps: [25, 100], stepSeconds: 45 },
  { id: "B", mix: "/app/item:70,/app/detail:30", configs: ["event-dsql-reuse", "web-dsql-pool10"], steps: [50, 100, 200], stepSeconds: 90 },
  { id: "D", path: "/app/report", configs: CONFIGS, steps: [50, 100], stepSeconds: 90 },
];
const base = { protocol: "v2", seed: "s", build: "abc123", urls, cases, firstWait: 60 };

describe("shuffled", () => {
  it("is a permutation and is reproducible from the seed", () => {
    const a = shuffled(CONFIGS, "seed-1");
    expect([...a].sort()).toEqual([...CONFIGS].sort());
    expect(shuffled(CONFIGS, "seed-1")).toEqual(a);
  });
  it("differs between seeds (at least one of many)", () => {
    const orders = new Set(Array.from({ length: 20 }, (_, i) => shuffled(CONFIGS, `seed-${i}`).join()));
    expect(orders.size).toBeGreaterThan(2);
  });
});

describe("buildPlan", () => {
  it("runs every (case, configuration) pair once per set, numbered from 1", () => {
    const plan = buildPlan({ ...base, sets: [1, 2] });
    expect(plan.runs).toHaveLength(14);
    for (const set of [1, 2]) {
      const runs = plan.runs.filter((r) => r.set === set);
      expect(runs.map((r) => r.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(runs.map((r) => `${r.case}/${r.name}`).sort()).toEqual(
        ["A/event-dsql-reuse", "A/web-dsql-pool10", "B/event-dsql-reuse", "B/web-dsql-pool10", "D/event-dsql-reuse", "D/web-dsql-pool", "D/web-dsql-pool10"].sort(),
      );
    }
  });

  it("waits firstWait first and 5 minutes otherwise, unless the same function has to be left idle longer", () => {
    const plan = buildPlan({ ...base, sets: [1, 2, 3] });
    expect(plan.runs[0].waitSeconds).toBe(60);
    for (const r of plan.runs.slice(1)) expect(r.waitSeconds).toBeGreaterThanOrEqual(GAP_SECONDS);
  });

  it("keeps every function idle for at least the minimum between two of its runs (also across sets)", () => {
    const plan = buildPlan({ ...base, sets: [1, 2, 3] });
    let t = 0;
    const lastEnd = new Map<string, number>();
    for (const r of plan.runs) {
      const start = t + r.waitSeconds;
      if (lastEnd.has(r.name)) expect(start - lastEnd.get(r.name)!).toBeGreaterThanOrEqual(MIN_SAME_FUNCTION_IDLE_SECONDS);
      t = start + runDuration(plan, r);
      lastEnd.set(r.name, t);
    }
  });

  it("waits 15 minutes after a connect-every-time run", () => {
    const each: CaseDef[] = [{ id: "E", path: "/db/read", configs: ["web-dsql-each", "event-dsql-reuse"], steps: [25], stepSeconds: 30 }];
    const plan = buildPlan({ ...base, cases: each, urls: { ...urls, "web-dsql-each": "https://each.example" }, sets: [1, 2] });
    plan.runs.forEach((r, i) => {
      if (i > 0 && plan.runs[i - 1].name === "web-dsql-each") expect(r.waitSeconds).toBeGreaterThanOrEqual(GAP_AFTER_EACH_SECONDS);
    });
  });

  it("carries the cases and urls it uses, without a trailing slash, and the expected build", () => {
    const plan = buildPlan({ ...base, sets: [1], only: ["web-dsql-pool"] });
    expect(Object.keys(plan.cases)).toEqual(["D"]);
    expect(plan.urls).toEqual({ "web-dsql-pool": "https://web-dsql-pool.example" });
    expect(plan.build).toBe("abc123");
    expect(plan.cases.D).toEqual({ path: "/app/report", steps: [50, 100], stepSeconds: 90 });
  });

  it("rejects an empty selection and a missing URL", () => {
    expect(() => buildPlan({ ...base, sets: [1], only: ["nope"] })).toThrow(/no configuration/);
    expect(() => buildPlan({ ...base, sets: [1], urls: {} })).toThrow(/no URL/);
  });

  it("is reproducible from the seed, and the order depends on it", () => {
    expect(buildPlan({ ...base, sets: [1, 2] })).toEqual(buildPlan({ ...base, sets: [1, 2] }));
    const order = (seed: string) => buildPlan({ ...base, sets: [1], seed }).runs.map((r) => `${r.case}/${r.name}`).join();
    expect(new Set(Array.from({ length: 10 }, (_, i) => order(`seed-${i}`))).size).toBeGreaterThan(1);
  });

  it("estimates the duration from the waits and the runs", () => {
    const plan = buildPlan({ ...base, sets: [1] });
    const expected = plan.runs.reduce((n, r) => n + r.waitSeconds + runDuration(plan, r), 0);
    expect(estimateSeconds(plan)).toBe(expected);
    expect(estimateSeconds(plan) / 3600).toBeGreaterThan(1);
  });
});

describe("invokeArgs", () => {
  const plan = buildPlan({ ...base, sets: [2] });
  const find = (c: string, n: string) => plan.runs.find((r) => r.case === c && r.name === n)!;

  it("sends one path with --path and the steps", () => {
    expect(invokeArgs(plan, find("A", "web-dsql-pool10"))).toEqual([
      "https://web-dsql-pool10.example", "--path", "/app/external?ms=1000", "--steps", "25,100", "--step-seconds", "45",
    ]);
  });

  it("sends a mix with the same request sequence on every configuration of a case and set", () => {
    const a = invokeArgs(plan, find("B", "event-dsql-reuse"));
    const b = invokeArgs(plan, find("B", "web-dsql-pool10"));
    expect(a.slice(1)).toEqual(b.slice(1));
    expect(a).toContain("--mix");
    expect(a[a.indexOf("--mix-seed") + 1]).toBe("s:B:2");
  });
});

describe("generator limits", () => {
  it("passes the per-case limits to invoke", () => {
    const withLimits = buildPlan({
      ...base,
      cases: [{ id: "A", path: "/x", configs: ["event-dsql-reuse"], steps: [400], stepSeconds: 45, maxConnections: 1000, maxInflight: 3000 }],
      sets: [2],
    });
    expect(invokeArgs(withLimits, withLimits.runs[0]).slice(-4)).toEqual(["--max-connections", "1000", "--max-inflight", "3000"]);
    const without = buildPlan({ ...base, sets: [2] });
    expect(invokeArgs(without, without.runs[0])).not.toContain("--max-connections");
  });

  it("flags a case whose peak concurrency (rate x expected time) does not fit the generator, and accepts one that does", () => {
    const spec = { steps: [25, 400], stepSeconds: 45, expectedMs: 1050 };
    // 400 RPS x 1.05 s = 420 at once: the default 256 sockets (usable: 153) cannot carry it
    const bad = capacityProblems({ A: spec });
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain("case A");
    expect(bad[0]).toContain("max-connections is 256");
    expect(capacityProblems({ A: { ...spec, maxConnections: 1000, maxInflight: 3000 } })).toEqual([]);
    // enough sockets but too few requests allowed in flight: 2,000 RPS x 1.05 s = 2,100 at once
    expect(capacityProblems({ A: { ...spec, steps: [2000], maxConnections: 5000 } }).join()).toContain("max-inflight is 2000");
  });

  it("says nothing about a case without an expected time", () => {
    expect(capacityProblems({ A: { steps: [4000], stepSeconds: 45 } })).toEqual([]);
  });

  it("the measurement definition fits the generator", async () => {
    const { MEASUREMENT } = await import("../scripts/protocol.js");
    const specs = Object.fromEntries(MEASUREMENT.map(({ id, configs: _c, ...spec }) => [id, spec]));
    expect(capacityProblems(specs)).toEqual([]);
  });
});
