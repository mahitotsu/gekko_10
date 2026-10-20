// The measurement definition (docs/plan.md §8): which cases run on which configurations. One definition, versioned with the code;
// suite-start builds the plan from it, so the same definition and seed always give the same plan.
// The request parameters (n, k, w, ms) are fixed by the calibration (docs/plan.md §8) and must not change between the sets.
import type { CaseDef } from "./suite-plan.js";

// v2.0 (results/measurement-20261020) ran cases A and C with the generator's default limits (256 sockets): the 400 RPS step of A and the
// first spike of C needed more, so A's top step is invalid and C's Event environment counts are lower bounds. v2.1 sets the limits per
// case and the planner checks them (capacityProblems). The plan of a measurement is saved with its results (suite.plan.json).
export const PROTOCOL = "v2.1";

const APP_CONFIGS = ["event-dsql-reuse", "web-dsql-pool10"];

/** Parameters of the application-shaped endpoints, as fixed by the calibration. */
// Calibration (docs/plan.md §8): /app/report with k=800 takes about 250 ms (k=300: 39 ms, 450: 82 ms, 600: 141 ms) and costs 0.58 DPU.
export const PARAMS = { detailN: 11, reportK: 800, renderW: 10_000, externalMs: 1000 };

const detail = `/app/detail?n=${PARAMS.detailN}`;
const report = `/app/report?k=${PARAMS.reportK}`;

/** The measurement (3 sets, the first one is the warm-up). */
export const MEASUREMENT: CaseDef[] = [
  // A: a request that waits on an external call (an API, an LLM) between two database calls.
  // 400 RPS x 1.05 s is about 420 requests at once, more than the default 256 sockets can carry.
  { id: "A", path: `/app/external?ms=${PARAMS.externalMs}`, configs: APP_CONFIGS, steps: [25, 100, 400], stepSeconds: 45, maxConnections: 1000, maxInflight: 3000, expectedMs: 1050 },
  // B: a typical API: mostly single lookups, some N+1 pages, a few heavy reports, CPU-bound rendering and writes.
  {
    id: "B",
    mix: [`/app/item:70`, `${detail}:15`, `${report}:5`, `/app/render?w=${PARAMS.renderW}:5`, `/app/write:5`].join(","),
    configs: APP_CONFIGS,
    steps: [50, 100, 200, 400],
    stepSeconds: 90,
  },
  // C: a sudden spike from a trickle: the first spike meets cold functions, the second one warm functions.
  // The first spike meets cold functions: requests wait about 0.7 s for a new environment, so up to ~1,000 are in flight at once.
  { id: "C", path: detail, configs: APP_CONFIGS, steps: [10, 10, 1500, 1500, 1500, 1500, 10, 10, 10, 10, 1500, 1500, 1500, 1500, 10, 10], stepSeconds: 30, maxConnections: 2000, maxInflight: 4000, expectedMs: 700 },
  // D: a heavy aggregate only: the database work held per request is long enough for a pool of 10 to run short. The DPU of the
  // aggregate (0.58 per request) is the main cost, so the steps are short and start at 100 RPS (12.5 to 100 requests in the database at once).
  { id: "D", path: report, configs: [...APP_CONFIGS, "web-dsql-pool"], steps: [100, 200, 400], stepSeconds: 45 },
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

/** Second calibration step: the weight of /app/report for several k, to read its duration and DPU (the cost of case D depends on it). */
export const CALIBRATION_REPORT: CaseDef[] = [450, 600, 800].map((k, i) => ({ id: `R${i + 1}`, path: `/app/report?k=${k}`, configs: ["event-dsql-reuse"], steps: [20], stepSeconds: 45 }));

export const SUITES = { measurement: MEASUREMENT, calibration: CALIBRATION, "calibration-report": CALIBRATION_REPORT } as const;
