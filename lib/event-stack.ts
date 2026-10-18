import { Stack, StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { EventFunctionService } from "./constructs/event-function-service.js";

export interface DsqlTarget {
  readonly endpoint: string;
  readonly clusterArn: string;
}

export interface Gekko10EventStackProps extends StackProps {
  readonly dsql: DsqlTarget;
}

/** One entry per measured Event configuration; adding a variant (e.g. another memory size) is one more entry. */
const EVENT_CONFIGS: { id: string; name: string; memorySize: number; dbMode?: "each" | "reuse" }[] = [
  { id: "EventNoop", name: "gekko10-event-noop", memorySize: 1024 },
  { id: "EventDsqlEach", name: "gekko10-event-dsql-each", memorySize: 1024, dbMode: "each" },
  { id: "EventDsqlReuse", name: "gekko10-event-dsql-reuse", memorySize: 1024, dbMode: "reuse" },
];

/**
 * Every Event Function + function URL. The DSQL ones connect as the "admin" role, which needs dsql:DbConnectAdmin
 * on the cluster only. Memory is 1 GB for now (512 MB / 3.5 GB variants come later).
 */
export class Gekko10EventStack extends Stack {
  constructor(scope: Construct, id: string, props: Gekko10EventStackProps) {
    super(scope, id, props);

    for (const c of EVENT_CONFIGS) {
      const svc = new EventFunctionService(this, c.id, {
        name: c.name,
        variant: c.name.replace("gekko10-", ""),
        memorySize: c.memorySize,
        environment: c.dbMode ? { DB_MODE: c.dbMode, DSQL_ENDPOINT: props.dsql.endpoint } : undefined,
      });
      if (c.dbMode) {
        svc.function.addToRolePolicy(
          new iam.PolicyStatement({ actions: ["dsql:DbConnectAdmin"], resources: [props.dsql.clusterArn] }),
        );
      }
    }
  }
}
