import { Stack, StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import type { DsqlTarget } from "./event-stack.js";
import { WebFunctionService } from "./constructs/web-function-service.js";

export interface Gekko10WebStackProps extends StackProps {
  readonly dsql: DsqlTarget;
}

const MAX_CONCURRENCY = 64;

/**
 * One entry per measured Web configuration. Each is its own Web Function: the metrics have no revision dimension and
 * the learned concurrency limit is kept per function, so configurations must not share one.
 */
const WEB_CONFIGS: { id: string; name: string; dbMode?: "each" | "pool"; poolMax?: number }[] = [
  { id: "WebNoop", name: "gekko10-web-noop" },
  { id: "WebDsqlEach", name: "gekko10-web-dsql-each", dbMode: "each" },
  // The pool as large as the per-environment concurrency (64): it never has to wait.
  { id: "WebDsqlPool", name: "gekko10-web-dsql-pool", dbMode: "pool" },
  // A pool of 10: the node-postgres default and the low end of AWS's 10-20 per application instance (docs/plan.md §8).
  { id: "WebDsqlPool10", name: "gekko10-web-dsql-pool10", dbMode: "pool", poolMax: 10 },
];

/**
 * Every Web Function, each with one IamAuth endpoint. The DSQL ones connect as the "admin" role, which needs
 * dsql:DbConnectAdmin on the cluster only. maxConcurrencyPerEnvironment is 64, and the pool max equals it.
 */
export class Gekko10WebStack extends Stack {
  constructor(scope: Construct, id: string, props: Gekko10WebStackProps) {
    super(scope, id, props);

    for (const c of WEB_CONFIGS) {
      const svc = new WebFunctionService(this, c.id, {
        name: c.name,
        endpointName: "main",
        variant: c.name.replace("gekko10-", ""),
        maxConcurrencyPerEnvironment: MAX_CONCURRENCY,
        codePath: "dist/web",
        environment: c.dbMode
          ? {
              DB_MODE: c.dbMode,
              DSQL_ENDPOINT: props.dsql.endpoint,
              ...(c.dbMode === "pool" ? { DB_POOL_MAX: String(c.poolMax ?? MAX_CONCURRENCY) } : {}),
            }
          : undefined,
      });
      if (c.dbMode) {
        svc.role.addToPolicy(new iam.PolicyStatement({ actions: ["dsql:DbConnectAdmin"], resources: [props.dsql.clusterArn] }));
      }
    }
  }
}
