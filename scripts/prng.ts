// Small deterministic PRNG (FNV-1a hash of a string seed, then mulberry32), so an order or a choice can be reproduced from its seed.
// Shared by the run planner (scripts/suite-plan.ts) and the load generator's request mix (scripts/loadgen-lib.ts).
export function prng(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
