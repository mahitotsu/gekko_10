import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { EventFunctionService } from "./constructs/event-function-service.js";

/** Event Functions + function URL, no DB. Memory 1 GB for now (512 MB / 3.5 GB variants come later). */
export class Gekko10EventStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    new EventFunctionService(this, "EventNoop", {
      name: "gekko10-event-noop",
      variant: "event-noop",
      memorySize: 1024,
    });
  }
}
