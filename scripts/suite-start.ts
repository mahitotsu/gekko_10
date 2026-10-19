// Starts a suite (scripts/protocol.ts) as ONE Fargate task that runs to the end by itself (scripts/suite-runner.ts): the waits, the
// load, the collection of metrics and Event REPORT summaries, the analysis and the verdict. The local PC may sleep and the AWS
// login may expire while it runs. Fetch the results afterwards with `npm run suite-fetch`.
//
//   npm run suite-start -- --suite measurement --seed 20261020 [--sets 1,2,3] [--only event-dsql-reuse,web-dsql-pool10]
//                          [--first-wait 60] [--min-idle 960] [--out results/2026-10-20] [--dry-run] [--force]
//                          [--skip-preflight] [--allow-dirty]
//
// --dry-run prints the plan (order, waits, expected end, cost) without starting anything. The task starts only if the working tree
// is clean (the build id of the plan is then the last commit that touched the code) and every function answers with that build.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildId } from "./build-id.mjs";
import { PROTOCOL, SUITES } from "./protocol.js";
import { buildPlan, estimateSeconds, postSeconds, runDuration, type Plan } from "./suite-plan.js";

const REGION = "ap-northeast-1";
/** Fargate 2 vCPU / 4 GB x86_64 plus a public IPv4, per hour (docs/findings.md 3-2). */
const FARGATE_USD_PER_HOUR = 2 * 0.05056 + 4 * 0.00553 + 0.005;
/** The task overrides must stay below 8,192 characters. */
const MAX_OVERRIDE_CHARS = 7500;
/** CloudWatch metrics are usually complete about 3 minutes after the minute they describe. */
const METRICS_LAG_SECONDS = 180;

/** Stack output key prefix of each configuration's URL (CDK appends an 8-character hash). */
const URL_OUTPUTS: Record<string, [stack: string, prefix: string]> = {
  "event-noop": ["Gekko10EventStack", "EventNoopUrl"],
  "event-dsql-each": ["Gekko10EventStack", "EventDsqlEachUrl"],
  "event-dsql-reuse": ["Gekko10EventStack", "EventDsqlReuseUrl"],
  "web-noop": ["Gekko10WebStack", "WebNoopEndpointUrl"],
  "web-dsql-each": ["Gekko10WebStack", "WebDsqlEachEndpointUrl"],
  "web-dsql-pool": ["Gekko10WebStack", "WebDsqlPoolEndpointUrl"],
  "web-dsql-pool10": ["Gekko10WebStack", "WebDsqlPool10EndpointUrl"],
};

const aws = (...args: string[]) => execFileSync("aws", [...args, "--region", REGION], { encoding: "utf8" }).trim();
const outputs = (stack: string): Record<string, string> =>
  Object.fromEntries((JSON.parse(aws("cloudformation", "describe-stacks", "--stack-name", stack, "--query", "Stacks[0].Outputs", "--output", "json")) as { OutputKey: string; OutputValue: string }[]).map((o) => [o.OutputKey, o.OutputValue]));

function urlOf(config: string, cache: Map<string, Record<string, string>>): string {
  const [stack, prefix] = URL_OUTPUTS[config] ?? [];
  if (!stack) throw new Error(`unknown configuration: ${config}`);
  if (!cache.has(stack)) cache.set(stack, outputs(stack));
  const key = Object.keys(cache.get(stack)!).find((k) => new RegExp(`^${prefix}[0-9A-F]{8}$`).test(k));
  if (!key) throw new Error(`stack ${stack} has no output ${prefix}* (is ${config} deployed?)`);
  return cache.get(stack)![key];
}

