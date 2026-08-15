// @ts-check

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import {Template} from "aws-cdk-lib/assertions";
import {TeamSpacesStack} from "../lib/teamspaces-stack.js";

/** @param {Record<string, unknown>} [contextOverrides] */
function synthesizedTemplate(contextOverrides = {}) {
  const app = new cdk.App({
    context: {
      webBucketName: "teamspaces-test",
      generateWebBucketName: "false",
      domainName: "hosted.example.com",
      certificateArn: "arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-0000-0000-000000000000",
      budgetEmail: "alerts@example.com",
      enablePublicDemo: "true",
      enableOperations: "true",
      enablePitr: "true",
      allowLocalAttachmentOrigins: "false",
      allowLocalDevelopmentOrigins: "false",
      workspaceName: "Team Spaces Pilot",
      applicationTag: "teamspaces",
      environmentTag: "production",
      ownerTag: "hosted",
      costCenterTag: "teamspaces",
      originVerifySecret: "test-origin-secret",
      originVerifyNextSecret: "test-next-origin-secret",
      originVerifySecretSlot: "primary",
      originVerifyEnforced: "false",
      ...contextOverrides
    }
  });
  const stack = new TeamSpacesStack(app, "TestStack", {
    env: {account: "111111111111", region: "us-east-1"}
  });
  return Template.fromStack(stack).toJSON();
}

test("does not synthesize prohibited infrastructure", () => {
  const template = synthesizedTemplate();
  const prohibited = [
    "AWS::EC2::Instance",
    "AWS::EC2::NatGateway",
    "AWS::RDS::DBInstance",
    "AWS::RDS::DBCluster",
    "AWS::ECS::Service",
    "AWS::EKS::Cluster",
    "AWS::ElasticLoadBalancingV2::LoadBalancer",
    "AWS::ElastiCache::CacheCluster",
    "AWS::OpenSearchService::Domain",
    "AWS::EFS::FileSystem",
    "AWS::KMS::Key"
  ];
  const resources = Object.values(template.Resources ?? {});
  for (const type of prohibited) {
    assert.equal(resources.some((resource) => resource.Type === type), false, `${type} must not be present`);
  }
});

test("keeps DynamoDB and bucket guardrails", () => {
  const template = synthesizedTemplate();
  const resources = Object.values(template.Resources ?? {});
  const tables = resources.filter((resource) => resource.Type === "AWS::DynamoDB::Table");
  assert.equal(tables.length, 2);
  assert.equal(tables.every((table) => (table.Properties.GlobalSecondaryIndexes ?? []).length === 2), true);
  const protectedTable = tables.find((table) => table.Properties.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled === true);
  const demoTable = tables.find((table) => table.Properties.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled === false);
  assert.ok(protectedTable);
  assert.ok(demoTable);

  const buckets = resources.filter((resource) => resource.Type === "AWS::S3::Bucket");
  assert.ok(buckets.length >= 2);
  for (const bucket of buckets) {
    assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true
    });
  }
});

test("does not enable Lambda provisioned concurrency", () => {
  const template = synthesizedTemplate();
  const resources = Object.values(template.Resources ?? {});
  assert.equal(resources.some((resource) => resource.Type === "AWS::Lambda::Alias" && resource.Properties?.ProvisionedConcurrencyConfig), false);
});

test("pins newly managed Cognito pools to the low-cost Lite plan", () => {
  const template = synthesizedTemplate();
  const resources = Object.values(template.Resources ?? {});
  const userPool = resources.find((resource) => resource.Type === "AWS::Cognito::UserPool");
  assert.equal(userPool.Properties.UserPoolTier, "LITE");
});

