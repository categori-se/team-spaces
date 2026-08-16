// @ts-check

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import {Template} from "aws-cdk-lib/assertions";
import {TeamSpacesStack} from "../lib/teamspaces-stack.js";
import {communityConfiguration} from "../../scripts/deploy-community.mjs";

const baseContext = {
  domainName: "community.example.com",
  certificateArn: "arn:aws:acm:us-east-1:111111111111:certificate/community",
  generateWebBucketName: "true",
  enablePublicDemo: "false",
  enableOperations: "false",
  enablePitr: "false",
  allowLocalDevelopmentOrigins: "false",
  workspaceName: "Community Workspace",
  applicationTag: "team-spaces-community",
  environmentTag: "community",
  ownerTag: "self-hosted",
  costCenterTag: "team-spaces-community"
};

/** @param {Record<string, unknown>} [contextOverrides] */
function synthesizedTemplate(contextOverrides = {}) {
  const app = new cdk.App({context: {...baseContext, ...contextOverrides}});
  const stack = new TeamSpacesStack(app, "CommunityProfileTest", {
    env: {account: "111111111111", region: "us-east-1"}
  });
  return Template.fromStack(stack).toJSON();
}

/** @param {Record<string, any>} template */
function resourceCounts(template) {
  return Object.values(template.Resources ?? {}).reduce((counts, resource) => {
    counts[resource.Type] = (counts[resource.Type] ?? 0) + 1;
    return counts;
  }, {});
}

/**
 * @param {Record<string, number>} before
 * @param {Record<string, number>} after
 */
function resourceDelta(before, after) {
  return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .map((type) => [type, (after[type] ?? 0) - (before[type] ?? 0)])
    .filter(([, difference]) => difference !== 0));
}

test("community profile synthesizes a strict demand-priced core", () => {
  const template = synthesizedTemplate();
  const resources = Object.values(template.Resources ?? {});
  const prohibited = [
    "AWS::Budgets::Budget",
    "AWS::CloudWatch::Alarm",
    "AWS::EC2::Instance",
    "AWS::EC2::NatGateway",
    "AWS::ECS::Service",
    "AWS::EFS::FileSystem",
    "AWS::EKS::Cluster",
    "AWS::ElastiCache::CacheCluster",
    "AWS::ElasticLoadBalancingV2::LoadBalancer",
    "AWS::KMS::Key",
    "AWS::OpenSearchService::Domain",
    "AWS::RDS::DBCluster",
    "AWS::RDS::DBInstance",
    "AWS::Route53::HostedZone",
    "AWS::Scheduler::Schedule",
    "AWS::SNS::Subscription",
    "AWS::SNS::Topic",
    "AWS::SQS::Queue",
    "AWS::WAFv2::WebACL"
  ];
  for (const type of prohibited) {
    assert.equal(resources.some((resource) => resource.Type === type), false, `${type} must not be present`);
  }
  assert.equal(resources.some((resource) => (
    resource.Type === "AWS::Lambda::Alias" && resource.Properties?.ProvisionedConcurrencyConfig
  )), false);

  const tables = resources.filter((resource) => resource.Type === "AWS::DynamoDB::Table");
  assert.equal(tables.length, 1);
  assert.equal(tables[0].Properties.BillingMode, "PAY_PER_REQUEST");
  assert.deepEqual(tables[0].Properties.PointInTimeRecoverySpecification, {
    PointInTimeRecoveryEnabled: false
  });
  assert.equal(tables[0].Properties.GlobalSecondaryIndexes.length, 2);

  const routes = resources.filter((resource) => resource.Type === "AWS::ApiGatewayV2::Route");
  assert.equal(routes.some((route) => route.Properties.RouteKey.includes("/demo/")), false);
  assert.equal(template.Outputs.PublicDemoTableName, undefined);
  assert.equal(template.Outputs.PublicDemoApiFunctionName, undefined);
  assert.equal(template.Outputs.PublicDemoResetFunctionName, undefined);

  const runtimeConfig = resources.find((resource) => (
    resource.Type === "Custom::AWS" && JSON.stringify(resource).includes("runtime-config.json")
  ));
  assert.match(JSON.stringify(runtimeConfig?.Properties).replaceAll("\\", ""), /"enabled": false/);

  const buckets = resources.filter((resource) => resource.Type === "AWS::S3::Bucket");
  assert.equal(buckets.length, 2);
  assert.equal(buckets.every((bucket) => bucket.Properties.BucketName === undefined), true);
  assert.equal(buckets.every((bucket) => bucket.Properties.PublicAccessBlockConfiguration?.RestrictPublicBuckets), true);

  const userPool = resources.find((resource) => resource.Type === "AWS::Cognito::UserPool");
  assert.equal(userPool.Properties.UserPoolTier, "LITE");
  assert.equal(userPool.Properties.MfaConfiguration, "OPTIONAL");
  assert.deepEqual(userPool.Properties.EnabledMfas, ["SOFTWARE_TOKEN_MFA"]);
  assert.equal(resources.filter((resource) => resource.Type === "AWS::Cognito::UserPoolDomain").length, 1);

  const cloudFrontFunctions = resources.filter((resource) => resource.Type === "AWS::CloudFront::Function");
  assert.equal(cloudFrontFunctions.length, 1);
  assert.equal(cloudFrontFunctions.some((resource) => resource.Properties.FunctionCode.includes("isBoundedPublicRoute")), false);
  const distribution = resources.find((resource) => resource.Type === "AWS::CloudFront::Distribution");
  const apiBehavior = distribution.Properties.DistributionConfig.CacheBehaviors
    .find((behavior) => behavior.PathPattern === "api/*");
  assert.equal(apiBehavior.FunctionAssociations, undefined);
});

