import { App } from "aws-cdk-lib";
import { Gekko10DbStack } from "../lib/db-stack.js";
import { Gekko10EventStack } from "../lib/event-stack.js";
import { Gekko10LoadStack } from "../lib/load-stack.js";
import { Gekko10WebStack } from "../lib/web-stack.js";

const app = new App();
// Fixed to Tokyo; the account comes from the CLI credentials.
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: "ap-northeast-1" };

// The cluster holds state, so it lives in its own stack. The function stacks import its endpoint and ARN
// (CDK adds the stack dependency); delete them first, the cluster last.
const db = new Gekko10DbStack(app, "Gekko10DbStack", { env });
const dsql = { endpoint: db.endpoint, clusterArn: db.clusterArn };
new Gekko10EventStack(app, "Gekko10EventStack", { env, dsql });
new Gekko10WebStack(app, "Gekko10WebStack", { env, dsql });

// Load generator (Fargate task, started on demand). Independent of the stacks above.
new Gekko10LoadStack(app, "Gekko10LoadStack", { env });
