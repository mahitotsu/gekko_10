import { ArnFormat, CfnOutput, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

/** Event Functions the load generator may call (function URL, IAM auth). */
const EVENT_FUNCTIONS = ["gekko10-event-noop", "gekko10-event-dsql-each", "gekko10-event-dsql-reuse"];
/** Web Functions the load generator may call (endpoint "main", IAM auth). */
const WEB_FUNCTIONS = ["gekko10-web-noop", "gekko10-web-dsql-each", "gekko10-web-dsql-pool", "gekko10-web-dsql-pool10"];

/**
 * Load generator: scripts/invoke.ts in a Fargate task, started on demand with scripts/load-run.sh.
 *
 * Nothing here costs money while idle. There is no service, VPC, NAT Gateway, VPC endpoint or load balancer: the
 * task runs in the account's default VPC and gets a public IP at run-task time (assignPublicIp=ENABLED), which it
 * needs to pull its image from ECR and to write to CloudWatch Logs. The only thing that stays billed is the image
 * in the CDK bootstrap ECR repository.
 */
export class Gekko10LoadStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Looked up when the CDK CLI runs (cached in cdk.context.json); needs an explicit account and Region.
    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    // Passing the VPC keeps ecs.Cluster from creating its own. No capacity, no Container Insights.
    const cluster = new ecs.Cluster(this, "Cluster", { vpc });

    // No inbound rules; the task only makes outbound calls.
    const securityGroup = new ec2.SecurityGroup(this, "TaskSecurityGroup", {
      vpc,
      description: "gekko10 load generator (outbound only)",
      allowAllOutbound: true,
    });

    const logGroup = new logs.LogGroup(this, "LogGroup", {
      // A long P1 run is fetched afterwards (npm run p1-fetch), possibly days later.
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // 2 vCPU / 4 GB: signing and sending requests is CPU work, and the generator must not saturate before the target.
    // x86_64 matches the machine that builds the image, so no emulation is needed.
    const taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDefinition", {
      cpu: 2048,
      memoryLimitMiB: 4096,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    taskDefinition.addContainer("Loadgen", {
      image: ecs.ContainerImage.fromAsset("load", { platform: Platform.LINUX_AMD64 }),
      // The arguments of invoke.ts are supplied per run (scripts/load-run.sh overrides the command).
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "loadgen", logGroup }),
    });

    // Only the functions under test, with the actions their auth types need.
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunctionUrl"],
        resources: EVENT_FUNCTIONS.map((name) =>
          this.formatArn({ service: "lambda", resource: "function", resourceName: name, arnFormat: ArnFormat.COLON_RESOURCE_NAME }),
        ),
      }),
    );
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeWebFunctionEndpoint"],
        resources: WEB_FUNCTIONS.map((name) =>
          this.formatArn({
            service: "lambda",
            resource: "web-function",
            resourceName: `${name}/endpoint/main`,
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ),
      }),
    );

    // Post-processing inside the task (scripts/suite-post.ts) reads the metrics of the runs and the REPORT lines of the Event
    // Functions. Read-only; GetMetricData and GetQueryResults do not support resource-level permissions.
    taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ["cloudwatch:GetMetricData"], resources: ["*"] }));
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["logs:StartQuery"],
        resources: [this.formatArn({ service: "logs", resource: "log-group", resourceName: "/aws/lambda/gekko10-event-*:*", arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
      }),
    );
    taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ["logs:GetQueryResults", "logs:StopQuery"], resources: ["*"] }));

    // Everything scripts/load-run.sh needs to call run-task.
    new CfnOutput(this, "ClusterName", { value: cluster.clusterName });
    new CfnOutput(this, "TaskDefinitionArn", { value: taskDefinition.taskDefinitionArn });
    new CfnOutput(this, "SubnetIds", { value: vpc.publicSubnets.map((s) => s.subnetId).join(",") });
    new CfnOutput(this, "SecurityGroupId", { value: securityGroup.securityGroupId });
    new CfnOutput(this, "LogGroupName", { value: logGroup.logGroupName });
  }
}
