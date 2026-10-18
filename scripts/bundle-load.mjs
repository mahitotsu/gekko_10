import { build } from "esbuild";

// The load generator image carries scripts/invoke.ts as a single file. Kept apart from bundle.mjs, whose Lambda bundles
// must share identical settings for a fair comparison.
await build({
  entryPoints: ["scripts/invoke.ts"],
  outfile: "load/invoke.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // Top-level await in invoke.ts needs ESM; the CJS-only AWS SDK parts need require().
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  logLevel: "warning",
});
