import {spawnSync} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";

/**
 * @param {NodeJS.ProcessEnv} environment
 * @param {string} name
 * @param {boolean} defaultValue
 */
function booleanEnvironment(environment, name, defaultValue) {
  const value = environment[name] ?? String(defaultValue);
  if (!new Set(["true", "false"]).has(value)) throw new Error(`${name} must be true or false`);
  return value;
}

/** @param {string | undefined} value */
export function isValidCommunityDomainName(value) {
  return Boolean(
    value
    && value.length <= 253
    && value.split(".").length >= 2
    && value.split(".").every((label) => (
      label.length >= 1
      && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
    ))
  );
}

/** @param {string | undefined} value */
export function isValidCommunityCertificateArn(value) {
  return Boolean(value && /^arn:[a-z0-9-]+:acm:us-east-1:\d{12}:certificate\/[a-z0-9][a-z0-9-]*$/i.test(value));
}

/** @param {NodeJS.ProcessEnv} [environment] */
export function communityConfiguration(environment = process.env) {
  const domainName = environment.TEAMSPACES_DOMAIN_NAME;
  const certificateArn = environment.ACM_CERTIFICATE_ARN;
  const stackName = environment.TEAMSPACES_STACK_NAME || "teamspaces-community";
  const workspaceName = environment.TEAMSPACES_WORKSPACE_NAME || "Team Spaces";
  const applicationTag = environment.TEAMSPACES_APPLICATION_TAG || "teamspaces";
  const environmentTag = environment.TEAMSPACES_ENVIRONMENT_TAG || "community";
  const ownerTag = environment.TEAMSPACES_OWNER_TAG || "self-hosted";
  const costCenterTag = environment.TEAMSPACES_COST_CENTER_TAG || applicationTag;
  const cognitoDomainPrefix = environment.TEAMSPACES_COGNITO_DOMAIN_PREFIX;
  const budgetEmail = environment.TEAMSPACES_BUDGET_EMAIL;
  const enablePublicDemo = booleanEnvironment(environment, "TEAMSPACES_ENABLE_PUBLIC_DEMO", false);
  const publicDemoDomainName = environment.TEAMSPACES_PUBLIC_DEMO_DOMAIN_NAME?.trim();
  const enableOperations = booleanEnvironment(environment, "TEAMSPACES_ENABLE_OPERATIONS", false);
  const enablePitr = booleanEnvironment(environment, "TEAMSPACES_ENABLE_PITR", false);
  const workIndexReady = booleanEnvironment(environment, "TEAMSPACES_WORK_INDEX_READY", false);
  const allowLocalDevelopmentOrigins = booleanEnvironment(environment, "TEAMSPACES_ALLOW_LOCAL_DEVELOPMENT_ORIGINS", false);

  if (!isValidCommunityDomainName(domainName)) {
    throw new Error("TEAMSPACES_DOMAIN_NAME is required and must be a bare DNS name");
  }
  if (!isValidCommunityCertificateArn(certificateArn)) {
    throw new Error("ACM_CERTIFICATE_ARN is required and must be an us-east-1 ACM certificate ARN");
  }
  if (enableOperations === "true" && !budgetEmail) {
    throw new Error("TEAMSPACES_BUDGET_EMAIL is required when TEAMSPACES_ENABLE_OPERATIONS=true");
  }
  if (publicDemoDomainName && !isValidCommunityDomainName(publicDemoDomainName)) {
    throw new Error("TEAMSPACES_PUBLIC_DEMO_DOMAIN_NAME must be a bare DNS name");
  }
  if (publicDemoDomainName && enablePublicDemo !== "true") {
    throw new Error("TEAMSPACES_ENABLE_PUBLIC_DEMO must be true when TEAMSPACES_PUBLIC_DEMO_DOMAIN_NAME is set");
  }
  if (publicDemoDomainName?.toLowerCase() === domainName?.toLowerCase()) {
    throw new Error("TEAMSPACES_PUBLIC_DEMO_DOMAIN_NAME must differ from TEAMSPACES_DOMAIN_NAME");
  }

  return {
    domainName,
    certificateArn,
    stackName,
    workspaceName,
    applicationTag,
    environmentTag,
    ownerTag,
    costCenterTag,
    cognitoDomainPrefix,
    budgetEmail,
    enablePublicDemo,
    publicDemoDomainName,
    enableOperations,
    enablePitr,
    workIndexReady,
    allowLocalDevelopmentOrigins
  };
}

/**
 * @param {string} event
 * @param {Record<string, unknown>} detail
 */
function log(event, detail = {}) {
  console.log(JSON.stringify({event, ...detail}));
}

/**
 * @param {string} command
 * @param {string[]} runArgs
 */
function run(command, runArgs) {
  log("community-deploy.command", {command: [command, ...runArgs].join(" ")});
  const result = spawnSync(command, runArgs, {
    stdio: "inherit",
    env: process.env
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main() {
  const commandArgs = process.argv.slice(2);
  const args = new Set(commandArgs);
  const isSynth = args.has("--synth");
  const noBuild = args.has("--no-build");
  const cdkArgs = commandArgs.filter((argument) => !["--synth", "--no-build"].includes(argument));
  let configuration;
  try {
    configuration = communityConfiguration();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const {
    domainName,
    certificateArn,
    stackName,
    workspaceName,
    applicationTag,
    environmentTag,
    ownerTag,
    costCenterTag,
    cognitoDomainPrefix,
    budgetEmail,
    enablePublicDemo,
    publicDemoDomainName,
    enableOperations,
    enablePitr,
    workIndexReady,
    allowLocalDevelopmentOrigins
  } = configuration;

  const context = [
    "-c", `stackName=${stackName}`,
    "-c", `domainName=${domainName}`,
    "-c", `certificateArn=${certificateArn}`,
    "-c", "generateWebBucketName=true",
    "-c", `enablePublicDemo=${enablePublicDemo}`,
    ...(publicDemoDomainName ? ["-c", `publicDemoDomainName=${publicDemoDomainName}`] : []),
    "-c", `enableOperations=${enableOperations}`,
    "-c", `enablePitr=${enablePitr}`,
    "-c", "useManagedLogin=false",
    "-c", `allowLocalDevelopmentOrigins=${allowLocalDevelopmentOrigins}`,
    "-c", `workIndexReady=${workIndexReady}`,
    "-c", `workspaceName=${workspaceName}`,
    "-c", `applicationTag=${applicationTag}`,
    "-c", `environmentTag=${environmentTag}`,
    "-c", `ownerTag=${ownerTag}`,
    "-c", `costCenterTag=${costCenterTag}`,
    ...(budgetEmail ? ["-c", `budgetEmail=${budgetEmail}`] : []),
    ...(cognitoDomainPrefix ? ["-c", `cognitoDomainPrefix=${cognitoDomainPrefix}`] : [])
  ];

  log(isSynth ? "community-deploy.synth.start" : "community-deploy.start", {
    domainName,
    stackName,
    profile: enablePublicDemo === "true" ? "showcase" : enableOperations === "true" || enablePitr === "true" ? "production" : "community"
  });

  if (!noBuild) run("npm", ["run", "build"]);

  run("cdk", [
    isSynth ? "synth" : "deploy",
    "--app", "node infra/bin/teamspaces.js",
    ...context,
    ...cdkArgs
  ]);

  if (!isSynth) {
    log("community-deploy.complete", {
      url: `https://${domainName}`,
      next: `Point DNS for ${domainName} at the DistributionDomainName stack output.`
    });
  }
}

const isMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) main();
