// The build id: the last commit that touched what goes into the function bundles ("-dirty" if those files have uncommitted changes).
// scripts/bundle.mjs embeds it in the bundles and every response carries it; scripts/suite-start.ts computes the same value to know
// which build the plan expects. Plain JavaScript so that both can import it.
import { execFileSync } from "node:child_process";

export const BUILD_INPUTS = ["src", "scripts/bundle.mjs", "scripts/build-id.mjs", "package-lock.json"];

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

export function buildId() {
  return git("log", "-1", "--format=%H", "--", ...BUILD_INPUTS) + (git("status", "--porcelain", "--", ...BUILD_INPUTS) ? "-dirty" : "");
}
