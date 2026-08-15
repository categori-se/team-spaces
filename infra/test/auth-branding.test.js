// @ts-check

import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import {Template} from "aws-cdk-lib/assertions";
import {cognitoManagedLoginUrl, teamSpacesManagedLoginAssets, teamSpacesManagedLoginSettings} from "../lib/auth-branding.js";
import {TeamSpacesStack} from "../lib/teamspaces-stack.js";

/** @param {Record<string, unknown>} [context] */
function managedLoginTemplate(context = {}) {
  const app = new cdk.App({
    context: {
      webBucketName: "teamspaces-auth-branding-test",
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
      originVerifyEnforced: "false",
      existingUserPoolId: "us-east-1_TESTPOOL",
      authDomainName: "auth.example.com",
      managedLoginDomainPrefix: "auth-example-111111111111",
      ...context
    }
  });
  const stack = new TeamSpacesStack(app, "ManagedLoginTestStack", {
    env: {account: "111111111111", region: "us-east-1"}
  });
  return Template.fromStack(stack).toJSON();
}

test("defines adaptive Team Spaces light and dark branding", () => {
  assert.equal(cognitoManagedLoginUrl("auth-example", "us-east-1"), "https://auth-example.auth.us-east-1.amazoncognito.com");
  assert.equal(cognitoManagedLoginUrl("auth-example", "cn-north-1"), "https://auth-example.auth.cn-north-1.amazoncognito.com.cn");
  assert.equal(cognitoManagedLoginUrl("auth-example", "us-gov-west-1"), "https://auth-example.auth-fips.us-gov-west-1.amazoncognito.com");
  assert.equal(teamSpacesManagedLoginSettings.categories.global.colorSchemeMode, "DYNAMIC");
  assert.deepEqual(teamSpacesManagedLoginSettings.components.pageBackground, {
    darkMode: {color: "0b1018ff"},
    image: {enabled: false},
    lightMode: {color: "fbfcfbff"}
  });
  assert.equal(teamSpacesManagedLoginSettings.components.primaryButton.lightMode.defaults.backgroundColor, "12836fff");
  assert.equal(teamSpacesManagedLoginSettings.components.primaryButton.darkMode.defaults.backgroundColor, "2dd4bfff");
  assert.equal(teamSpacesManagedLoginSettings.componentClasses.focusState.lightMode.borderColor, "5267d8ff");
  assert.equal(teamSpacesManagedLoginSettings.componentClasses.focusState.darkMode.borderColor, "8b9cffff");
  assert.equal(teamSpacesManagedLoginSettings.componentClasses.input.lightMode.defaults.borderColor, "7b8794ff");
  assert.equal(teamSpacesManagedLoginSettings.componentClasses.input.darkMode.defaults.borderColor, "657284ff");

  const assets = teamSpacesManagedLoginAssets();
  assert.deepEqual(assets.map(({category, colorMode}) => `${category}:${colorMode}`).sort(), [
    "FAVICON_SVG:DYNAMIC",
    "FORM_LOGO:DARK",
    "FORM_LOGO:LIGHT"
  ]);
  for (const asset of assets) {
    assert.equal("resourceId" in asset, false, `${asset.category} must not send an unsupported Cognito resourceId`);
    const decoded = Buffer.from(asset.bytes, "base64");
    assert.ok(decoded.length > 0 && decoded.length < 1_000_000);
    const svg = decoded.toString("utf8");
    assert.match(svg, /^<svg[\s>]/);
    assert.doesNotMatch(svg, /data-operator-asset/);
  }
});

test("loads an operator branding directory through the stack context", (t) => {
  const assetDirectory = mkdtempSync(path.join(tmpdir(), "teamspaces-auth-branding-"));
  t.after(() => rmSync(assetDirectory, {recursive: true, force: true}));
  const filenames = [
    "team-spaces-logo-light.svg",
    "team-spaces-logo-dark.svg",
    "team-spaces-favicon.svg"
  ];
  for (const [index, filename] of filenames.entries()) {
    writeFileSync(
      path.join(assetDirectory, filename),
      `<svg xmlns="http://www.w3.org/2000/svg" data-operator-asset="${index}"></svg>\n`
    );
  }

  const template = managedLoginTemplate({managedLoginBrandingAssetDirectory: assetDirectory});
  const branding = Object.values(template.Resources ?? {}).find(
    (resource) => resource.Type === "AWS::Cognito::ManagedLoginBranding"
  );
  assert.ok(branding);
  assert.deepEqual(
    branding.Properties.Assets.map((asset) => Buffer.from(asset.Bytes, "base64").toString("utf8")),
    filenames.map((_, index) => `<svg xmlns="http://www.w3.org/2000/svg" data-operator-asset="${index}"></svg>\n`)
  );
});