test("raw CDK defaults select the community profile and generated resource names", () => {
  const app = new cdk.App();
  const stack = new TeamSpacesStack(app, "RawCommunityDefaults", {
    env: {account: "111111111111", region: "us-east-1"}
  });
  const template = Template.fromStack(stack).toJSON();
  const resources = Object.values(template.Resources ?? {});

  assert.equal(resources.filter((resource) => resource.Type === "AWS::DynamoDB::Table").length, 1);
  assert.equal(resources.some((resource) => resource.Type === "AWS::Budgets::Budget"), false);
  assert.equal(resources.some((resource) => resource.Type === "AWS::CloudWatch::Alarm"), false);
  assert.equal(resources.some((resource) => resource.Type === "AWS::Scheduler::Schedule"), false);
  assert.equal(
    resources.filter((resource) => resource.Type === "AWS::S3::Bucket")
      .every((resource) => resource.Properties.BucketName === undefined),
    true
  );
  const apiFunction = resources.find((resource) => (
    resource.Type === "AWS::Lambda::Function"
    && resource.Properties.Environment?.Variables?.TABLE_NAME
  ));
  assert.equal(apiFunction.Properties.Environment.Variables.WORKSPACE_NAME, "Team Spaces");
  assert.equal(apiFunction.Properties.Environment.Variables.APP_ORIGIN, "https://team-spaces.example.com");
  const dataTable = resources.find((resource) => resource.Type === "AWS::DynamoDB::Table");
  assert.deepEqual(dataTable.Properties.PointInTimeRecoverySpecification, {
    PointInTimeRecoveryEnabled: false
  });
  assert.equal(
    resources.some((resource) => resource.Properties?.Tags?.some((tag) => (
      tag.Key === "environment" && tag.Value === "community"
    ))),
    true
  );
  assert.equal(
    resources.some((resource) => resource.Properties?.Tags?.some((tag) => (
      tag.Key === "owner" && tag.Value === "self-hosted"
    ))),
    true
  );

  const entry = readFileSync(new URL("../bin/teamspaces.js", import.meta.url), "utf8");
  assert.match(entry, /stackName.*\?\? "teamspaces-community"/);
  assert.doesNotMatch(entry, /\?\? "teamspaces-prod"/);
  assert.throws(
    () => synthesizedTemplate({generateWebBucketName: "false", webBucketName: undefined}),
    /webBucketName is required when generateWebBucketName is false/
  );
});

test("community profile excludes localhost unless a developer opts in", () => {
  const community = synthesizedTemplate();
  assert.doesNotMatch(JSON.stringify(community), /http:\/\/(?:localhost|127\.0\.0\.1)/);

  const localDevelopment = synthesizedTemplate({allowLocalDevelopmentOrigins: "true"});
  const resources = Object.values(localDevelopment.Resources ?? {});
  const client = resources.find((resource) => resource.Type === "AWS::Cognito::UserPoolClient");
  assert.equal(client.Properties.CallbackURLs.includes("http://localhost:3000/app"), true);
  assert.equal(client.Properties.LogoutURLs.includes("http://127.0.0.1:3004/"), true);

  const api = resources.find((resource) => resource.Type === "AWS::ApiGatewayV2::Api");
  assert.equal(api.Properties.CorsConfiguration.AllowOrigins.includes("http://localhost:3000"), true);
  const responseHeaders = resources.find((resource) => resource.Type === "AWS::CloudFront::ResponseHeadersPolicy");
  assert.match(JSON.stringify(responseHeaders), /http:\/\/localhost:8787/);
});

