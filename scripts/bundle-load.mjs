import { build } from "esbuild";

// The load generator image carries two scripts, each as a single ESM file: scripts/invoke.ts (one load run) and
// scripts/p1-runner.ts (a whole P1 plan inside one task). Kept apart from bundle.mjs, whose Lambda bundles must share
// identical settings for a fair comparison.
for (const name of ["invoke", "p1-runner"]) {
  await build({
    entryPoints: [`scripts/${name}.ts`],
    outfile: `load/${name}.mjs`,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    // Top-level await needs ESM; the CJS-only AWS SDK parts need require().
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    logLevel: "warning",
  });
}
