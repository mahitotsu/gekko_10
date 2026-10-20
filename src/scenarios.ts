// Application-shaped endpoints (/app/*): what a request to a real API looks like, as opposed to the single lookup of /db/read.
// Each scenario is a sequence of Db.run calls (a pooled connection is borrowed and returned per statement, like pool.query),
// plus a wait or some CPU work where the scenario calls for it. The parameters (n, k, w, ms) are request parameters, so they
// can be tuned without redeploying.
import { createHash, randomUUID } from "node:crypto";
import { DB_ROWS, type Db, type DbTrace } from "./db.js";

export class ParamError extends Error {}

/** Parses an optional integer query parameter; throws ParamError when it is not an integer in min..max. */
export function intParam(raw: string | undefined, name: string, def: number, min: number, max: number): number {
  if (raw === undefined) return def;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new ParamError(`${name} must be an integer in ${min}..${max}`);
  return Number(raw);
}

/** Defaults. */
export const DEFAULTS = {
  /** /app/detail: statements per request (1 + N related lookups). */
  detailQueries: 11,
  /** /app/report: the aggregate joins the first k rows of items with themselves (k x k pairs). */
  reportK: 300,
  /** /app/render: SHA-256 rounds, a fixed amount of CPU work (not a fixed duration). */
  renderWork: 10_000,
  /** /app/external: wait standing in for a call to an external API or an LLM. */
  externalMs: 1000,
};
export const MAX_EXTERNAL_MS = 25_000;

const READ = "SELECT id, payload FROM items WHERE id = $1";
const REPORT = "SELECT count(*)::int AS pairs, sum(length(a.payload) + length(b.payload))::bigint AS bytes FROM items a CROSS JOIN items b WHERE a.id <= $1 AND b.id <= $1";
const WRITE = "INSERT INTO events (id, item_id) VALUES ($1, $2)";

const randomId = () => 1 + Math.floor(Math.random() * DB_ROWS);

/** One trace for a request that ran several statements: times add up, flags are "any", counters come from the last run. */
export function mergeTraces(traces: DbTrace[]): DbTrace {
  const last = traces[traces.length - 1];
  const ages = traces.map((t) => t.connectionAgeMs).filter((x): x is number => x !== undefined);
  return {
    ...last,
    newConnection: traces.some((t) => t.newConnection),
    reconnected: traces.some((t) => t.reconnected) || undefined,
    acquireMs: traces.reduce((n, t) => n + t.acquireMs, 0),
    queryMs: traces.reduce((n, t) => n + t.queryMs, 0),
    releaseMs: traces.reduce((n, t) => n + t.releaseMs, 0),
    queries: traces.length,
    queryMaxMs: traces.reduce((n, t) => Math.max(n, t.queryMs), 0),
    connectionAgeMs: ages.length ? Math.max(...ages) : undefined,
  };
}

export interface ScenarioResult {
  traces: DbTrace[];
  rows: number;
  extra?: Record<string, unknown>;
}
export interface ScenarioDeps {
  sleep(ms: number): Promise<void>;
}
export type Scenario = (db: Db, query: (name: string) => string | undefined, deps: ScenarioDeps) => Promise<ScenarioResult>;

/** A fixed amount of CPU work: `work` chained SHA-256 rounds over the rows. */
export function burnCpu(work: number, seed: unknown): string {
  let h = createHash("sha256").update(JSON.stringify(seed)).digest();
  for (let i = 0; i < work; i++) h = createHash("sha256").update(h).digest();
  return h.toString("hex").slice(0, 8);
}

export const scenarios: Record<string, Scenario> = {
  /** One primary-key lookup (the typical "get a thing" call). */
  item: async (db) => {
    const r = await db.run(READ, [randomId()]);
    return { traces: [r.trace], rows: r.rows.length };
  },

  /** A lookup followed by n-1 related lookups, one after another (the N+1 pattern of a detail page). */
  detail: async (db, q) => {
    const n = intParam(q("n"), "n", DEFAULTS.detailQueries, 1, 100);
    const traces: DbTrace[] = [];
    let rows = 0;
    for (let i = 0; i < n; i++) {
      const r = await db.run(READ, [randomId()]);
      traces.push(r.trace);
      rows += r.rows.length;
    }
    return { traces, rows, extra: { n } };
  },

  /** One heavy aggregate (a report or list screen). */
  report: async (db, q) => {
    const k = intParam(q("k"), "k", DEFAULTS.reportK, 1, DB_ROWS);
    const r = await db.run(REPORT, [k]);
    return { traces: [r.trace], rows: r.rows.length, extra: { k } };
  },

  /** A lookup followed by CPU-bound formatting (server-side rendering, serialization, hashing). */
  render: async (db, q) => {
    const w = intParam(q("w"), "w", DEFAULTS.renderWork, 0, 1_000_000);
    const r = await db.run(READ, [randomId()]);
    const digest = burnCpu(w, r.rows);
    return { traces: [r.trace], rows: r.rows.length, extra: { w, digest } };
  },

  /** One INSERT of a new row. */
  write: async (db) => {
    const r = await db.run(WRITE, [randomUUID(), randomId()]);
    return { traces: [r.trace], rows: 0 };
  },

  /** Read, wait for an external call (the connection is returned meanwhile), then write the result. */
  external: async (db, q, deps) => {
    const ms = intParam(q("ms"), "ms", DEFAULTS.externalMs, 0, MAX_EXTERNAL_MS);
    const first = await db.run(READ, [randomId()]);
    await deps.sleep(ms);
    const second = await db.run(WRITE, [randomUUID(), randomId()]);
    return { traces: [first.trace, second.trace], rows: first.rows.length, extra: { waitedMs: ms } };
  },
};
