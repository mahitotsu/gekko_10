import { writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { buildId as computeBuildId } from "./build-id.mjs";

// The build id travels in every response, so a result file proves which code answered (scripts/build-id.mjs). Uncommitted changes
// make it "<sha>-dirty", which suite-start refuses to measure. (The bundle itself is not refused: `cdk synth` and local runs bundle
// while the tree is being edited.)
const buildId = computeBuildId();

// Both runtimes are built with identical settings so the comparison is fair.
const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  minify: false,
  sourcemap: false,
  logLevel: "warning",
  define: { __BUILD_ID__: JSON.stringify(buildId) },
};

await build({ ...common, entryPoints: ["src/entry-web.ts"], external: ["pg-native"], outfile: "dist/web/index.js" });
await build({ ...common, entryPoints: ["src/entry-event.ts"], external: ["pg-native"], outfile: "dist/event/index.js" });

// The repo root is "type": "module"; mark the bundles as CommonJS so they load the same way locally and on Lambda.
for (const dir of ["dist/web", "dist/event"]) {
  await writeFile(`${dir}/package.json`, '{"type":"commonjs"}\n');
}
