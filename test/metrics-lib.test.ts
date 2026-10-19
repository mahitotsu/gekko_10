import { describe, expect, it } from "vitest";
import { assembleMetrics, buildQueries, metricDataQueries } from "../scripts/metrics-lib.js";

describe("buildQueries", () => {
  const names = (fns: string[]) => buildQueries(fns, "cid").map((q) => `${q.label}|${q.metric}|${q.stat}`);

  it("asks Event functions for Lambda metrics and Web functions for Web metrics, only for the functions given", () => {
    const q = names(["gekko10-event-dsql-reuse"]);
    expect(q).toContain("gekko10-event-dsql-reuse|Invocations|Sum");
    expect(q).toContain("gekko10-event-dsql-reuse|ConcurrentExecutions|Maximum");
    expect(q.some((x) => x.includes("EnvironmentCPUTime"))).toBe(false);
    const w = names(["gekko10-web-dsql-pool10"]);
    expect(w).toContain("gekko10-web-dsql-pool10|ExecutedRequests|Sum");
    expect(w).toContain("gekko10-web-dsql-pool10|EnvironmentMaxMemoryUsage|Average");
    expect(w.some((x) => x.includes("Invocations"))).toBe(false);
  });

  it("always includes the DSQL cluster metrics", () => {
    const q = buildQueries([], "xyz");
    expect(q.find((x) => x.metric === "TotalDPU")?.dims).toEqual({ ClusterId: "xyz" });
    expect(q.find((x) => x.metric === "CallCount" && x.stat === "Sum")?.dims.ResourceId).toBe("cluster/xyz");
  });

  it("numbers the queries m0, m1, ... in order", () => {
    const qs = buildQueries(["gekko10-web-noop"], "c");
    const specs = metricDataQueries(qs);
    expect(specs.map((s) => s.Id)).toEqual(qs.map((_, i) => `m${i}`));
    expect(specs[0].MetricStat.Period).toBe(60);
  });
});

describe("assembleMetrics", () => {
  it("joins pages with the same Id, sorts by time, accepts Date and string stamps, and leaves unanswered queries empty", () => {
    const qs = buildQueries(["gekko10-web-noop"], "c");
    const out = assembleMetrics(
      qs,
      [
        { Id: "m0", Timestamps: ["2026-10-19T00:02:00Z"], Values: [3] },
        { Id: "m0", Timestamps: [new Date("2026-10-19T00:01:00Z")], Values: [2] },
        { Id: "m1", Timestamps: ["2026-10-19T00:01:00Z"], Values: [9] },
      ],
      { start: "s", end: "e", clusterId: "c" },
    );
    expect(out.series[0].points).toEqual([
      ["2026-10-19T00:01:00.000Z", 2],
      ["2026-10-19T00:02:00Z", 3],
    ]);
    expect(out.series[1].points).toEqual([["2026-10-19T00:01:00Z", 9]]);
    expect(out.series[2].points).toEqual([]);
    expect(out).toMatchObject({ region: "ap-northeast-1", periodSeconds: 60, clusterId: "c" });
  });
});