test("caps pay-per-use throughput and request concurrency", () => {
  const template = synthesizedTemplate();
  const resources = Object.values(template.Resources ?? {});
  const table = resources.find((resource) => (
    resource.Type === "AWS::DynamoDB::Table"
    && resource.Properties.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled === true
  ));
  assert.deepEqual(table.Properties.OnDemandThroughput, {
    MaxReadRequestUnits: 500,
    MaxWriteRequestUnits: 200
  });
  for (const index of table.Properties.GlobalSecondaryIndexes ?? []) {
    assert.deepEqual(index.OnDemandThroughput, {
      MaxReadRequestUnits: 500,
      MaxWriteRequestUnits: 200
    });
  }

  const apiFunction = resources.find((resource) => (
    resource.Type === "AWS::Lambda::Function"
    && resource.Properties.Environment?.Variables?.ATTACHMENT_BUCKET_NAME
  ));
  assert.equal(apiFunction.Properties.ReservedConcurrentExecutions, 10);
  assert.equal(apiFunction.Properties.Environment.Variables.WORK_INDEX_READY, "false");
  assert.equal(apiFunction.Properties.Environment.Variables.ORIGIN_VERIFY_ENFORCED, "false");
  assert.equal(apiFunction.Properties.Environment.Variables.ORIGIN_VERIFY_SECRET, "test-origin-secret");
  assert.equal(apiFunction.Properties.Environment.Variables.ORIGIN_VERIFY_SECRET_NEXT, "test-next-origin-secret");

  const stageEntry = Object.entries(template.Resources ?? {}).find(([, resource]) => resource.Type === "AWS::ApiGatewayV2::Stage");
  assert.equal(stageEntry[0].startsWith("HttpApiDefaultStage"), true);
  const stage = stageEntry[1];
  assert.deepEqual(stage.Properties.DefaultRouteSettings, {
    ThrottlingBurstLimit: 50,
    ThrottlingRateLimit: 25
  });
  assert.deepEqual(stage.Properties.RouteSettings["ANY /api/v1/demo/{proxy+}"], {
    ThrottlingBurstLimit: 10,
    ThrottlingRateLimit: 2
  });
  assert.deepEqual(stage.Properties.RouteSettings["GET /api/v1/health"], {
    ThrottlingBurstLimit: 5,
    ThrottlingRateLimit: 1
  });
  const routeEntries = Object.entries(template.Resources ?? {})
    .filter(([, resource]) => resource.Type === "AWS::ApiGatewayV2::Route");
  const requiredRouteDependencies = routeEntries
    .filter(([, resource]) => new Set([
      "GET /api/v1/health",
      "ANY /api/v1/demo/{proxy+}"
    ]).has(resource.Properties.RouteKey))
    .map(([logicalId]) => logicalId);
  assert.equal(requiredRouteDependencies.length, 2);
  for (const logicalId of requiredRouteDependencies) {
    assert.ok(stage.DependsOn?.includes(logicalId), `HTTP stage must depend on ${logicalId}`);
  }

  const distribution = resources.find((resource) => resource.Type === "AWS::CloudFront::Distribution");
  assert.equal(distribution.Properties.DistributionConfig.PriceClass, "PriceClass_100");
});

test("isolates and bounds the unauthenticated public demo", () => {
  const template = synthesizedTemplate();
  const resources = Object.values(template.Resources ?? {});
  const demoTable = resources.find((resource) => (
    resource.Type === "AWS::DynamoDB::Table"
    && resource.Properties.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled === false
  ));
  assert.ok(demoTable);
  assert.deepEqual(demoTable.Properties.OnDemandThroughput, {
    MaxReadRequestUnits: 100,
    MaxWriteRequestUnits: 50
  });
  for (const index of demoTable.Properties.GlobalSecondaryIndexes ?? []) {
    assert.deepEqual(index.OnDemandThroughput, {
      MaxReadRequestUnits: 100,
      MaxWriteRequestUnits: 50
    });
  }

  const demoFunction = resources.find((resource) => (
    resource.Type === "AWS::Lambda::Function"
    && resource.Properties.Environment?.Variables?.PUBLIC_DEMO_MODE === "true"
  ));
  assert.ok(demoFunction);
  assert.equal(demoFunction.Properties.ReservedConcurrentExecutions, 10);
  assert.equal(demoFunction.Properties.Environment.Variables.PUBLIC_DEMO_MUTATION_LIMIT, "500");
  assert.equal(demoFunction.Properties.Environment.Variables.WORK_INDEX_READY, "true");
  assert.equal(demoFunction.Properties.Environment.Variables.ATTACHMENT_BUCKET_NAME, undefined);
  assert.ok(template.Outputs.PublicDemoApiFunctionName);
  assert.ok(template.Outputs.PublicDemoResetFunctionName);

  const routes = resources.filter((resource) => resource.Type === "AWS::ApiGatewayV2::Route");
  const publicRoute = routes.find((route) => route.Properties.RouteKey === "ANY /api/v1/demo/{proxy+}");
  const privateRoute = routes.find((route) => route.Properties.RouteKey === "ANY /api/v1/{proxy+}");
  assert.ok(publicRoute);
  assert.equal(publicRoute.Properties.AuthorizationType, "NONE");
  assert.ok(privateRoute.Properties.AuthorizerId);
  assert.equal(privateRoute.Properties.AuthorizationType, "JWT");

  const schedule = resources.find((resource) => resource.Type === "AWS::Scheduler::Schedule");
  assert.ok(schedule);
  assert.equal(schedule.Properties.ScheduleExpression, "cron(0 5 * * ? *)");
  assert.equal(schedule.Properties.ScheduleExpressionTimezone, "UTC");
  assert.deepEqual(schedule.Properties.FlexibleTimeWindow, {Mode: "OFF"});

  const policies = resources.filter((resource) => resource.Type === "AWS::IAM::Policy");
  const demoPolicies = policies.filter((policy) => JSON.stringify(policy).includes("PublicDemoTable"));
  assert.equal(demoPolicies.length > 0, true);
  assert.equal(demoPolicies.some((policy) => JSON.stringify(policy).includes("DataTable")), false);
  assert.equal(demoPolicies.some((policy) => JSON.stringify(policy).includes("dynamodb:Scan")), false);
});