test("rejects ambiguous or invalid custom branding assets", () => {
  assert.throws(
    () => teamSpacesManagedLoginAssets({assetDirectory: "infra/assets/auth"}),
    /must be an absolute path/
  );

  const assetDirectory = mkdtempSync(path.join(tmpdir(), "teamspaces-auth-branding-invalid-"));
  try {
    writeFileSync(path.join(assetDirectory, "team-spaces-logo-light.svg"), "not an svg\n");
    assert.throws(
      () => teamSpacesManagedLoginAssets({assetDirectory}),
      /must be an SVG document/
    );
  } finally {
    rmSync(assetDirectory, {recursive: true, force: true});
  }
});

test("provisions Managed Login v2 on the existing Cognito prefix endpoint", () => {
  const template = managedLoginTemplate();
  const resources = template.Resources ?? {};
  const brandingEntry = Object.entries(resources).find(([, resource]) => resource.Type === "AWS::Cognito::ManagedLoginBranding");
  assert.ok(brandingEntry);
  const [brandingLogicalId, branding] = brandingEntry;
  assert.equal(branding.Properties.UserPoolId, "us-east-1_TESTPOOL");
  assert.deepEqual(branding.Properties.ClientId, {Ref: "UserPoolClient2F5918F7"});
  assert.equal(branding.Properties.Settings.categories.global.colorSchemeMode, "DYNAMIC");
  assert.equal(branding.Properties.Assets.length, 3);

  const upgradeEntry = Object.entries(resources).find(([, resource]) => (
    resource.Type === "Custom::AWS"
    && typeof resource.Properties.Create === "string"
    && resource.Properties.Create.includes("updateUserPoolDomain")
  ));
  assert.ok(upgradeEntry);
  const [upgradeLogicalId, upgrade] = upgradeEntry;
  const upgradeCall = JSON.parse(upgrade.Properties.Create);
  assert.equal(upgradeCall.service, "CognitoIdentityServiceProvider");
  assert.equal(upgradeCall.parameters.Domain, "auth-example-111111111111");
  assert.equal(upgradeCall.parameters.ManagedLoginVersion, 2);
  assert.ok(branding.DependsOn?.includes(upgradeLogicalId));

  const upgradePolicy = Object.values(resources).find((resource) => (
    resource.Type === "AWS::IAM::Policy"
    && JSON.stringify(resource.Properties).includes("cognito-idp:UpdateUserPoolDomain")
  ));
  assert.ok(upgradePolicy);
  const policyStatement = upgradePolicy.Properties.PolicyDocument.Statement[0];
  assert.notEqual(policyStatement.Resource, "*");
  assert.match(JSON.stringify(policyStatement.Resource), /userpool\/us-east-1_TESTPOOL/);

  assert.equal(Object.values(resources).some((resource) => resource.Type === "AWS::Cognito::UserPoolDomain"), false);
  const runtimeConfig = Object.values(resources).find((resource) => (
    resource.Type === "Custom::AWS"
    && JSON.stringify(resource.Properties).includes("runtime-config.json")
  ));
  assert.ok(runtimeConfig.DependsOn?.includes(brandingLogicalId));
  assert.match(
    JSON.stringify(runtimeConfig.Properties),
    /https:\/\/auth-example-111111111111\.auth\.us-east-1\.amazoncognito\.com/
  );
  assert.ok(template.Outputs.ManagedLoginBrandingId);
});

test("keeps the hosted rollout default on the existing custom domain", () => {
  const template = managedLoginTemplate({useManagedLogin: "false"});
  const resources = Object.values(template.Resources ?? {});
  const runtimeConfig = resources.find((resource) => (
    resource.Type === "Custom::AWS"
    && JSON.stringify(resource.Properties).includes("runtime-config.json")
  ));
  assert.match(JSON.stringify(runtimeConfig?.Properties), /https:\/\/auth\.example\.com/);
  assert.doesNotMatch(JSON.stringify(runtimeConfig?.Properties), /auth-example-111111111111\.auth\.us-east-1/);
  assert.equal(resources.some((resource) => resource.Type === "AWS::Cognito::ManagedLoginBranding"), true);

  const deployScript = readFileSync(path.resolve("scripts/deploy-hosted.mjs"), "utf8");
  assert.match(deployScript, /TEAMSPACES_USE_MANAGED_LOGIN \|\| "false"/);
});
