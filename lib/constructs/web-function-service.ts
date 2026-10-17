import * as cdk from "aws-cdk-lib";
import { ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

export interface WebFunctionServiceProps {
  /** Web Function name (<= 64 chars). One Web Function per measured configuration. */
  readonly name: string;
  readonly endpointName: string;
  /** Value of APP_VARIANT, echoed in every response. */
  readonly variant: string;
  /** Upper bound of the dynamic per-environment concurrency (1-128). */
  readonly maxConcurrencyPerEnvironment?: number;
  readonly timeout?: Duration;
  readonly environment?: Record<string, string>;
  /** Directory holding the bundle; index.js must be at its root. */
  readonly codePath: string;
}

/**
 * Web Function + one revision + one HomeRegion IamAuth endpoint, written with L1 constructs
 * (aws-cdk-lib has no L2 for Web Functions). Code is delivered through a dedicated versioned
 * bucket because Web Functions only accept S3 code and the bucket policy must name the Lambda service.
 */
export class WebFunctionService extends Construct {
  public readonly endpointDomainName: string;

  constructor(scope: Construct, id: string, props: WebFunctionServiceProps) {
    super(scope, id);
    const stack = Stack.of(this);

    const bucket = new s3.Bucket(this, "CodeBucket", {
      versioned: true,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const functionArn = stack.formatArn({
      service: "lambda",
      resource: "web-function",
      resourceName: props.name,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });

    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowLambdaWebFunctionCodeAccess",
        principals: [new iam.ServicePrincipal("lambda.amazonaws.com")],
        actions: ["s3:GetObject", "s3:GetObjectVersion"],
        resources: [bucket.arnForObjects("*")],
        conditions: { ArnLike: { "aws:SourceArn": `${functionArn}/revision/*` } },
      }),
    );

    // extract: false keeps the zip as a single object; its key contains the content hash.
    const deployment = new s3deploy.BucketDeployment(this, "CodeDeployment", {
      sources: [s3deploy.Source.asset(props.codePath)],
      destinationBucket: bucket,
      destinationKeyPrefix: "code",
      extract: false,
      prune: false,
    });

    const regionalLogGroup = new logs.LogGroup(this, "LocalLogGroup", {
      logGroupName: `/aws/lambda/web/${props.name}.local`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const centralLogGroup = new logs.LogGroup(this, "CentralLogGroup", {
      logGroupName: `/aws/lambda/web/${props.name}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const role = new iam.Role(this, "ExecutionRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [
          `${centralLogGroup.logGroupArn}`,
          `${centralLogGroup.logGroupArn}:*`,
          // The .local group exists in every Region where the endpoint runs, so the Region is a wildcard.
          `arn:${stack.partition}:logs:*:${stack.account}:log-group:/aws/lambda/web/${props.name}.local`,
          `arn:${stack.partition}:logs:*:${stack.account}:log-group:/aws/lambda/web/${props.name}.local:*`,
        ],
      }),
    );

    const webFunction = new lambda.CfnWebFunction(this, "WebFunction", {
      functionName: props.name,
    });

    const revision = new lambda.CfnWebFunctionRevision(this, "Revision", {
      functionName: webFunction.attrFunctionArn,
      description: "app bundle",
      buildConfig: {
        codeConfig: {
          s3Object: { bucket: bucket.bucketName, key: cdk.Fn.select(0, deployment.objectKeys) },
        },
        runtimeConfig: { runtime: "nodejs24.x" },
      },
      serviceConfig: {
        executionRoleArn: role.roleArn,
        timeoutSeconds: (props.timeout ?? Duration.seconds(30)).toSeconds(),
        maxConcurrencyPerEnvironment: props.maxConcurrencyPerEnvironment ?? 64,
        environmentVariables: { APP_VARIANT: props.variant, ...props.environment },
      },
    });
    // The bucket policy and the log groups must exist before Lambda reads the code / writes logs.
    revision.node.addDependency(deployment, bucket.policy!, regionalLogGroup, centralLogGroup, role);

    const endpoint = new lambda.CfnWebFunctionEndpoint(this, "Endpoint", {
      functionName: webFunction.attrFunctionArn,
      endpointName: props.endpointName,
      endpointType: "HomeRegion",
      authType: "IamAuth",
      revisionWeights: [{ revisionId: revision.attrRevisionId, weight: 100 }],
    });

    this.endpointDomainName = endpoint.attrDomainName;

    new CfnOutput(this, "EndpointUrl", { value: `https://${endpoint.attrDomainName}` });
    new CfnOutput(this, "EndpointArn", { value: endpoint.attrEndpointArn });
    new CfnOutput(this, "FunctionName", { value: props.name });
  }
}
