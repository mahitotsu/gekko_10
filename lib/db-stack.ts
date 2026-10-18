import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import * as dsql from "aws-cdk-lib/aws-dsql";
import { Construct } from "constructs";

/**
 * The Aurora DSQL cluster, single Region, public endpoint (no VPC). Kept in its own stack so the cluster can be
 * created and checked from a laptop before any function that depends on it is deployed.
 */
export class Gekko10DbStack extends Stack {
  /** Cluster endpoint host name: <id>.dsql.<region>.on.aws */
  public readonly endpoint: string;
  public readonly clusterArn: string;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const cluster = new dsql.CfnCluster(this, "Cluster", {
      // Disabled so the cluster can be deleted once the experiment is over.
      deletionProtectionEnabled: false,
      tags: [{ key: "Name", value: "gekko10" }],
    });

    this.endpoint = cluster.attrEndpoint;
    this.clusterArn = cluster.attrResourceArn;

    new CfnOutput(this, "Endpoint", { value: cluster.attrEndpoint });
    new CfnOutput(this, "Identifier", { value: cluster.attrIdentifier });
    new CfnOutput(this, "Arn", { value: cluster.attrResourceArn });
  }
}
