#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import {TeamSpacesStack} from "../lib/teamspaces-stack.js";

const app = new cdk.App();

new TeamSpacesStack(app, "TeamSpacesProd", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1"
  },
  stackName: app.node.tryGetContext("stackName") ?? "teamspaces-community"
});