test("community profile bounds versions and every explicit provider log group", () => {
  const template = synthesizedTemplate();
  const resources = Object.values(template.Resources ?? {});
  const logGroups = resources.filter((resource) => resource.Type === "AWS::Logs::LogGroup");
  assert.equal(logGroups.length, 3);
  assert.equal(logGroups.every((logGroup) => Number.isInteger(logGroup.Properties.RetentionInDays)), true);

  const webBucket = resources.find((resource) => (
    resource.Type === "AWS::S3::Bucket" && !resource.Properties.CorsConfiguration
  ));
  const rules = webBucket.Properties.LifecycleConfiguration.Rules;
  assert.equal(rules.some((rule) => rule.NoncurrentVersionExpiration?.NoncurrentDays === 30), true);
  assert.equal(rules.some((rule) => rule.ExpiredObjectDeleteMarker === true), true);
});

test("optional public demo adds only its isolated request-priced lane", () => {
  const core = synthesizedTemplate();
  const demo = synthesizedTemplate({enablePublicDemo: "true"});
  assert.deepEqual(resourceDelta(resourceCounts(core), resourceCounts(demo)), {
    "AWS::ApiGatewayV2::Integration": 1,
    "AWS::ApiGatewayV2::Route": 1,
    "AWS::CloudFormation::CustomResource": 1,
    "AWS::CloudFront::Function": 1,
    "AWS::DynamoDB::Table": 1,
    "AWS::IAM::Policy": 4,
    "AWS::IAM::Role": 4,
    "AWS::Lambda::EventInvokeConfig": 1,
    "AWS::Lambda::Function": 3,
    "AWS::Lambda::Permission": 1,
    "AWS::Logs::LogGroup": 3,
    "AWS::SQS::Queue": 1,
    "AWS::Scheduler::Schedule": 1
  });
});

test("optional public demo hostname shares CloudFront while isolating browser and auth origins", () => {
  const withoutSeparateHostname = synthesizedTemplate({enablePublicDemo: "true"});
  const template = synthesizedTemplate({
    enablePublicDemo: "true",
    publicDemoDomainName: "demo.community.example.com"
  });
  const resources = Object.values(template.Resources ?? {});
  assert.deepEqual(resourceCounts(template), resourceCounts(withoutSeparateHostname));
  assert.equal(resources.filter((resource) => resource.Type === "AWS::CloudFront::Distribution").length, 1);
  const distribution = resources.find((resource) => resource.Type === "AWS::CloudFront::Distribution");
  assert.deepEqual(distribution.Properties.DistributionConfig.Aliases, [
    "community.example.com",
    "demo.community.example.com"
  ]);

  const api = resources.find((resource) => resource.Type === "AWS::ApiGatewayV2::Api");
  assert.deepEqual(api.Properties.CorsConfiguration.AllowOrigins, [
    "https://community.example.com",
    "https://demo.community.example.com"
  ]);
  const attachmentBucket = resources.find((resource) => (
    resource.Type === "AWS::S3::Bucket" && resource.Properties.CorsConfiguration
  ));
  assert.deepEqual(attachmentBucket.Properties.CorsConfiguration.CorsRules[0].AllowedOrigins, [
    "https://community.example.com"
  ]);

  const demoFunction = resources.find((resource) => (
    resource.Type === "AWS::Lambda::Function"
    && resource.Properties.Environment?.Variables?.PUBLIC_DEMO_MODE === "true"
  ));
  assert.equal(demoFunction.Properties.Environment.Variables.APP_ORIGIN, "https://demo.community.example.com");
  assert.equal(demoFunction.Properties.Environment.Variables.PUBLIC_DEMO_HOST_REQUIRED, "true");
  const apiFunction = resources.find((resource) => (
    resource.Type === "AWS::Lambda::Function"
    && resource.Properties.Environment?.Variables?.ATTACHMENT_BUCKET_NAME
  ));
  assert.equal(apiFunction.Properties.Environment.Variables.APP_ORIGIN, "https://community.example.com");

  const client = resources.find((resource) => resource.Type === "AWS::Cognito::UserPoolClient");
  assert.equal(client.Properties.CallbackURLs.includes("https://community.example.com/app"), true);
  assert.equal(client.Properties.CallbackURLs.some((url) => url.includes("demo.community.example.com")), false);
  assert.equal(client.Properties.LogoutURLs.includes("https://community.example.com"), true);
  assert.equal(client.Properties.LogoutURLs.some((url) => url.includes("demo.community.example.com")), false);

  const runtimeConfig = resources.find((resource) => (
    resource.Type === "Custom::AWS" && JSON.stringify(resource).includes("runtime-config.json")
  ));
  const serializedRuntime = JSON.stringify(runtimeConfig.Properties).replaceAll("\\", "");
  assert.match(serializedRuntime, /"origin": "https:\/\/demo\.community\.example\.com"/);
  assert.match(serializedRuntime, /"redirectUri": "https:\/\/community\.example\.com\/app"/);
  assert.match(serializedRuntime, /"logoutUri": "https:\/\/community\.example\.com"/);
  assert.equal(template.Outputs.PublicDemoUrl.Value, "https://demo.community.example.com");

  assert.throws(
    () => synthesizedTemplate({enablePublicDemo: "false", publicDemoDomainName: "demo.community.example.com"}),
    /enablePublicDemo must be true/
  );
  assert.throws(
    () => synthesizedTemplate({enablePublicDemo: "true", publicDemoDomainName: "community.example.com"}),
    /must differ from domainName/
  );
  assert.throws(
    () => synthesizedTemplate({enablePublicDemo: "true", publicDemoDomainName: "demo.community.example.com", certificateArn: undefined}),
    /certificateArn is required/
  );
});

