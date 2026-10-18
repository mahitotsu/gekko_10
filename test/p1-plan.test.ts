import { describe, expect, it } from "vitest";
import { CONFIGS, GAP_AFTER_EACH_SECONDS, GAP_SECONDS, buildPlan, estimateSeconds, shuffled } from "../scripts/p1-plan.js";

const urls = Object.fromEntries(CONFIGS.map((c) => [c, `https://${c}.example/`]));
const base = { seed: "s", urls, steps: [25, 50], stepSeconds: 90, firstWait: 60 };

describe("shuffled", () => {
  it("is a permutation and is reproducible from the seed", () => {
    const a = shuffled(CONFIGS, "seed-1");
    expect([...a].sort()).toEqual([...CONFIGS].sort());
    expect(shuffled(CONFIGS, "seed-1")).toEqual(a);
  });
  it("differs between seeds (at least one of many)", () => {
    const orders = new Set(Array.from({ length: 20 }, (_, i) => shuffled(CONFIGS, `seed-${i}`).join()));
    expect(orders.size).toBeGreaterThan(5);
  });
});

describe("buildPlan", () => {
  it("runs every configuration once per set, numbered from 1", () => {
    const plan = buildPlan({ ...base, sets: [1, 2] });
    expect(plan.runs).toHaveLength(12);
    for (const set of [1, 2]) {
      const runs = plan.runs.filter((r) => r.set === set);
      expect(runs.map((r) => r.index)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(runs.map((r) => r.name).sort()).toEqual([...CONFIGS].sort());
    }
  });

  it("waits firstWait first, 5 minutes otherwise, and 15 minutes after a connect-every-time run (also across sets)", () => {
    const plan = buildPlan({ ...base, sets: [1, 2, 3] });
    plan.runs.forEach((r, i) => {
      if (i === 0) return expect(r.waitSeconds).toBe(60);
      const prev = plan.runs[i - 1].name;
      expect(r.waitSeconds).toBe(prev.endsWith("dsql-each") ? GAP_AFTER_EACH_SECONDS : GAP_SECONDS);
    });
    expect(plan.runs.some((r) => r.waitSeconds === GAP_AFTER_EACH_SECONDS)).toBe(true);
  });

  it("uses /noop for the noop configurations and /db/read for the others, without a trailing slash", () => {
    const plan = buildPlan({ ...base, sets: [1] });
    for (const r of plan.runs) {
      expect(r.path).toBe(r.name.endsWith("noop") ? "/noop" : "/db/read");
      expect(r.url.endsWith("/")).toBe(false);
    }
  });

  it("restricts to the selected configurations and rejects unknown or empty selections", () => {
    const plan = buildPlan({ ...base, sets: [1], only: ["web-noop", "event-noop"] });
    expect(plan.runs.map((r) => r.name).sort()).toEqual(["event-noop", "web-noop"]);
    expect(() => buildPlan({ ...base, sets: [1], only: ["nope"] })).toThrow(/no configuration/);
    expect(() => buildPlan({ ...base, sets: [1], urls: {} })).toThrow(/no URL/);
  });

  it("is reproducible from the seed", () => {
    expect(buildPlan({ ...base, sets: [1, 2] })).toEqual(buildPlan({ ...base, sets: [1, 2] }));
    expect(buildPlan({ ...base, sets: [1], seed: "a" }).runs.map((r) => r.name)).not.toEqual(
      buildPlan({ ...base, sets: [1], seed: "b" }).runs.map((r) => r.name),
    );
  });

  it("estimates a set at roughly two hours with the default steps", () => {
    const plan = buildPlan({ ...base, sets: [1], steps: [25, 50, 100, 200, 400, 800, 1600], firstWait: 60 });
    const hours = estimateSeconds(plan) / 3600;
    expect(hours).toBeGreaterThan(1.4);
    expect(hours).toBeLessThan(2.4);
  });
});
