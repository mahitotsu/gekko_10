import { writeFile } from "node:fs/promises";
import { build } from "esbuild";

// Both runtimes are built with identical settings so the comparison is fair.
const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  minify: false,
  sourcemap: false,
  logLevel: "warning",
};

await build({ ...common, entryPoints: ["src/entry-web.ts"], external: ["pg-native"], outfile: "dist/web/index.js" });
await build({ ...common, entryPoints: ["src/entry-event.ts"], external: ["pg-native"], outfile: "dist/event/index.js" });

// The repo root is "type": "module"; mark the bundles as CommonJS so they load the same way locally and on Lambda.
for (const dir of ["dist/web", "dist/event"]) {
  await writeFile(`${dir}/package.json`, '{"type":"commonjs"}\n');
}