test("optional operations add four core alarms and notification resources without demo alarms", () => {
  const core = synthesizedTemplate();
  const operations = synthesizedTemplate({
    enableOperations: "true",
    budgetEmail: "owner@example.com"
  });
  assert.deepEqual(resourceDelta(resourceCounts(core), resourceCounts(operations)), {
    "AWS::Budgets::Budget": 1,
    "AWS::CloudWatch::Alarm": 4,
    "AWS::SNS::Subscription": 1,
    "AWS::SNS::Topic": 1
  });
});

test("PITR is an independent stored-data option with no service resource delta", () => {
  const core = synthesizedTemplate();
  const protectedCore = synthesizedTemplate({enablePitr: "true"});
  assert.deepEqual(resourceCounts(protectedCore), resourceCounts(core));
  const table = Object.values(protectedCore.Resources).find((resource) => resource.Type === "AWS::DynamoDB::Table");
  assert.deepEqual(table.Properties.PointInTimeRecoverySpecification, {
    PointInTimeRecoveryEnabled: true
  });
});

test("community deploy command opts out explicitly and contains no private deployment defaults", () => {
  const script = readFileSync(new URL("../../scripts/deploy-community.mjs", import.meta.url), "utf8");
  assert.match(script, /generateWebBucketName=true/);
  assert.match(script, /TEAMSPACES_DOMAIN_NAME/);
  assert.match(script, /ACM_CERTIFICATE_ARN/);
  assert.match(script, /TEAMSPACES_WORK_INDEX_READY/);
  assert.match(script, /TEAMSPACES_ENABLE_PUBLIC_DEMO/);
  assert.match(script, /TEAMSPACES_ENABLE_OPERATIONS/);
  assert.match(script, /TEAMSPACES_ENABLE_PITR/);
  assert.match(script, /TEAMSPACES_ALLOW_LOCAL_DEVELOPMENT_ORIGINS/);
  assert.match(script, /allowLocalDevelopmentOrigins=\$\{allowLocalDevelopmentOrigins\}/);
  assert.doesNotMatch(script, /--require-approval["', ]+never/);
  assert.doesNotMatch(script, /\b\d{12}\b|arn:(?:aws|aws-cn|aws-us-gov):|us-[a-z]+-\d+_[A-Za-z0-9]+/);
  assert.doesNotMatch(script, /AWS_PROFILE\s*(?:\?\?|\|\|)\s*["'][^"']+["']/);
});

test("hosted deployment explicitly restores every cost and identity profile setting", () => {
  const script = readFileSync(new URL("../../scripts/deploy-hosted.mjs", import.meta.url), "utf8");
  for (const context of [
    "generateWebBucketName=false",
    "enablePublicDemo=true",
    "enableOperations=true",
    "enablePitr=true",
    "allowLocalAttachmentOrigins=false",
    "allowLocalDevelopmentOrigins=false"
  ]) {
    assert.match(script, new RegExp(context.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const name of [
    "TEAMSPACES_DOMAIN_NAME",
    "ACM_CERTIFICATE_ARN",
    "TEAMSPACES_WEB_BUCKET_NAME",
    "EXISTING_USER_POOL_ID",
    "AUTH_DOMAIN_NAME",
    "COGNITO_MANAGED_LOGIN_DOMAIN_PREFIX"
  ]) {
    assert.match(script, new RegExp(`requiredEnvironment\\("${name}"\\)`));
  }
  assert.match(script, /TEAMSPACES_MANAGED_LOGIN_BRANDING_ASSET_DIRECTORY/);
  assert.match(script, /path\.isAbsolute\(managedLoginBrandingAssetDirectory\)/);
  for (const context of [
    "stackName=${stackName}",
    "webBucketName=${webBucketName}",
    "workspaceName=${workspaceName}",
    "applicationTag=${applicationTag}",
    "environmentTag=${environmentTag}",
    "ownerTag=${ownerTag}",
    "costCenterTag=${costCenterTag}"
  ]) {
    assert.equal(script.includes(context), true);
  }
  assert.doesNotMatch(
    script,
    /\b\d{12}\b|arn:(?:aws|aws-cn|aws-us-gov):|us-[a-z]+-\d+_[A-Za-z0-9]+|AWS_PROFILE\s*(?:\?\?|\|\|)\s*["'][^"']+["']/
  );
  assert.match(script, /TEAMSPACES_OWNER_TAG \|\| "hosted"/);
  assert.match(script, /SMOKE_URL=https:\/\/\$\{domainName\}/);
  assert.match(script, /APP_URL=https:\/\/\$\{domainName\}/);
});

test("community deploy validation accepts placeholders but rejects a non-us-east-1 certificate", () => {
  const configuration = (overrides = {}) => communityConfiguration({
    TEAMSPACES_DOMAIN_NAME: "community.example.com",
    ACM_CERTIFICATE_ARN: "arn:aws:acm:us-east-1:111111111111:certificate/community",
    TEAMSPACES_ENABLE_PUBLIC_DEMO: "false",
    TEAMSPACES_ENABLE_OPERATIONS: "false",
    TEAMSPACES_ENABLE_PITR: "false",
    TEAMSPACES_WORK_INDEX_READY: "false",
    TEAMSPACES_ALLOW_LOCAL_DEVELOPMENT_ORIGINS: "false",
    TEAMSPACES_BUDGET_EMAIL: "",
    ...overrides
  });

  const defaults = communityConfiguration({
    TEAMSPACES_DOMAIN_NAME: "community.example.com",
    ACM_CERTIFICATE_ARN: "arn:aws:acm:us-east-1:111111111111:certificate/replace-me"
  });
  assert.equal(defaults.enablePublicDemo, "false");
  assert.equal(defaults.enableOperations, "false");
  assert.equal(defaults.enablePitr, "false");
  assert.equal(defaults.allowLocalDevelopmentOrigins, "false");
  assert.equal(configuration().certificateArn.endsWith("/community"), true);
  assert.throws(
    () => configuration({ACM_CERTIFICATE_ARN: "arn:aws:acm:eu-west-1:111111111111:certificate/community"}),
    /us-east-1 ACM certificate ARN/
  );
  assert.throws(
    () => configuration({TEAMSPACES_ENABLE_PITR: "yes"}),
    /TEAMSPACES_ENABLE_PITR must be true or false/
  );
  assert.throws(
    () => configuration({TEAMSPACES_ENABLE_OPERATIONS: "true"}),
    /TEAMSPACES_BUDGET_EMAIL is required/
  );
  assert.throws(
    () => configuration({TEAMSPACES_PUBLIC_DEMO_DOMAIN_NAME: "demo.community.example.com"}),
    /TEAMSPACES_ENABLE_PUBLIC_DEMO must be true/
  );
  assert.throws(
    () => configuration({
      TEAMSPACES_ENABLE_PUBLIC_DEMO: "true",
      TEAMSPACES_PUBLIC_DEMO_DOMAIN_NAME: "community.example.com"
    }),
    /must differ from TEAMSPACES_DOMAIN_NAME/
  );
  assert.equal(configuration({
    TEAMSPACES_ENABLE_PUBLIC_DEMO: "true",
    TEAMSPACES_PUBLIC_DEMO_DOMAIN_NAME: "demo.community.example.com"
  }).publicDemoDomainName, "demo.community.example.com");
});
