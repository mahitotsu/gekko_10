import { App } from "aws-cdk-lib";
import { Gekko10DbStack } from "../lib/db-stack.js";
import { Gekko10DsqlStack } from "../lib/dsql-stack.js";
import { Gekko10EventStack } from "../lib/event-stack.js";
import { Gekko10WebStack } from "../lib/web-stack.js";

const app = new App();
// Fixed to Tokyo; the account comes from the CLI credentials.
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: "ap-northeast-1" };

new Gekko10EventStack(app, "Gekko10EventStack", { env });
new Gekko10WebStack(app, "Gekko10WebStack", { env });

const db = new Gekko10DbStack(app, "Gekko10DbStack", { env });
new Gekko10DsqlStack(app, "Gekko10DsqlStack", { env, dsqlEndpoint: db.endpoint, dsqlClusterArn: db.clusterArn });