test("keeps the public demo seed version synchronized across runtime and deployment", () => {
  const template = synthesizedTemplate();
  const resources = Object.entries(template.Resources ?? {});
  const demoApi = resources.find(([, resource]) => (
    resource.Type === "AWS::Lambda::Function"
    && resource.Properties.Environment?.Variables?.PUBLIC_DEMO_MODE === "true"
  ))?.[1];
  const resetFunction = resources.find(([logicalId, resource]) => (
    logicalId.startsWith("PublicDemoResetFunction")
    && resource.Type === "AWS::Lambda::Function"
  ))?.[1];
  const initialSeed = resources.find(([logicalId, resource]) => (
    logicalId.startsWith("PublicDemoInitialSeed")
    && resource.Type === "AWS::CloudFormation::CustomResource"
  ))?.[1];

  assert.ok(demoApi);
  assert.ok(resetFunction);
  assert.ok(initialSeed);
  const expectedSeedVersion = "2";
  assert.equal(demoApi.Properties.Environment.Variables.PUBLIC_DEMO_SEED_VERSION, expectedSeedVersion);
  assert.equal(resetFunction.Properties.Environment.Variables.PUBLIC_DEMO_SEED_VERSION, expectedSeedVersion);
  assert.equal(initialSeed.Properties.seedVersion, expectedSeedVersion);
});

test("keeps public demo page fan-out within its Lambda concurrency ceiling", () => {
  assert.throws(
    () => synthesizedTemplate({publicDemoReservedConcurrency: 9}),
    /publicDemoReservedConcurrency must be an integer at least as large as publicDemoApiBurstLimit/
  );
});

test("expires stale web versions and abandoned pending uploads", () => {
  const template = synthesizedTemplate();
  const resources = Object.values(template.Resources ?? {});
  const buckets = resources.filter((resource) => resource.Type === "AWS::S3::Bucket");
  const webBucket = buckets.find((bucket) => !bucket.Properties.CorsConfiguration);
  const attachmentBucket = buckets.find((bucket) => bucket.Properties.CorsConfiguration);
  assert.equal(webBucket.Properties.LifecycleConfiguration?.Rules?.some((rule) => (
    rule.NoncurrentVersionExpiration?.NoncurrentDays === 30
  )), true);
  assert.equal(attachmentBucket.Properties.LifecycleConfiguration?.Rules?.some((rule) => (
    rule.ExpirationInDays === 1
    && rule.NoncurrentVersionExpiration?.NoncurrentDays === 1
    && rule.TagFilters?.some((tag) => tag.Key === "state" && tag.Value === "pending")
  )), true);
  assert.equal(attachmentBucket.Properties.CorsConfiguration.CorsRules[0].AllowedHeaders.includes("if-none-match"), true);
});

test("deploys revalidated pages and immutable hashed assets while preserving runtime config", () => {
  const template = synthesizedTemplate();
  const resources = Object.values(template.Resources ?? {});
  const deployments = resources.filter((resource) => resource.Type === "Custom::CDKBucketDeployment");
  assert.equal(deployments.length, 2);
  const pageDeployment = deployments.find((deployment) => deployment.Properties.Exclude?.includes("runtime-config.json"));
  const assetDeployment = deployments.find((deployment) => deployment.Properties.Include?.includes("_observablehq/*"));
  assert.equal(pageDeployment.Properties.Prune, true);
  for (const prefix of ["_file/*", "_import/*", "_node/*", "_observablehq/*"]) {
    assert.equal(pageDeployment.Properties.Exclude.includes(prefix), true);
  }
  assert.equal(pageDeployment.Properties.SystemMetadata?.["cache-control"], "no-cache, must-revalidate");
  assert.equal(assetDeployment.Properties.Prune, false);
  assert.equal(assetDeployment.Properties.SystemMetadata?.["cache-control"], "public, max-age=31536000, immutable");
  assert.deepEqual(assetDeployment.Properties.DistributionPaths, ["/*"]);
});

