import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { WebFunctionService } from "./constructs/web-function-service.js";

/** One Web Function with one IamAuth endpoint, no DB. maxConcurrencyPerEnvironment stays at the default 64. */
export class Gekko10WebStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    new WebFunctionService(this, "WebNoop", {
      name: "gekko10-web-noop",
      endpointName: "main",
      variant: "web-noop",
      maxConcurrencyPerEnvironment: 64,
      codePath: "dist/web",
    });
  }
}
