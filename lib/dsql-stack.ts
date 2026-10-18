import { Stack, StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { EventFunctionService } from "./constructs/event-function-service.js";
import { WebFunctionService } from "./constructs/web-function-service.js";

export interface Gekko10DsqlStackProps extends StackProps {
  readonly dsqlEndpoint: string;
  readonly dsqlClusterArn: string;
}

/**
 * The four DSQL configurations, one function each (a Web Function's metrics have no revision dimension and its
 * learned concurrency is per function, so configurations must not share one).
 *   Event + function URL: new connection per request / one connection reused within the environment
 *   Web Functions:        new connection per request / pool shared by concurrent requests
 * Both Event functions are 1 GB; both Web functions use maxConcurrencyPerEnvironment 64 and a pool max of 64.
 */
export class Gekko10DsqlStack extends Stack {
  constructor(scope: Construct, id: string, props: Gekko10DsqlStackProps) {
    super(scope, id, props);

    // The app connects as the DSQL "admin" role, which needs dsql:DbConnectAdmin on this cluster only.
    const connectAdmin = new iam.PolicyStatement({
      actions: ["dsql:DbConnectAdmin"],
      resources: [props.dsqlClusterArn],
    });

    for (const [id, mode] of [["EventDsqlEach", "each"], ["EventDsqlReuse", "reuse"]] as const) {
      const name = `gekko10-event-dsql-${mode}`;
      const svc = new EventFunctionService(this, id, {
        name,
        variant: name.replace("gekko10-", ""),
        memorySize: 1024,
        environment: { DB_MODE: mode, DSQL_ENDPOINT: props.dsqlEndpoint },
      });
      svc.function.addToRolePolicy(connectAdmin);
    }

    for (const [id, mode] of [["WebDsqlEach", "each"], ["WebDsqlPool", "pool"]] as const) {
      const name = `gekko10-web-dsql-${mode}`;
      const svc = new WebFunctionService(this, id, {
        name,
        endpointName: "main",
        variant: name.replace("gekko10-", ""),
        maxConcurrencyPerEnvironment: 64,
        codePath: "dist/web",
        environment: {
          DB_MODE: mode,
          DSQL_ENDPOINT: props.dsqlEndpoint,
          // The pool size only matters for the shared pool; it equals maxConcurrencyPerEnvironment.
          ...(mode === "pool" ? { DB_POOL_MAX: "64" } : {}),
        },
      });
      svc.role.addToPolicy(connectAdmin);
    }
  }
}
