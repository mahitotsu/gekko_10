import { CfnOutput, Duration, RemovalPolicy } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export interface EventFunctionServiceProps {
  /** Function name, also used as the output prefix. */
  readonly name: string;
  /** Value of APP_VARIANT, echoed in every response. */
  readonly variant: string;
  readonly memorySize: number;
  readonly timeout?: Duration;
  readonly environment?: Record<string, string>;
}

/** Event Function (arm64, Node.js 24) behind an IAM-authenticated function URL. */
export class EventFunctionService extends Construct {
  public readonly function: lambda.Function;
  public readonly url: lambda.FunctionUrl;

  constructor(scope: Construct, id: string, props: EventFunctionServiceProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: `/aws/lambda/${props.name}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.function = new lambda.Function(this, "Function", {
      functionName: props.name,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: props.memorySize,
      timeout: props.timeout ?? Duration.seconds(30),
      handler: "index.handler",
      code: lambda.Code.fromAsset("dist/event"),
      logGroup,
      environment: { APP_VARIANT: props.variant, ...props.environment },
    });

    this.url = this.function.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    new CfnOutput(this, "Url", { value: this.url.url });
    new CfnOutput(this, "FunctionArn", { value: this.function.functionArn });
  }
}
