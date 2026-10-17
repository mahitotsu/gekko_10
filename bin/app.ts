import { App } from "aws-cdk-lib";
import { Gekko10EventStack } from "../lib/event-stack.js";
import { Gekko10WebStack } from "../lib/web-stack.js";

const app = new App();
// Fixed to Tokyo; the account comes from the CLI credentials.
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: "ap-northeast-1" };

new Gekko10EventStack(app, "Gekko10EventStack", { env });
new Gekko10WebStack(app, "Gekko10WebStack", { env });
