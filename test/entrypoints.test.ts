import { readdirSync, readFileSync } from "node:fs";
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

// src/ is an input of the build id (scripts/build-id.mjs). A comment that points at a document would change the build id
// whenever the document is renamed, and the measurement would then demand a redeploy for no change in behavior.
describe("build inputs", () => {
  it("src/ does not refer to documents", () => {
    const hits = readdirSync("src").filter((f) => /docs\/|\.md\b|CLAUDE/.test(readFileSync(`src/${f}`, "utf8")));
    expect(hits).toEqual([]);
  });
});
