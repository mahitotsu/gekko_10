// The measurement definition (docs/plan.md §8): which cases run on which configurations. One definition, versioned with the code;
// suite-start builds the plan from it, so the same definition and seed always give the same plan.
// The request parameters (n, k, w, ms) are fixed by the calibration (docs/plan.md §8) and must not change between the sets.
import type { CaseDef } from "./suite-plan.js";

export const PROTOCOL = "v2";

const APP_CONFIGS = ["event-dsql-reuse", "web-dsql-pool10"];

/** Parameters of the application-shaped endpoints, as fixed by the calibration. */
export const PARAMS = { detailN: 11, reportK: 300, renderW: 10_000, externalMs: 1000 };

const detail = `/app/detail?n=${PARAMS.detailN}`;
const report = `/app/report?k=${PARAMS.reportK}`;

/** The measurement (3 sets, the first one is the warm-up). */
export const MEASUREMENT: CaseDef[] = [
  // A: a request that waits on an external call (an API, an LLM) between two database calls.
  { id: "A", path: `/app/external?ms=${PARAMS.externalMs}`, configs: APP_CONFIGS, steps: [25, 100, 400], stepSeconds: 45 },
  // B: a typical API: mostly single lookups, some N+1 pages, a few heavy reports, CPU-bound rendering and writes.
  {
    id: "B",
    mix: [`/app/item:70`, `${detail}:15`, `${report}:5`, `/app/render?w=${PARAMS.renderW}:5`, `/app/write:5`].join(","),
    configs: APP_CONFIGS,
    steps: [50, 100, 200, 400],
    stepSeconds: 90,
  },
  // C: a sudden spike from a trickle: the first spike meets cold functions, the second one warm functions.
  { id: "C", path: detail, configs: APP_CONFIGS, steps: [10, 10, 1500, 1500, 1500, 1500, 10, 10, 10, 10, 1500, 1500, 1500, 1500, 10, 10], stepSeconds: 30 },
  // D: a heavy aggregate only: the database work held per request is long enough for a pool of 10 to run short.
  { id: "D", path: report, configs: [...APP_CONFIGS, "web-dsql-pool"], steps: [50, 100, 200, 400], stepSeconds: 90 },
];

/**
 * The calibration (1 set): K checks that the instrumented build does not distort /db/read (acceptance (a)); Q1..Q5 run each endpoint
 * alone at a low rate, to read its duration and, from the DSQL metrics of the run, its DPU per request.
 */
export const CALIBRATION: CaseDef[] = [
  { id: "K", path: "/db/read", configs: ["event-dsql-reuse", "web-dsql-pool"], steps: [25, 50, 100, 200], stepSeconds: 45 },
  { id: "Q1", path: detail, configs: ["event-dsql-reuse"], steps: [20], stepSeconds: 60 },
  { id: "Q2", path: report, configs: ["event-dsql-reuse"], steps: [20], stepSeconds: 60 },
  { id: "Q3", path: `/app/render?w=${PARAMS.renderW}`, configs: ["event-dsql-reuse", "web-dsql-pool10"], steps: [20], stepSeconds: 60 },
  { id: "Q4", path: "/app/write", configs: ["event-dsql-reuse"], steps: [20], stepSeconds: 60 },
  { id: "Q5", path: `/app/external?ms=${PARAMS.externalMs}`, configs: ["event-dsql-reuse"], steps: [20], stepSeconds: 60 },
];

export const SUITES = { measurement: MEASUREMENT, calibration: CALIBRATION } as const;