function main() {
  const { values } = parseArgs({
    options: {
      suite: { type: "string", default: "measurement" },
      sets: { type: "string" },
      seed: { type: "string" },
      only: { type: "string" },
      "first-wait": { type: "string", default: "60" },
      "min-idle": { type: "string" },
      out: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "skip-preflight": { type: "boolean", default: false },
      "allow-dirty": { type: "boolean", default: false },
    },
  });
  const suiteName = values.suite as keyof typeof SUITES;
  const cases = SUITES[suiteName];
  if (!cases) throw new Error(`unknown suite: ${values.suite} (measurement | calibration)`);
  const today = new Date().toLocaleDateString("sv-SE");
  const seed = values.seed ?? `${suiteName}-${today}`;
  const out = values.out ?? `results/${today}`;
  const only = values.only?.split(",");
  const sets = (values.sets ?? (suiteName === "calibration" ? "2" : "1,2,3")).split(",").map(Number);

  const build = buildId();
  if (build.endsWith("-dirty") && !values["allow-dirty"]) {
    console.error(`the code has uncommitted changes (build ${build}). Commit first: a measurement must say which commit it measured.`);
    process.exit(1);
  }

  const cache = new Map<string, Record<string, string>>();
  const configs = [...new Set(cases.flatMap((c) => c.configs))].filter((n) => !only || only.includes(n));
  const urls = Object.fromEntries(configs.map((n) => [n, urlOf(n, cache)]));
  const clusterId = outputs("Gekko10DbStack")["Identifier"];
  if (!clusterId) throw new Error("Gekko10DbStack has no Identifier output");

  const plan: Plan = buildPlan({
    protocol: `${PROTOCOL}/${suiteName}`,
    sets,
    seed,
    build,
    urls,
    cases,
    only,
    firstWait: Number(values["first-wait"]),
    minIdleSeconds: values["min-idle"] ? Number(values["min-idle"]) : suiteName === "calibration" ? 300 : undefined,
    post: { clusterId, metricsLagSeconds: METRICS_LAG_SECONDS },
  });

  const total = estimateSeconds(plan) + postSeconds(plan);
  const hours = total / 3600;
  const fmt = (d: Date) => d.toLocaleString("sv-SE", { hour12: false }).slice(0, 16);
  console.log(`${plan.protocol}, seed ${seed}, build ${build}, ${plan.runs.length} runs`);
  let t = Date.now();
  for (const r of plan.runs) {
    t += r.waitSeconds * 1000;
    console.log(`  set ${r.set} #${r.index} ${r.case.padEnd(3)} ${r.name.padEnd(17)} wait ${String(r.waitSeconds).padStart(4)}s  starts ~${fmt(new Date(t))}`);
    t += runDuration(plan, r) * 1000;
  }
  console.log(`expected: ${hours.toFixed(2)} h (including the post-processing), ends ~${fmt(new Date(Date.now() + total * 1000))}; Fargate about $${(hours * FARGATE_USD_PER_HOUR).toFixed(2)} (plus Lambda/DSQL for the requests)`);

  const planJson = JSON.stringify(plan);
  console.log(`plan size: ${planJson.length} characters (limit about ${MAX_OVERRIDE_CHARS})`);
  if (planJson.length > MAX_OVERRIDE_CHARS) {
    console.error("the plan is too long for the task override. Use fewer sets or cases per task.");
    process.exit(1);
  }
  if (values["dry-run"]) {
    console.log("dry run: nothing started");
    return;
  }

  if (!values["skip-preflight"]) {
    // One request to each function: it must answer with the build the plan expects (a stale deployment would waste the whole run).
    for (const [name, url] of Object.entries(urls)) {
      const raw = execFileSync("npx", ["tsx", "scripts/invoke.ts", url, "--path", "/app/item"], { encoding: "utf8" });
      const body = JSON.parse(raw.slice(raw.indexOf("{"))) as { build?: string };
      if (body.build !== build) {
        console.error(`preflight: ${name} answered with build ${body.build ?? "(none)"}, the plan expects ${build}. Deploy the current commit first.`);
        process.exit(1);
      }
    }
    console.log(`preflight: ${Object.keys(urls).length} functions answer with build ${build}`);
  }

  const stack = outputs("Gekko10LoadStack");
  const cluster = stack["ClusterName"];
  const running = aws("ecs", "list-tasks", "--cluster", cluster, "--query", "length(taskArns)", "--output", "text");
  if (running !== "0" && !values.force) {
    console.error(`${running} task(s) are already running in ${cluster}. Runs would overlap on the shared DSQL cluster; use --force to start anyway.`);
    process.exit(1);
  }

  const network = JSON.stringify({
    awsvpcConfiguration: { subnets: stack["SubnetIds"].split(","), securityGroups: [stack["SecurityGroupId"]], assignPublicIp: "ENABLED" },
  });
  const overrides = JSON.stringify({ containerOverrides: [{ name: "Loadgen", command: ["/app/suite-runner.mjs", planJson] }] });
  const taskArn = aws(
    "ecs", "run-task", "--cluster", cluster, "--task-definition", stack["TaskDefinitionArn"],
    "--launch-type", "FARGATE", "--network-configuration", network, "--overrides", overrides, "--count", "1",
    "--query", "tasks[0].taskArn", "--output", "text",
  );
  const taskId = taskArn.split("/").pop()!;

  // What the measurement ran on, for the record (read-only calls; a failure here does not stop the task that is already running).
  const tryAws = (...args: string[]) => {
    try {
      return JSON.parse(aws(...args));
    } catch (e) {
      return { error: (e as Error).message.split("\n")[0] };
    }
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(
    `${out}/suite-${taskId}.start.json`,
    JSON.stringify(
      {
        taskId,
        startedAt: new Date().toISOString(),
        expectedSeconds: total,
        git: { head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), build },
        quotas: { lambda: tryAws("lambda", "get-account-settings", "--output", "json"), web: tryAws("lambda-web", "get-web-account-settings", "--output", "json") },
        plan,
      },
      null,
      1,
    ),
  );

  console.log(`\nstarted task ${taskId}`);
  console.log("It runs to the end by itself (waits, load, metrics, analysis); this PC may sleep.");
  console.log(`  stop:   aws ecs stop-task --cluster ${cluster} --task ${taskId} --region ${REGION}`);
  console.log(`  fetch:  npm run suite-fetch -- --task ${taskId} --wait     (after login: aws sso login)`);
  console.log("The log is kept for 30 days (Gekko10LoadStack).");
}

main();
