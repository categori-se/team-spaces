// @ts-check

import {createHash} from "node:crypto";
import path from "node:path";
import {fileURLToPath} from "node:url";
import * as cdk from "aws-cdk-lib";
import {Duration, RemovalPolicy, Stack} from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cr from "aws-cdk-lib/custom-resources";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaDestinations from "aws-cdk-lib/aws-lambda-destinations";
import * as nodeLambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import {Construct} from "constructs";
import {cognitoManagedLoginUrl, teamSpacesManagedLoginAssets, teamSpacesManagedLoginSettings} from "./auth-branding.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "../..");

/**
 * @param {Construct["node"]} node
 * @param {string} name
 * @param {boolean} defaultValue
 */
function booleanContext(node, name, defaultValue) {
  const value = String(node.tryGetContext(name) ?? defaultValue);
  if (!new Set(["true", "false"]).has(value)) {
    throw new Error(`${name} must be true or false`);
  }
  return value === "true";
}

export class TeamSpacesStack extends Stack {
  /**
   * @param {Construct} scope
   * @param {string} id
   * @param {import("aws-cdk-lib").StackProps} props
   */
  constructor(scope, id, props = {}) {
    super(scope, id, props);

    const domainName = this.node.tryGetContext("domainName") ?? "team-spaces.example.com";
    const certificateArn = this.node.tryGetContext("certificateArn");
    const budgetEmail = this.node.tryGetContext("budgetEmail");
    const generateWebBucketName = booleanContext(this.node, "generateWebBucketName", true);
    const configuredWebBucketName = this.node.tryGetContext("webBucketName");
    if (!generateWebBucketName && !configuredWebBucketName) {
      throw new Error("webBucketName is required when generateWebBucketName is false");
    }
    const webBucketName = generateWebBucketName
      ? undefined
      : configuredWebBucketName;
    const existingUserPoolId = this.node.tryGetContext("existingUserPoolId");
    const authDomainName = this.node.tryGetContext("authDomainName");
    const authCertificateArn = this.node.tryGetContext("authCertificateArn");
    const cognitoDomainUrl = this.node.tryGetContext("cognitoDomainUrl");
    const managedLoginDomainPrefix = this.node.tryGetContext("managedLoginDomainPrefix");
    const managedLoginBrandingAssetDirectory = this.node.tryGetContext("managedLoginBrandingAssetDirectory");
    const useManagedLoginSetting = String(this.node.tryGetContext("useManagedLogin") ?? Boolean(managedLoginDomainPrefix));
    if (!new Set(["true", "false"]).has(useManagedLoginSetting)) {
      throw new Error("useManagedLogin must be true or false");
    }
    const useManagedLogin = useManagedLoginSetting === "true";
    if (useManagedLogin && !managedLoginDomainPrefix) {
      throw new Error("managedLoginDomainPrefix is required when useManagedLogin is true");
    }
    const originVerifySecret = process.env.TEAMSPACES_ORIGIN_SECRET ?? this.node.tryGetContext("originVerifySecret");
    const originVerifyNextSecret = process.env.TEAMSPACES_ORIGIN_SECRET_NEXT ?? this.node.tryGetContext("originVerifyNextSecret");
    const originVerifySecretSlot = String(process.env.TEAMSPACES_ORIGIN_SECRET_SLOT ?? this.node.tryGetContext("originVerifySecretSlot") ?? "primary");
    const originVerifyEnforcementSetting = process.env.TEAMSPACES_ORIGIN_VERIFY_ENFORCED ?? this.node.tryGetContext("originVerifyEnforced");
    if (originVerifyEnforcementSetting === undefined && (originVerifySecret || originVerifyNextSecret)) {
      throw new Error("originVerifyEnforced must be explicitly set when an origin verification secret is configured");
    }
    const originVerifyEnforcementValue = String(originVerifyEnforcementSetting ?? "false");
    if (!new Set(["primary", "next"]).has(originVerifySecretSlot)) {
      throw new Error("originVerifySecretSlot must be primary or next");
    }
    if (!new Set(["true", "false"]).has(originVerifyEnforcementValue)) {
      throw new Error("originVerifyEnforced must be true or false");
    }
    if (originVerifySecretSlot === "next" && !originVerifyNextSecret) {
      throw new Error("originVerifyNextSecret is required when originVerifySecretSlot is next");
    }
    const originVerifyEnforced = originVerifyEnforcementValue === "true";
    const selectedOriginVerifySecret = originVerifySecretSlot === "next" ? originVerifyNextSecret : originVerifySecret;
    if (originVerifyEnforced && !selectedOriginVerifySecret) {
      throw new Error("The selected origin verification secret is required when enforcement is enabled");
    }
    const allowLocalAttachmentOrigins = this.node.tryGetContext("allowLocalAttachmentOrigins") === "true";
    const allowLocalDevelopmentOrigins = booleanContext(this.node, "allowLocalDevelopmentOrigins", false);
    const apiRateLimit = Number(this.node.tryGetContext("apiRateLimit") ?? 25);
    const apiBurstLimit = Number(this.node.tryGetContext("apiBurstLimit") ?? 50);
    const apiReservedConcurrency = Number(this.node.tryGetContext("apiReservedConcurrency") ?? 10);
    const maxReadRequestUnits = Number(this.node.tryGetContext("maxReadRequestUnits") ?? 500);
    const maxWriteRequestUnits = Number(this.node.tryGetContext("maxWriteRequestUnits") ?? 200);
    const publicDemoApiRateLimit = Number(this.node.tryGetContext("publicDemoApiRateLimit") ?? 2);
    const publicDemoApiBurstLimit = Number(this.node.tryGetContext("publicDemoApiBurstLimit") ?? 10);
    const publicDemoReservedConcurrency = Number(this.node.tryGetContext("publicDemoReservedConcurrency") ?? publicDemoApiBurstLimit);
    if (!Number.isInteger(publicDemoReservedConcurrency) || publicDemoReservedConcurrency < publicDemoApiBurstLimit) {
      throw new Error("publicDemoReservedConcurrency must be an integer at least as large as publicDemoApiBurstLimit");
    }
    const publicDemoMaxReadRequestUnits = Number(this.node.tryGetContext("publicDemoMaxReadRequestUnits") ?? 100);
    const publicDemoMaxWriteRequestUnits = Number(this.node.tryGetContext("publicDemoMaxWriteRequestUnits") ?? 50);
    const publicDemoSeedVersion = "2";
    const publicDemoResetHourUtc = 5;
    const enablePublicDemo = booleanContext(this.node, "enablePublicDemo", false);
    const enableOperations = booleanContext(this.node, "enableOperations", false);
    const enablePitr = booleanContext(this.node, "enablePitr", false);
    const workIndexReady = String(this.node.tryGetContext("workIndexReady") ?? "false") === "true";
    const appOrigin = `https://${domainName}`;
    const workspaceName = this.node.tryGetContext("workspaceName") ?? "Team Spaces";
    const tags = {
      application: this.node.tryGetContext("applicationTag") ?? "teamspaces",
      environment: this.node.tryGetContext("environmentTag") ?? "community",
      owner: this.node.tryGetContext("ownerTag") ?? "self-hosted",
      costCenter: this.node.tryGetContext("costCenterTag") ?? "teamspaces"
    };

    for (const [key, value] of Object.entries(tags)) cdk.Tags.of(this).add(key, value);

    const webBucket = new s3.Bucket(this, "WebBucket", {
      bucketName: webBucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        {noncurrentVersionExpiration: Duration.days(30)},
        {expiredObjectDeleteMarker: true}
      ],
      removalPolicy: RemovalPolicy.RETAIN
    });