test("rewrites extensionless and trailing-slash page routes to built HTML files", () => {
  const template = synthesizedTemplate();
  const resources = Object.values(template.Resources ?? {});
  const rewriteFunction = resources.find((resource) => (
    resource.Type === "AWS::CloudFront::Function"
    && resource.Properties.FunctionCode.includes("/index.html")
  ));
  const handler = Function(`${rewriteFunction.Properties.FunctionCode}\nreturn handler;`)();

  assert.equal(handler({request: {uri: "/"}}).uri, "/index.html");
  assert.equal(handler({request: {uri: "/app"}}).uri, "/app.html");
  assert.equal(handler({request: {uri: "/app/"}}).uri, "/app.html");
});

test("rejects oversized public-demo bodies at the CloudFront edge", () => {
  const template = synthesizedTemplate();
  const resources = Object.values(template.Resources ?? {});
  const guardFunction = resources.find((resource) => (
    resource.Type === "AWS::CloudFront::Function"
    && resource.Properties.FunctionCode.includes("isBoundedPublicRoute")
  ));
  assert.ok(guardFunction);
  const handler = Function(`${guardFunction.Properties.FunctionCode}\nreturn handler;`)();
  const request = (method, uri, headers = {}) => ({request: {method, uri, headers}});

  assert.equal(handler(request("GET", "/api/v1/demo/bootstrap")).uri, "/api/v1/demo/bootstrap");
  assert.equal(handler(request("GET", "/api/v1/demo/bootstrap", {"content-length": {value: "1"}})).statusCode, 413);
  assert.equal(handler(request("PATCH", "/api/v1/demo/projects/demo", {"content-length": {value: "8192"}})).uri, "/api/v1/demo/projects/demo");
  assert.equal(handler(request("PATCH", "/api/v1/demo/projects/demo", {"content-length": {value: "8193"}})).statusCode, 413);
  assert.equal(handler(request("PATCH", "/api/v1/demo/projects/demo")).statusCode, 413);
  assert.equal(handler(request("GET", "/api/v1/health", {"content-length": {value: "1"}})).statusCode, 413);
  assert.equal(handler(request("GET", "/api/v1/bootstrap", {"content-length": {value: "999999"}})).uri, "/api/v1/bootstrap");

  const distribution = resources.find((resource) => resource.Type === "AWS::CloudFront::Distribution");
  const apiBehavior = distribution.Properties.DistributionConfig.CacheBehaviors
    .find((behavior) => behavior.PathPattern === "api/*");
  assert.equal(apiBehavior.FunctionAssociations.length, 1);
  assert.equal(apiBehavior.FunctionAssociations[0].EventType, "viewer-request");
});

test("keeps API errors intact and disables runtime configuration caching", () => {
  const template = synthesizedTemplate();
  const resources = Object.values(template.Resources ?? {});
  const distribution = resources.find((resource) => resource.Type === "AWS::CloudFront::Distribution");
  const config = distribution.Properties.DistributionConfig;
  assert.equal(config.CustomErrorResponses, undefined);
  const runtimeBehavior = config.CacheBehaviors.find((behavior) => behavior.PathPattern === "runtime-config.json");
  assert.ok(runtimeBehavior);
  const apiBehavior = config.CacheBehaviors.find((behavior) => behavior.PathPattern === "api/*");
  assert.equal(runtimeBehavior.CachePolicyId, apiBehavior.CachePolicyId);
  const apiOrigin = config.Origins.find((origin) => origin.Id === apiBehavior.TargetOriginId);
  assert.equal(apiOrigin.OriginCustomHeaders.some((header) => (
    header.HeaderName === "x-teamspaces-origin-secret" && header.HeaderValue === "test-origin-secret"
  )), true);

  const responseHeadersPolicy = resources.find((resource) => resource.Type === "AWS::CloudFront::ResponseHeadersPolicy");
  const contentSecurityPolicy = responseHeadersPolicy.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig
    .ContentSecurityPolicy.ContentSecurityPolicy;
  assert.equal(JSON.stringify(contentSecurityPolicy).includes("RegionalDomainName"), true);
});

