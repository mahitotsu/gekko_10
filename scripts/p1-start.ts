// Starts a P1 plan as ONE Fargate task that runs to the end by itself (scripts/p1-runner.ts), so the local PC may sleep
// and the AWS login may expire while it runs. Fetch the results afterwards with `npm run p1-fetch`.
//
//   npm run p1-start -- --sets 1,2 --seed 20261019 [--only web-noop,event-noop] [--steps 25,50,100,200,400,800,1600]
//                       [--step-seconds 90] [--first-wait 60] [--dry-run] [--force]
//
// --dry-run prints the plan (order, waits, expected end, cost) without starting anything.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildPlan, estimateSeconds, type Plan } from "./p1-plan.js";

const REGION = "ap-northeast-1";
/** Fargate 2 vCPU / 4 GB x86_64 plus a public IPv4, per hour (docs/findings.md 3-2). */
const FARGATE_USD_PER_HOUR = 2 * 0.05056 + 4 * 0.00553 + 0.005;
/** The task overrides must stay below 8,192 characters. */
const MAX_OVERRIDE_CHARS = 7500;

const URL_OUTPUTS: Record<string, [stack: string, key: string]> = {
  "event-noop": ["Gekko10EventStack", "EventNoopUrl16BA62E3"],
  "event-dsql-each": ["Gekko10EventStack", "EventDsqlEachUrlB9815F25"],
  "event-dsql-reuse": ["Gekko10EventStack", "EventDsqlReuseUrl74056B16"],
  "web-noop": ["Gekko10WebStack", "WebNoopEndpointUrl671499AD"],
  "web-dsql-each": ["Gekko10WebStack", "WebDsqlEachEndpointUrl8E361FAA"],
  "web-dsql-pool": ["Gekko10WebStack", "WebDsqlPoolEndpointUrl41C2D2DB"],
};

const aws = (...args: string[]) => execFileSync("aws", [...args, "--region", REGION], { encoding: "utf8" }).trim();
const stackOutput = (stack: string, key: string) =>
  aws("cloudformation", "describe-stacks", "--stack-name", stack, "--query", `Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]`, "--output", "text");

const { values } = parseArgs({
  options: {
    sets: { type: "string", default: "1" },
    seed: { type: "string" },
    only: { type: "string" },
    steps: { type: "string", default: "25,50,100,200,400,800,1600" },
    "step-seconds": { type: "string", default: "90" },
    "first-wait": { type: "string", default: "60" },
    out: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  },
});

const today = new Date().toLocaleDateString("sv-SE");
const seed = values.seed ?? `p1-${today}`;
const out = values.out ?? `results/${today}`;
const only = values.only?.split(",");
const needed = Object.keys(URL_OUTPUTS).filter((n) => !only || only.includes(n));
const urls = Object.fromEntries(needed.map((n) => [n, stackOutput(...URL_OUTPUTS[n])]));

const plan: Plan = buildPlan({
  sets: values.sets!.split(",").map(Number),
  seed,
  urls,
  only,
  steps: values.steps!.split(",").map(Number),
  stepSeconds: Number(values["step-seconds"]),
  firstWait: Number(values["first-wait"]),
});

const total = estimateSeconds(plan);
const hours = total / 3600;
const fmt = (d: Date) => d.toLocaleString("sv-SE", { hour12: false }).slice(0, 16);
console.log(`seed ${seed}, steps ${plan.steps.join(",")} x ${plan.stepSeconds}s, ${plan.runs.length} runs`);
let t = Date.now();
for (const r of plan.runs) {
  t += r.waitSeconds * 1000;
  console.log(`  set ${r.set} #${r.index} ${r.name.padEnd(17)} wait ${String(r.waitSeconds).padStart(4)}s  starts ~${fmt(new Date(t))}`);
  t += (plan.steps.length * plan.stepSeconds + 45) * 1000;
}
console.log(`expected: ${hours.toFixed(2)} h, ends ~${fmt(new Date(t))}; Fargate about $${(hours * FARGATE_USD_PER_HOUR).toFixed(2)} (plus Lambda/DSQL for the requests)`);

const planJson = JSON.stringify(plan);
if (planJson.length > MAX_OVERRIDE_CHARS) {
  console.error(`the plan is ${planJson.length} characters; the task override limit is about ${MAX_OVERRIDE_CHARS}. Use fewer sets per task.`);
  process.exit(1);
}
if (values["dry-run"]) {
  console.log("dry run: nothing started");
  process.exit(0);
}

const cluster = stackOutput("Gekko10LoadStack", "ClusterName");
const running = aws("ecs", "list-tasks", "--cluster", cluster, "--query", "length(taskArns)", "--output", "text");
if (running !== "0" && !values.force) {
  console.error(`${running} task(s) are already running in ${cluster}. Runs would overlap on the shared DSQL cluster; use --force to start anyway.`);
  process.exit(1);
}

const network = JSON.stringify({
  awsvpcConfiguration: {
    subnets: stackOutput("Gekko10LoadStack", "SubnetIds").split(","),
    securityGroups: [stackOutput("Gekko10LoadStack", "SecurityGroupId")],
    assignPublicIp: "ENABLED",
  },
});
const overrides = JSON.stringify({ containerOverrides: [{ name: "Loadgen", command: ["/app/p1-runner.mjs", planJson] }] });
const taskArn = aws(
  "ecs", "run-task", "--cluster", cluster, "--task-definition", stackOutput("Gekko10LoadStack", "TaskDefinitionArn"),
  "--launch-type", "FARGATE", "--network-configuration", network, "--overrides", overrides, "--count", "1",
  "--query", "tasks[0].taskArn", "--output", "text",
);
const taskId = taskArn.split("/").pop()!;

mkdirSync(out, { recursive: true });
writeFileSync(`${out}/p1-${taskId}.plan.json`, JSON.stringify({ taskId, startedAt: new Date().toISOString(), expectedSeconds: total, plan }, null, 1));

console.log(`\nstarted task ${taskId}`);
console.log("It runs to the end by itself; this PC may sleep.");
console.log(`  stop:   aws ecs stop-task --cluster ${cluster} --task ${taskId} --region ${REGION}`);
console.log(`  fetch:  npm run p1-fetch -- --task ${taskId} --wait     (after login: aws sso login)`);
console.log("Fetch within 30 days (logs) and about 15 days (1-minute metrics).");