    const attachmentBucket = new s3.Bucket(this, "AttachmentBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {abortIncompleteMultipartUploadAfter: Duration.days(1)},
        {noncurrentVersionExpiration: Duration.days(90)},
        {
          expiration: Duration.days(1),
          noncurrentVersionExpiration: Duration.days(1),
          tagFilters: {state: "pending"}
        },
        {expiredObjectDeleteMarker: true}
      ],
      cors: [
        {
          allowedOrigins: [
            appOrigin,
            ...(allowLocalAttachmentOrigins ? ["http://localhost:*", "http://127.0.0.1:*"] : [])
          ],
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedHeaders: ["content-type", "if-none-match", "x-amz-server-side-encryption"],
          exposedHeaders: ["etag"],
          maxAge: 600
        }
      ]
    });

    const table = new dynamodb.Table(this, "DataTable", {
      partitionKey: {name: "PK", type: dynamodb.AttributeType.STRING},
      sortKey: {name: "SK", type: dynamodb.AttributeType.STRING},
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      maxReadRequestUnits,
      maxWriteRequestUnits,
      pointInTimeRecoverySpecification: {pointInTimeRecoveryEnabled: enablePitr},
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.RETAIN
    });
    table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: {name: "GSI1PK", type: dynamodb.AttributeType.STRING},
      sortKey: {name: "GSI1SK", type: dynamodb.AttributeType.STRING},
      maxReadRequestUnits,
      maxWriteRequestUnits
    });

    /** @type {dynamodb.Table | undefined} */
    let publicDemoTable;
    if (enablePublicDemo) {
      // Anonymous demo writes never share a table, backup, throughput ceiling,
      // or IAM resource with authenticated customer data. On-demand mode keeps
      // this isolation at effectively zero idle-compute cost.
      publicDemoTable = new dynamodb.Table(this, "PublicDemoTable", {
        partitionKey: {name: "PK", type: dynamodb.AttributeType.STRING},
        sortKey: {name: "SK", type: dynamodb.AttributeType.STRING},
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        maxReadRequestUnits: publicDemoMaxReadRequestUnits,
        maxWriteRequestUnits: publicDemoMaxWriteRequestUnits,
        pointInTimeRecoverySpecification: {pointInTimeRecoveryEnabled: false},
        timeToLiveAttribute: "expiresAt",
        removalPolicy: RemovalPolicy.DESTROY
      });
      publicDemoTable.addGlobalSecondaryIndex({
        indexName: "GSI1",
        partitionKey: {name: "GSI1PK", type: dynamodb.AttributeType.STRING},
        sortKey: {name: "GSI1SK", type: dynamodb.AttributeType.STRING},
        maxReadRequestUnits: publicDemoMaxReadRequestUnits,
        maxWriteRequestUnits: publicDemoMaxWriteRequestUnits
      });
      publicDemoTable.addGlobalSecondaryIndex({
        indexName: "GSI2",
        partitionKey: {name: "GSI2PK", type: dynamodb.AttributeType.STRING},
        sortKey: {name: "GSI2SK", type: dynamodb.AttributeType.STRING},
        maxReadRequestUnits: publicDemoMaxReadRequestUnits,
        maxWriteRequestUnits: publicDemoMaxWriteRequestUnits
      });
    }
    table.addGlobalSecondaryIndex({
      indexName: "GSI2",
      partitionKey: {name: "GSI2PK", type: dynamodb.AttributeType.STRING},
      sortKey: {name: "GSI2SK", type: dynamodb.AttributeType.STRING},
      maxReadRequestUnits,
      maxWriteRequestUnits
    });

    const userPool = existingUserPoolId
      ? cognito.UserPool.fromUserPoolId(this, "UserPool", existingUserPoolId)
      : new cognito.UserPool(this, "UserPool", {
        featurePlan: cognito.FeaturePlan.LITE,
        signInAliases: {email: true},
        autoVerify: {email: true},
        selfSignUpEnabled: false,
        mfa: cognito.Mfa.OPTIONAL,
        mfaSecondFactor: {sms: false, otp: true},
        accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
        removalPolicy: RemovalPolicy.RETAIN,
        passwordPolicy: {
          minLength: 12,
          requireDigits: true,
          requireLowercase: true,
          requireUppercase: true,
          requireSymbols: false
        }
      });

    const userPoolClient = new cognito.UserPoolClient(this, "UserPoolClient", {
      userPool,
      generateSecret: false,
      preventUserExistenceErrors: true,
      authFlows: {userSrp: true},
      oAuth: {
        flows: {authorizationCodeGrant: true},
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [
          appOrigin,
          `${appOrigin}/app`,
          ...(allowLocalDevelopmentOrigins
            ? ["http://localhost:3000/", "http://localhost:3000/app", "http://localhost:3004/", "http://localhost:3004/app", "http://127.0.0.1:3004/", "http://127.0.0.1:3004/app"]
            : [])
        ],
        logoutUrls: [
          appOrigin,
          `${appOrigin}/app`,
          ...(allowLocalDevelopmentOrigins
            ? ["http://localhost:3000/", "http://localhost:3000/app", "http://localhost:3004/", "http://localhost:3004/app", "http://127.0.0.1:3004/", "http://127.0.0.1:3004/app"]
            : [])
        ]
      }
    });

    const awsCustomResourceLogGroup = new logs.LogGroup(this, "AwsCustomResourceLogGroup", {
      retention: logs.RetentionDays.THREE_DAYS,
      removalPolicy: RemovalPolicy.DESTROY
    });

    // A hosted operator may share a pool's custom domain with other
    // applications. Put the Team Spaces adaptive experience on the pool's
    // separate prefix endpoint instead of changing that custom domain. The
    // prefix-domain branding version is still pool-wide, not a security or
    // tenant-isolation boundary.
    let managedLoginBranding;
    if (managedLoginDomainPrefix) {
      if (!existingUserPoolId) {
        throw new Error("managedLoginDomainPrefix is only supported with an existing user pool and prefix domain");
      }
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(managedLoginDomainPrefix)) {
        throw new Error("managedLoginDomainPrefix must be a Cognito domain prefix, not a URL");
      }
      const managedLoginDomainUpgrade = new cr.AwsCustomResource(this, "ManagedLoginDomainUpgrade", {
        onCreate: {
          service: "CognitoIdentityServiceProvider",
          action: "updateUserPoolDomain",
          parameters: {
            UserPoolId: userPool.userPoolId,
            Domain: managedLoginDomainPrefix,
            ManagedLoginVersion: 2
          },
          physicalResourceId: cr.PhysicalResourceId.of(`managed-login-v2-${managedLoginDomainPrefix}`),
          outputPaths: ["ManagedLoginVersion"]
        },
        onUpdate: {
          service: "CognitoIdentityServiceProvider",
          action: "updateUserPoolDomain",
          parameters: {
            UserPoolId: userPool.userPoolId,
            Domain: managedLoginDomainPrefix,
            ManagedLoginVersion: 2
          },
          physicalResourceId: cr.PhysicalResourceId.of(`managed-login-v2-${managedLoginDomainPrefix}`),
          outputPaths: ["ManagedLoginVersion"]
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["cognito-idp:UpdateUserPoolDomain"],
            resources: [userPool.userPoolArn]
          })
        ]),
        logGroup: awsCustomResourceLogGroup,
        installLatestAwsSdk: false
      });
      managedLoginBranding = new cognito.CfnManagedLoginBranding(this, "ManagedLoginBranding", {
        userPoolId: userPool.userPoolId,
        clientId: userPoolClient.userPoolClientId,
        returnMergedResources: false,
        settings: teamSpacesManagedLoginSettings,
        assets: teamSpacesManagedLoginAssets(
          managedLoginBrandingAssetDirectory === undefined
            ? undefined
            : {assetDirectory: managedLoginBrandingAssetDirectory}
        )
      });
      managedLoginBranding.node.addDependency(managedLoginDomainUpgrade);
    }

    const cognitoDomainPrefix = this.node.tryGetContext("cognitoDomainPrefix") ?? `teamspaces-${this.account}`;
    const managedLoginRegion = String(existingUserPoolId ?? this.region).split("_", 1)[0];
    const managedLoginDomainUrl = useManagedLogin && managedLoginDomainPrefix
      ? cognitoManagedLoginUrl(managedLoginDomainPrefix, managedLoginRegion)
      : undefined;
    let resolvedCognitoDomainUrl = managedLoginDomainUrl ?? cognitoDomainUrl ?? (authDomainName ? `https://${authDomainName}` : undefined);
    if (!existingUserPoolId && authDomainName) {
      if (!authCertificateArn) throw new Error("authCertificateArn is required when creating a new Cognito custom authDomainName.");
      userPool.addDomain("UserPoolDomain", {
        customDomain: {
          domainName: authDomainName,
          certificate: acm.Certificate.fromCertificateArn(this, "AuthCertificate", authCertificateArn)
        }
      });
    } else if (!existingUserPoolId && !resolvedCognitoDomainUrl) {
      const userPoolDomain = userPool.addDomain("UserPoolDomain", {
        cognitoDomain: {domainPrefix: cognitoDomainPrefix}
      });
      resolvedCognitoDomainUrl = `https://${userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com`;
    }
    if (!resolvedCognitoDomainUrl) {
      throw new Error("existingUserPoolId requires authDomainName or cognitoDomainUrl so the browser can reach Cognito hosted login.");
    }

    const apiLogGroup = new logs.LogGroup(this, "ApiLogGroup", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.RETAIN
    });

    const apiFunction = new nodeLambda.NodejsFunction(this, "ApiFunction", {
      entry: path.join(repoRoot, "services/api/src/handler.js"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(10),
      memorySize: 256,
      reservedConcurrentExecutions: apiReservedConcurrency,
      logGroup: apiLogGroup,
      environment: {
        TABLE_NAME: table.tableName,
        ATTACHMENT_BUCKET_NAME: attachmentBucket.bucketName,
        DEFAULT_WORKSPACE_ID: "workspace-default",
        WORKSPACE_NAME: workspaceName,
        APP_ORIGIN: appOrigin,
        WORK_INDEX_READY: String(workIndexReady),
        ORIGIN_VERIFY_ENFORCED: String(originVerifyEnforced),
        ...(originVerifySecret ? {ORIGIN_VERIFY_SECRET: originVerifySecret} : {}),
        ...(originVerifyNextSecret ? {ORIGIN_VERIFY_SECRET_NEXT: originVerifyNextSecret} : {})
      },
      bundling: {
        format: nodeLambda.OutputFormat.ESM,
        target: "node24",
        mainFields: ["module", "main"],
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
      }
    });

    apiFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        "dynamodb:BatchGetItem",
        "dynamodb:ConditionCheckItem",
        "dynamodb:DescribeTable",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:TransactWriteItems",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem"
      ],
      resources: [table.tableArn, `${table.tableArn}/index/*`]
    }));
    apiFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:PutObject",
        "s3:PutObjectTagging",
        "s3:PutObjectVersionTagging",
        "s3:AbortMultipartUpload"
      ],
      resources: [attachmentBucket.arnForObjects("documents/*")]
    }));

    /** @type {nodeLambda.NodejsFunction | undefined} */
    let publicDemoApiFunction;
    /** @type {nodeLambda.NodejsFunction | undefined} */
    let publicDemoResetFunction;
    /** @type {sqs.Queue | undefined} */
    let publicDemoResetDeadLetterQueue;
    if (enablePublicDemo && publicDemoTable) {
      const publicDemoApiLogGroup = new logs.LogGroup(this, "PublicDemoApiLogGroup", {
        retention: logs.RetentionDays.THREE_DAYS,
        removalPolicy: RemovalPolicy.DESTROY
      });
      publicDemoApiFunction = new nodeLambda.NodejsFunction(this, "PublicDemoApiFunction", {
        entry: path.join(repoRoot, "services/api/src/handler.js"),
        handler: "publicDemoHandler",
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        timeout: Duration.seconds(10),
        memorySize: 256,
        reservedConcurrentExecutions: publicDemoReservedConcurrency,
        logGroup: publicDemoApiLogGroup,
        environment: {
          TABLE_NAME: publicDemoTable.tableName,
          PUBLIC_DEMO_MODE: "true",
          PUBLIC_DEMO_SEED_VERSION: publicDemoSeedVersion,
          PUBLIC_DEMO_MUTATION_LIMIT: "500",
          PUBLIC_DEMO_RESET_HOUR_UTC: String(publicDemoResetHourUtc),
          WORK_INDEX_READY: "true",
          APP_ORIGIN: appOrigin,
          ORIGIN_VERIFY_ENFORCED: String(originVerifyEnforced),
          ...(originVerifySecret ? {ORIGIN_VERIFY_SECRET: originVerifySecret} : {}),
          ...(originVerifyNextSecret ? {ORIGIN_VERIFY_SECRET_NEXT: originVerifyNextSecret} : {})
        },
        bundling: {
          format: nodeLambda.OutputFormat.ESM,
          target: "node24",
          mainFields: ["module", "main"],
          banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
        }
      });
      publicDemoApiFunction.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          "dynamodb:BatchGetItem",
          "dynamodb:ConditionCheckItem",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Query",
          "dynamodb:TransactWriteItems",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem"
        ],
        resources: [publicDemoTable.tableArn, `${publicDemoTable.tableArn}/index/*`]
      }));

      const publicDemoResetLogGroup = new logs.LogGroup(this, "PublicDemoResetLogGroup", {
        retention: logs.RetentionDays.THREE_DAYS,
        removalPolicy: RemovalPolicy.DESTROY
      });
      publicDemoResetFunction = new nodeLambda.NodejsFunction(this, "PublicDemoResetFunction", {
        entry: path.join(repoRoot, "services/api/src/demo/reset-handler.js"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        timeout: Duration.seconds(60),
        memorySize: 256,
        reservedConcurrentExecutions: 1,
        logGroup: publicDemoResetLogGroup,
        environment: {
          TABLE_NAME: publicDemoTable.tableName,
          PUBLIC_DEMO_SEED_VERSION: publicDemoSeedVersion,
          PUBLIC_DEMO_RESET_HOUR_UTC: String(publicDemoResetHourUtc)
        },
        bundling: {
          format: nodeLambda.OutputFormat.ESM,
          target: "node24",
          mainFields: ["module", "main"],
          banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
        }
      });
      publicDemoResetFunction.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          "dynamodb:BatchWriteItem",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Query"
        ],
        resources: [publicDemoTable.tableArn]
      }));

      const publicDemoSchedulerRole = new iam.Role(this, "PublicDemoSchedulerRole", {
        assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com")
      });
      publicDemoResetFunction.grantInvoke(publicDemoSchedulerRole);
      publicDemoResetDeadLetterQueue = new sqs.Queue(this, "PublicDemoResetDeadLetterQueue", {
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        retentionPeriod: Duration.days(7),
        removalPolicy: RemovalPolicy.DESTROY
      });
      publicDemoResetFunction.configureAsyncInvoke({
        maxEventAge: Duration.hours(2),
        retryAttempts: 2,
        onFailure: new lambdaDestinations.SqsDestination(publicDemoResetDeadLetterQueue)
      });
      publicDemoResetDeadLetterQueue.grantSendMessages(publicDemoSchedulerRole);
      new scheduler.CfnSchedule(this, "PublicDemoDailyReset", {
        description: "Restore the shared public demo to its canonical sample data",
        flexibleTimeWindow: {mode: "OFF"},
        scheduleExpression: `cron(0 ${publicDemoResetHourUtc} * * ? *)`,
        scheduleExpressionTimezone: "UTC",
        target: {
          arn: publicDemoResetFunction.functionArn,
          roleArn: publicDemoSchedulerRole.roleArn,
          deadLetterConfig: {arn: publicDemoResetDeadLetterQueue.queueArn},
          input: JSON.stringify({
            source: "teamspaces.public-demo",
            "detail-type": "Daily public demo reset"
          }),
          retryPolicy: {
            maximumEventAgeInSeconds: Duration.hours(2).toSeconds(),
            maximumRetryAttempts: 2
          }
        }
      });

      const publicDemoSeedProviderLogGroup = new logs.LogGroup(this, "PublicDemoSeedProviderLogGroup", {
        retention: logs.RetentionDays.THREE_DAYS,
        removalPolicy: RemovalPolicy.DESTROY
      });
      const publicDemoSeedProvider = new cr.Provider(this, "PublicDemoSeedProvider", {
        onEventHandler: publicDemoResetFunction,
        logGroup: publicDemoSeedProviderLogGroup
      });
      new cdk.CustomResource(this, "PublicDemoInitialSeed", {
        serviceToken: publicDemoSeedProvider.serviceToken,
        properties: {seedVersion: publicDemoSeedVersion}
      });
    }

    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      corsPreflight: {
        allowOrigins: [appOrigin, ...(allowLocalDevelopmentOrigins ? ["http://localhost:3000"] : [])],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.OPTIONS
        ],
        allowHeaders: ["authorization", "content-type", "x-correlation-id", "idempotency-key"],
        maxAge: Duration.minutes(10)
      }
    });
    const apiIntegration = new integrations.HttpLambdaIntegration("ApiIntegration", apiFunction);
    const userPoolIssuer = `https://cognito-idp.${this.region}.${this.urlSuffix}/${userPool.userPoolId}`;
    const jwtAuthorizer = new authorizers.HttpJwtAuthorizer("CognitoJwtAuthorizer", userPoolIssuer, {
      jwtAudience: [userPoolClient.userPoolClientId]
    });
    const healthRoutes = httpApi.addRoutes({
      path: "/api/v1/health",
      methods: [apigwv2.HttpMethod.GET],
      integration: apiIntegration
    });
    const publicDemoRoutes = publicDemoApiFunction
      ? httpApi.addRoutes({
        path: "/api/v1/demo/{proxy+}",
        methods: [apigwv2.HttpMethod.ANY],
        integration: new integrations.HttpLambdaIntegration("PublicDemoApiIntegration", publicDemoApiFunction)
      })
      : [];
    httpApi.addRoutes({
      path: "/api/v1/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: apiIntegration,
      authorizer: jwtAuthorizer
    });
    const httpStage = httpApi.defaultStage;
    if (!httpStage) throw new Error("HTTP API default stage was not created");
    const cfnHttpStage = httpStage.node.defaultChild;
    if (!(cfnHttpStage instanceof apigwv2.CfnStage)) throw new Error("HTTP API default stage resource was not found");
    cfnHttpStage.defaultRouteSettings = {
      throttlingRateLimit: apiRateLimit,
      throttlingBurstLimit: apiBurstLimit
    };
    cfnHttpStage.addPropertyOverride("RouteSettings", {
      "GET /api/v1/health": {
        ThrottlingRateLimit: 1,
        ThrottlingBurstLimit: 5
      },
      ...(enablePublicDemo ? {
        "ANY /api/v1/demo/{proxy+}": {
          ThrottlingRateLimit: publicDemoApiRateLimit,
          ThrottlingBurstLimit: publicDemoApiBurstLimit
        }
      } : {})
    });
    // RouteSettings can only reference routes that already exist. Without an
    // explicit dependency CloudFormation may update the stage before creating
    // a new route, and may delete a route before restoring the stage during
    // rollback.
    for (const route of [...healthRoutes, ...publicDemoRoutes]) {
      const cfnRoute = route.node.defaultChild;
      if (!(cfnRoute instanceof apigwv2.CfnRoute)) throw new Error("HTTP API route resource was not found");
      cfnHttpStage.addResourceDependency(cfnRoute);
    }

    const rewriteFunction = new cloudfront.Function(this, "ObservableRouteRewrite", {
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri === '/') request.uri = '/index.html';
  else if (uri.indexOf('.') === -1) request.uri = (uri.endsWith('/') ? uri.slice(0, -1) : uri) + '.html';
  return request;
}`),
      runtime: cloudfront.FunctionRuntime.JS_2_0
    });

    // Reject oversized bodies on unauthenticated showcase routes at the edge
    // so an attacker cannot multiply API Gateway/Lambda work while staying
    // below the request-rate throttle. The Lambda repeats these checks as the
    // authority. Private community installations omit this request-priced
    // function; their public health route remains separately throttled.
    const publicDemoRequestGuard = enablePublicDemo
      ? new cloudfront.Function(this, "PublicDemoRequestGuard", {
        code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var isBoundedPublicRoute = uri === '/api/v1/health' || uri === '/api/v1/demo' || uri.indexOf('/api/v1/demo/') === 0;
  if (!isBoundedPublicRoute) return request;

  var lengthHeader = request.headers['content-length'];
  var transferHeader = request.headers['transfer-encoding'];
  var lengthValue = lengthHeader ? lengthHeader.value : '';
  var validLength = /^\\d+$/.test(lengthValue);
  var length = validLength ? Number(lengthValue) : 0;
  var bodyMethod = request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH' || request.method === 'DELETE';
  var rejected = Boolean(transferHeader)
    || (lengthHeader && (!validLength || length > 8192))
    || (bodyMethod && !lengthHeader)
    || (!bodyMethod && length > 0);
  if (!rejected) return request;

  return {
    statusCode: 413,
    statusDescription: 'Payload Too Large',
    headers: {
      'content-type': {value: 'application/problem+json; charset=utf-8'},
      'cache-control': {value: 'no-store'}
    },
    body: JSON.stringify({
      title: 'Payload Too Large',
      status: 413,
      detail: 'Public API requests require a declared body no larger than 8192 bytes; read requests must not include a body.'
    })
  };
}`),
        runtime: cloudfront.FunctionRuntime.JS_2_0
      })
      : undefined;

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            `connect-src 'self' ${resolvedCognitoDomainUrl} https://${attachmentBucket.bucketRegionalDomainName}${allowLocalDevelopmentOrigins ? " http://localhost:8787" : ""}`,
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "object-src 'none'"
          ].join("; ")
        },
        strictTransportSecurity: {override: true, accessControlMaxAge: Duration.days(365), includeSubdomains: true},
        contentTypeOptions: {override: true},
        frameOptions: {override: true, frameOption: cloudfront.HeadersFrameOption.DENY},
        referrerPolicy: {override: true, referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN}
      },
      customHeadersBehavior: {
        customHeaders: [
          {header: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()", override: true}
        ]
      }
    });

    const webOrigin = origins.S3BucketOrigin.withOriginAccessControl(webBucket);
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      domainNames: certificateArn ? [domainName] : undefined,
      certificate: certificateArn ? acm.Certificate.fromCertificateArn(this, "Certificate", certificateArn) : undefined,
      defaultBehavior: {
        origin: webOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        functionAssociations: [
          {eventType: cloudfront.FunctionEventType.VIEWER_REQUEST, function: rewriteFunction}
        ]
      },
      additionalBehaviors: {
        "runtime-config.json": {
          origin: webOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: securityHeaders
        },
        "api/*": {
          origin: new origins.HttpOrigin(`${httpApi.apiId}.execute-api.${this.region}.${this.urlSuffix}`, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
            customHeaders: selectedOriginVerifySecret ? {"x-teamspaces-origin-secret": selectedOriginVerifySecret} : undefined
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: securityHeaders,
          ...(publicDemoRequestGuard ? {
            functionAssociations: [
              {eventType: cloudfront.FunctionEventType.VIEWER_REQUEST, function: publicDemoRequestGuard}
            ]
          } : {})
        }
      }
    });

    const bucketDeploymentLogGroup = new logs.LogGroup(this, "BucketDeploymentLogGroup", {
      retention: logs.RetentionDays.THREE_DAYS,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const webDeployment = new s3deploy.BucketDeployment(this, "WebDeployment", {
      sources: [s3deploy.Source.asset(path.join(repoRoot, "apps/web/dist"))],
      destinationBucket: webBucket,
      exclude: ["runtime-config.json", "_file/*", "_import/*", "_node/*", "_observablehq/*"],
      cacheControl: [s3deploy.CacheControl.noCache(), s3deploy.CacheControl.mustRevalidate()],
      logGroup: bucketDeploymentLogGroup,
      prune: true
    });
    const immutableWebDeployment = new s3deploy.BucketDeployment(this, "ImmutableWebDeployment", {
      sources: [s3deploy.Source.asset(path.join(repoRoot, "apps/web/dist"))],
      destinationBucket: webBucket,
      exclude: ["*"],
      include: ["_file/*", "_import/*", "_node/*", "_observablehq/*"],
      cacheControl: [
        s3deploy.CacheControl.setPublic(),
        s3deploy.CacheControl.maxAge(Duration.days(365)),
        s3deploy.CacheControl.immutable()
      ],
      logGroup: bucketDeploymentLogGroup,
      prune: false,
      distribution,
      distributionPaths: ["/*"]
    });
    immutableWebDeployment.node.addDependency(webDeployment);

    const runtimeConfigBody = JSON.stringify({
      apiBaseUrl: "/api/v1",
      authMode: "cognito",
      appOrigin,
      publicDemo: {
        enabled: enablePublicDemo,
        ...(enablePublicDemo ? {
          apiBaseUrl: "/api/v1/demo",
          resetsAt: `${String(publicDemoResetHourUtc).padStart(2, "0")}:00 UTC`
        } : {})
      },
      cognito: {
        domain: resolvedCognitoDomainUrl,
        clientId: userPoolClient.userPoolClientId,
        redirectUri: `${appOrigin}/app`,
        logoutUri: appOrigin
      }
    }, null, 2);
    const runtimeConfigWriter = new cr.AwsCustomResource(this, "RuntimeConfigObject", {
      onCreate: {
        service: "S3",
        action: "putObject",
        parameters: {
          Bucket: webBucket.bucketName,
          Key: "runtime-config.json",
          Body: runtimeConfigBody,
          ContentType: "application/json; charset=utf-8",
          CacheControl: "no-store"
        },
        physicalResourceId: cr.PhysicalResourceId.of("runtime-config")
      },
      onUpdate: {
        service: "S3",
        action: "putObject",
        parameters: {
          Bucket: webBucket.bucketName,
          Key: "runtime-config.json",
          Body: runtimeConfigBody,
          ContentType: "application/json; charset=utf-8",
          CacheControl: "no-store"
        },
        physicalResourceId: cr.PhysicalResourceId.of("runtime-config")
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [webBucket.arnForObjects("runtime-config.json")]
      }),
      logGroup: awsCustomResourceLogGroup,
      installLatestAwsSdk: false
    });
    runtimeConfigWriter.node.addDependency(immutableWebDeployment);
    if (managedLoginBranding) runtimeConfigWriter.node.addDependency(managedLoginBranding);

    if (enableOperations) {
      const budgetNotifications = budgetEmail
        ? [
          {notificationType: "ACTUAL", threshold: 60},
          {notificationType: "ACTUAL", threshold: 90},
          {notificationType: "FORECASTED", threshold: 90},
          {notificationType: "ACTUAL", threshold: 100}
        ].map((notification) => ({
          notification: {
            ...notification,
            comparisonOperator: "GREATER_THAN",
            thresholdType: "PERCENTAGE"
          },
          subscribers: [{subscriptionType: "EMAIL", address: budgetEmail}]
        }))
        : undefined;
      // CloudFormation replaces an AWS Budget whenever its subscribers or
      // notifications change. A replacement must use a new account-unique name
      // so that it can be created before the prior managed budget is deleted.
      const budgetNotificationRevision = createHash("sha256")
        .update(JSON.stringify({stackName: this.stackName, tags, notifications: budgetNotifications ?? []}))
        .digest("hex")
        .slice(0, 12);
      new budgets.CfnBudget(this, "Budget5", {
        budget: {
          budgetName: `teamspaces-5-usd-${budgetNotificationRevision}`,
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: {amount: 5, unit: "USD"},
          costFilters: {TagKeyValue: [`user:application$${tags.application}`]}
        },
        notificationsWithSubscribers: budgetNotifications
      });

      const alarms = [];
      alarms.push(new cloudwatch.Alarm(this, "LambdaErrorsAlarm", {
        metric: apiFunction.metricErrors({period: Duration.minutes(5)}),
        threshold: 1,
        evaluationPeriods: 1
      }));
      alarms.push(new cloudwatch.Alarm(this, "LambdaThrottlesAlarm", {
        metric: apiFunction.metricThrottles({period: Duration.minutes(5)}),
        threshold: 1,
        evaluationPeriods: 1
      }));
      alarms.push(new cloudwatch.Alarm(this, "Api5xxAlarm", {
        metric: httpStage.metricServerError({period: Duration.minutes(5)}),
        threshold: 1,
        evaluationPeriods: 1
      }));
      alarms.push(new cloudwatch.Alarm(this, "DynamoThrottlesAlarm", {
        metric: new cloudwatch.Metric({
          namespace: "AWS/DynamoDB",
          metricName: "ThrottledRequests",
          dimensionsMap: {TableName: table.tableName},
          statistic: "Sum",
          period: Duration.minutes(5)
        }),
        threshold: 1,
        evaluationPeriods: 1
      }));
      if (publicDemoApiFunction && publicDemoResetFunction && publicDemoTable && publicDemoResetDeadLetterQueue) {
        alarms.push(new cloudwatch.Alarm(this, "PublicDemoLambdaErrorsAlarm", {
          metric: publicDemoApiFunction.metricErrors({period: Duration.minutes(5)}),
          threshold: 1,
          evaluationPeriods: 1
        }));
        alarms.push(new cloudwatch.Alarm(this, "PublicDemoLambdaThrottlesAlarm", {
          metric: publicDemoApiFunction.metricThrottles({period: Duration.minutes(5)}),
          threshold: 1,
          evaluationPeriods: 1
        }));
        alarms.push(new cloudwatch.Alarm(this, "PublicDemoHighTrafficAlarm", {
          metric: publicDemoApiFunction.metricInvocations({period: Duration.minutes(5)}),
          threshold: 500,
          evaluationPeriods: 1
        }));
        alarms.push(new cloudwatch.Alarm(this, "PublicDemoResetErrorsAlarm", {
          metric: publicDemoResetFunction.metricErrors({period: Duration.minutes(5)}),
          threshold: 1,
          evaluationPeriods: 1
        }));
        alarms.push(new cloudwatch.Alarm(this, "PublicDemoDynamoThrottlesAlarm", {
          metric: new cloudwatch.Metric({
            namespace: "AWS/DynamoDB",
            metricName: "ThrottledRequests",
            dimensionsMap: {TableName: publicDemoTable.tableName},
            statistic: "Sum",
            period: Duration.minutes(5)
          }),
          threshold: 1,
          evaluationPeriods: 1
        }));
        alarms.push(new cloudwatch.Alarm(this, "PublicDemoResetDeadLettersAlarm", {
          metric: publicDemoResetDeadLetterQueue.metricApproximateNumberOfMessagesVisible({period: Duration.minutes(5)}),
          threshold: 1,
          evaluationPeriods: 1
        }));
      }

      if (budgetEmail) {
        const alarmTopic = new sns.Topic(this, "AlarmTopic", {
          displayName: "Team Spaces production alarms"
        });
        alarmTopic.addSubscription(new subscriptions.EmailSubscription(budgetEmail));
        const alarmAction = new cloudwatchActions.SnsAction(alarmTopic);
        for (const alarm of alarms) alarm.addAlarmAction(alarmAction);
      }
    }

    new cdk.CfnOutput(this, "DistributionDomainName", {value: distribution.distributionDomainName});
    new cdk.CfnOutput(this, "WebBucketName", {value: webBucket.bucketName});
    new cdk.CfnOutput(this, "AttachmentBucketName", {value: attachmentBucket.bucketName});
    if (publicDemoTable && publicDemoApiFunction && publicDemoResetFunction) {
      new cdk.CfnOutput(this, "PublicDemoTableName", {value: publicDemoTable.tableName});
      new cdk.CfnOutput(this, "PublicDemoApiFunctionName", {value: publicDemoApiFunction.functionName});
      new cdk.CfnOutput(this, "PublicDemoResetFunctionName", {value: publicDemoResetFunction.functionName});
    }
    new cdk.CfnOutput(this, "HttpApiUrl", {value: httpApi.apiEndpoint});
    new cdk.CfnOutput(this, "UserPoolId", {value: userPool.userPoolId});
    new cdk.CfnOutput(this, "UserPoolClientId", {value: userPoolClient.userPoolClientId});
    new cdk.CfnOutput(this, "CognitoDomain", {value: resolvedCognitoDomainUrl});
    if (managedLoginBranding) {
      new cdk.CfnOutput(this, "ManagedLoginBrandingId", {value: managedLoginBranding.attrManagedLoginBrandingId});
    }
  }
}