test("stages origin verification and selects a rotation-safe CloudFront secret", () => {
  const template = synthesizedTemplate({
    originVerifySecretSlot: "next",
    originVerifyEnforced: "true"
  });
  const resources = Object.values(template.Resources ?? {});
  const apiFunction = resources.find((resource) => (
    resource.Type === "AWS::Lambda::Function"
    && resource.Properties.Environment?.Variables?.TABLE_NAME
  ));
  assert.equal(apiFunction.Properties.Environment.Variables.ORIGIN_VERIFY_ENFORCED, "true");
  assert.equal(apiFunction.Properties.Environment.Variables.ORIGIN_VERIFY_SECRET, "test-origin-secret");
  assert.equal(apiFunction.Properties.Environment.Variables.ORIGIN_VERIFY_SECRET_NEXT, "test-next-origin-secret");

  const distribution = resources.find((resource) => resource.Type === "AWS::CloudFront::Distribution");
  const apiBehavior = distribution.Properties.DistributionConfig.CacheBehaviors
    .find((behavior) => behavior.PathPattern === "api/*");
  const apiOrigin = distribution.Properties.DistributionConfig.Origins
    .find((origin) => origin.Id === apiBehavior.TargetOriginId);
  assert.equal(apiOrigin.OriginCustomHeaders.some((header) => (
    header.HeaderName === "x-teamspaces-origin-secret"
    && header.HeaderValue === "test-next-origin-secret"
  )), true);
});

test("requires an explicit enforcement phase when an origin secret is configured", () => {
  assert.throws(
    () => synthesizedTemplate({originVerifyEnforced: undefined}),
    /originVerifyEnforced must be explicitly set/
  );
});

test("wires production alarms and upload-tag permissions", () => {
  const template = synthesizedTemplate();
  const resources = Object.values(template.Resources ?? {});
  const alarms = resources.filter((resource) => resource.Type === "AWS::CloudWatch::Alarm");
  assert.equal(alarms.length >= 4, true);
  assert.equal(alarms.every((alarm) => (alarm.Properties.AlarmActions ?? []).length > 0), true);
  assert.equal(resources.some((resource) => resource.Type === "AWS::SNS::Subscription"), true);
  const policies = resources.filter((resource) => resource.Type === "AWS::IAM::Policy");
  const actions = policies.flatMap((policy) => (
    policy.Properties.PolicyDocument.Statement ?? []
  )).flatMap((statement) => statement.Action ?? []);
  assert.equal(actions.includes("s3:PutObjectTagging"), true);
  assert.equal(actions.includes("s3:PutObjectVersionTagging"), true);
  assert.equal(JSON.stringify(policies).includes("/documents/*"), true);
});

test("uses a replacement-safe name for the five-dollar budget", () => {
  const template = synthesizedTemplate();
  const budgets = Object.entries(template.Resources ?? {}).filter(([, resource]) => resource.Type === "AWS::Budgets::Budget");
  assert.equal(budgets.length, 1);
  assert.equal(budgets[0][0].startsWith("Budget5"), true);
  assert.match(budgets[0][1].Properties.Budget.BudgetName, /^teamspaces-5-usd-[a-f0-9]{12}$/);
  assert.equal(budgets[0][1].Properties.NotificationsWithSubscribers.length, 4);
});

test("changes the budget name when replacement-only subscribers change", () => {
  const firstTemplate = synthesizedTemplate({budgetEmail: "alerts@example.com"});
  const secondTemplate = synthesizedTemplate({budgetEmail: "finance@example.com"});
  const budgetName = (template) => Object.values(template.Resources ?? {})
    .find((resource) => resource.Type === "AWS::Budgets::Budget")
    .Properties.Budget.BudgetName;
  assert.notEqual(budgetName(firstTemplate), budgetName(secondTemplate));
});

test("keeps GitHub OIDC trust pinned to immutable ids across repository renames", () => {
  const bootstrap = readFileSync(new URL("../bootstrap/github-actions.yaml", import.meta.url), "utf8");
  assert.match(bootstrap, /GitHubRepositoryName:\n\s+Type: String\n\s+GitHubRepositoryId:/);
  assert.doesNotMatch(bootstrap, /GitHubRepositoryName:\n\s+Type: String\n\s+Default:/);
  assert.match(
    bootstrap,
    /repo:\*@\$\{GitHubOrganizationId\}\/\*@\$\{GitHubRepositoryId\}:environment:\$\{GitHubEnvironmentName\}/
  );
  assert.doesNotMatch(
    bootstrap,
    /token\.actions\.githubusercontent\.com:sub: !Sub[\s\S]+GitHubRepositoryName@\$\{GitHubRepositoryId\}/
  );
});
