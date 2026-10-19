import { describe, expect, it } from "vitest";
import { REPORT_QUERY, parseReportRows } from "../scripts/reports-lib.js";

describe("parseReportRows", () => {
  it("reads the numbers of the first result row", () => {
    const rows = [
      [
        { field: "invocations", value: "285750" },
        { field: "billedMs", value: "1500000" },
        { field: "durationMs", value: "1400000.5" },
        { field: "durationP50", value: "4.1" },
        { field: "durationP99", value: "21.2" },
        { field: "maxMemoryBytes", value: "100000000" },
        { field: "coldStarts", value: "120" },
        { field: "initAvgMs", value: "310.5" },
        { field: "initP50", value: "300" },
        { field: "initMaxMs", value: "800" },
        { field: "@ptr", value: "xyz" },
      ],
    ];
    expect(parseReportRows(rows)).toEqual({
      invocations: 285750,
      billedMs: 1500000,
      durationMs: 1400000.5,
      durationP50: 4.1,
      durationP99: 21.2,
      maxMemoryBytes: 100000000,
      coldStarts: 120,
      initAvgMs: 310.5,
      initP50: 300,
      initMaxMs: 800,
    });
  });

  it("gives zeros for a window without REPORT lines, and omits init statistics when there was no cold start", () => {
    expect(parseReportRows([])).toMatchObject({ invocations: 0, billedMs: 0, coldStarts: 0 });
    const noCold = parseReportRows([[{ field: "invocations", value: "5" }, { field: "coldStarts", value: "0" }, { field: "initAvgMs", value: "" }]]);
    expect(noCold.initAvgMs).toBeUndefined();
  });

  it("filters REPORT lines and asks for the billed duration and the init duration", () => {
    expect(REPORT_QUERY).toContain('@type = "REPORT"');
    expect(REPORT_QUERY).toContain("@billedDuration");
    expect(REPORT_QUERY).toContain("@initDuration");
  });
});
