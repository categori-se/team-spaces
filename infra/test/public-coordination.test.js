// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import {Template} from "aws-cdk-lib/assertions";
import {TeamSpacesStack} from "../lib/teamspaces-stack.js";

test("public coordination exposes throttled GETs for discovery and roadmaps on the canonical API while private routes retain JWT", () => {
  const app = new cdk.App({context: {
    domainName: "community.example.com",
    certificateArn: "arn:aws:acm:us-east-1:111111111111:certificate/community",
    generateWebBucketName: "true",
    enablePublicDemo: "false",
    enableOperations: "false",
    enablePitr: "false"
  }});
  const stack = new TeamSpacesStack(app, "PublicCoordinationBoundary", {env: {account: "111111111111", region: "us-east-1"}});
  const template = Template.fromStack(stack).toJSON();
  const entries = Object.entries(template.Resources);
  const publicRoutes = entries.filter(([, resource]) => resource.Type === "AWS::ApiGatewayV2::Route" && resource.Properties.RouteKey.includes("/api/v1/public/"));
  assert.equal(publicRoutes.length, 2);
  const [routeId, route] = publicRoutes.find(([, resource]) => resource.Properties.RouteKey.includes("/coordination/"));
  const [directoryId, directory] = publicRoutes.find(([, resource]) => resource.Properties.RouteKey === "GET /api/v1/public/projects");
  assert.equal(directory.Properties.AuthorizationType, "NONE");
  assert.equal(directory.Properties.AuthorizerId, undefined);
  assert.equal(route.Properties.RouteKey, "GET /api/v1/public/coordination/{initiativeId}");
  assert.equal(route.Properties.AuthorizationType, "NONE");
  assert.equal(route.Properties.AuthorizerId, undefined);
  const health = entries.find(([, resource]) => resource.Type === "AWS::ApiGatewayV2::Route" && resource.Properties.RouteKey === "GET /api/v1/health");
  assert.ok(health);
  assert.deepEqual(route.Properties.Target, health[1].Properties.Target);
  const privateRoute = entries.find(([, resource]) => resource.Type === "AWS::ApiGatewayV2::Route" && resource.Properties.RouteKey === "ANY /api/v1/{proxy+}");
  assert.ok(privateRoute);
  assert.equal(privateRoute[1].Properties.AuthorizationType, "JWT");
  assert.ok(privateRoute[1].Properties.AuthorizerId);
  const stage = entries.find(([, resource]) => resource.Type === "AWS::ApiGatewayV2::Stage");
  assert.ok(stage);
  assert.deepEqual(stage[1].Properties.RouteSettings[route.Properties.RouteKey], {ThrottlingRateLimit: 1, ThrottlingBurstLimit: 5});
  assert.ok(stage[1].DependsOn.includes(routeId));
  assert.ok(stage[1].DependsOn.includes(directoryId));
  assert.deepEqual(stage[1].Properties.RouteSettings[directory.Properties.RouteKey], {ThrottlingRateLimit: 1, ThrottlingBurstLimit: 5});
  assert.equal(entries.filter(([, resource]) => resource.Type === "AWS::DynamoDB::Table").length, 1);
  assert.ok(!JSON.stringify(template).includes("PUBLIC_DEMO_MODE"));
});
