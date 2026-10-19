import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// esbuild puts every module of a bundle into one file, where `import.meta.url` is the bundle's own URL for all of them: a module
// that starts its command line when "run as the entry point" would then run it inside every bundle that imports it (it did:
// the analysis tried to read its arguments inside the load task). Only entry-point scripts may have such a check.
describe("modules bundled into the load task", () => {
  it.each([
    "analyze", "metrics-lib", "reports-lib", "suite-plan", "suite-files", "suite-post", "loadgen-lib", "prng", "protocol", "build-id",
  ])("scripts/%s has no entry-point check of its own", (name) => {
    const file = name === "build-id" ? "build-id.mjs" : `${name}.ts`;
    expect(readFileSync(new URL(`../scripts/${file}`, import.meta.url), "utf8")).not.toMatch(/import\.meta\.url\s*===/);
  });
});
