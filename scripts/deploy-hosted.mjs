import {spawnSync} from "node:child_process";
import path from "node:path";

/** @param {string} name */
function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required for the hosted deployment profile`);
    process.exit(1);
  }
  return value;
}

const commandArgs = process.argv.slice(2);
const args = new Set(commandArgs);
const isSynth = args.has("--synth");
const noBuild = args.has("--no-build");
const cdkArgs = commandArgs.filter((argument) => !["--synth", "--no-build"].includes(argument));
const awsProfile = process.env.AWS_PROFILE || undefined;
const app = "node infra/bin/teamspaces.js";
const domainName = requiredEnvironment("TEAMSPACES_DOMAIN_NAME");
const certificateArn = requiredEnvironment("ACM_CERTIFICATE_ARN");
const webBucketName = requiredEnvironment("TEAMSPACES_WEB_BUCKET_NAME");
const existingUserPoolId = requiredEnvironment("EXISTING_USER_POOL_ID");
const authDomainName = requiredEnvironment("AUTH_DOMAIN_NAME");
const managedLoginDomainPrefix = requiredEnvironment("COGNITO_MANAGED_LOGIN_DOMAIN_PREFIX");
const managedLoginBrandingAssetDirectory = process.env.TEAMSPACES_MANAGED_LOGIN_BRANDING_ASSET_DIRECTORY?.trim();
if (managedLoginBrandingAssetDirectory && !path.isAbsolute(managedLoginBrandingAssetDirectory)) {
  console.error("TEAMSPACES_MANAGED_LOGIN_BRANDING_ASSET_DIRECTORY must be an absolute path");
  process.exit(1);
}
if (!/^arn:[a-z0-9-]+:acm:us-east-1:\d{12}:certificate\/[a-z0-9][a-z0-9-]*$/i.test(certificateArn)) {
  console.error("ACM_CERTIFICATE_ARN must be an us-east-1 ACM certificate ARN");
  process.exit(1);
}
const budgetEmail = process.env.TEAMSPACES_BUDGET_EMAIL;
const originVerifySecret = process.env.TEAMSPACES_ORIGIN_SECRET;
const originVerifyNextSecret = process.env.TEAMSPACES_ORIGIN_SECRET_NEXT;
const originVerifySecretSlot = process.env.TEAMSPACES_ORIGIN_SECRET_SLOT || "primary";
const originVerifyEnforcementValue = process.env.TEAMSPACES_ORIGIN_VERIFY_ENFORCED;
const useManagedLoginValue = process.env.TEAMSPACES_USE_MANAGED_LOGIN || "false";
const stackName = process.env.TEAMSPACES_STACK_NAME || "teamspaces-prod";
const workspaceName = process.env.TEAMSPACES_WORKSPACE_NAME || "Team Spaces Pilot";
const applicationTag = process.env.TEAMSPACES_APPLICATION_TAG || "teamspaces";
const environmentTag = process.env.TEAMSPACES_ENVIRONMENT_TAG || "production";
const ownerTag = process.env.TEAMSPACES_OWNER_TAG || "hosted";
const costCenterTag = process.env.TEAMSPACES_COST_CENTER_TAG || "teamspaces";
const hostedContext = [
  "-c", `stackName=${stackName}`,
  "-c", `domainName=${domainName}`,
  "-c", `certificateArn=${certificateArn}`,
  "-c", `webBucketName=${webBucketName}`,
  "-c", "generateWebBucketName=false",
  "-c", `existingUserPoolId=${existingUserPoolId}`,
  "-c", `authDomainName=${authDomainName}`,
  "-c", `managedLoginDomainPrefix=${managedLoginDomainPrefix}`,
  ...(managedLoginBrandingAssetDirectory
    ? ["-c", `managedLoginBrandingAssetDirectory=${managedLoginBrandingAssetDirectory}`]
    : []),
  "-c", `useManagedLogin=${useManagedLoginValue}`,
  "-c", "enablePublicDemo=true",
  "-c", "enableOperations=true",
  "-c", "enablePitr=true",
  "-c", "allowLocalAttachmentOrigins=false",
  "-c", "allowLocalDevelopmentOrigins=false",
  "-c", "apiRateLimit=25",
  "-c", "apiBurstLimit=50",
  "-c", "apiReservedConcurrency=10",
  "-c", "maxReadRequestUnits=500",
  "-c", "maxWriteRequestUnits=200",
  "-c", "publicDemoApiRateLimit=2",
  "-c", "publicDemoApiBurstLimit=10",
  "-c", "publicDemoReservedConcurrency=10",
  "-c", "publicDemoMaxReadRequestUnits=100",
  "-c", "publicDemoMaxWriteRequestUnits=50",
  "-c", `workIndexReady=${process.env.TEAMSPACES_WORK_INDEX_READY === "true"}`,
  "-c", `workspaceName=${workspaceName}`,
  "-c", `applicationTag=${applicationTag}`,
  "-c", `environmentTag=${environmentTag}`,
  "-c", `ownerTag=${ownerTag}`,
  "-c", `costCenterTag=${costCenterTag}`,
  ...(budgetEmail ? ["-c", `budgetEmail=${budgetEmail}`] : [])
];

/**
 * @param {string} event
 * @param {Record<string, unknown>} detail
 */
function log(event, detail = {}) {
  console.log(JSON.stringify({event, ...detail}));
}

/**
 * @param {string} command
 * @param {string[]} commandArgs
 * @param {{env?: Record<string, string | undefined>}} options
 */
function run(command, commandArgs, {env = {}} = {}) {
  log("deploy.command", {command: [command, ...commandArgs].join(" ")});
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      ...(awsProfile ? {AWS_PROFILE: awsProfile} : {}),
      ...env
    }
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

log(isSynth ? "deploy.synth.start" : "deploy.start", {
  credentialSource: awsProfile ? `profile:${awsProfile}` : "default-chain",
  domainName,
  stackName
});
if (!isSynth && !budgetEmail) {
  console.error("TEAMSPACES_BUDGET_EMAIL is required for production alarm and budget notifications");
  process.exit(1);
}
if (!isSynth && !originVerifySecret) {
  console.error("TEAMSPACES_ORIGIN_SECRET is required to restrict the regional API origin");
  process.exit(1);
}
if (!new Set(["primary", "next"]).has(originVerifySecretSlot)) {
  console.error("TEAMSPACES_ORIGIN_SECRET_SLOT must be primary or next");
  process.exit(1);
}
if (originVerifySecretSlot === "next" && !originVerifyNextSecret) {
  console.error("TEAMSPACES_ORIGIN_SECRET_NEXT is required when TEAMSPACES_ORIGIN_SECRET_SLOT=next");
  process.exit(1);
}
if (originVerifyEnforcementValue !== undefined && !new Set(["true", "false"]).has(originVerifyEnforcementValue)) {
  console.error("TEAMSPACES_ORIGIN_VERIFY_ENFORCED must be true or false");
  process.exit(1);
}
if (!new Set(["true", "false"]).has(useManagedLoginValue)) {
  console.error("TEAMSPACES_USE_MANAGED_LOGIN must be true or false");
  process.exit(1);
}
if (!isSynth && originVerifyEnforcementValue === undefined) {
  console.error("TEAMSPACES_ORIGIN_VERIFY_ENFORCED must be explicitly set to true or false for production deployment");
  process.exit(1);
}

if (!noBuild) run("npm", ["run", "build"]);

run("cdk", [
  isSynth ? "synth" : "deploy",
  "--app", app,
  ...(isSynth ? [] : ["--require-approval", "never"]),
  ...hostedContext,
  ...cdkArgs
]);

if (!isSynth) {
  log("deploy.complete", {
    checks: [
      `SMOKE_URL=https://${domainName} npm run smoke`,
      `APP_URL=https://${domainName} npm run check:hosted-auth`
    ]
  });
}
