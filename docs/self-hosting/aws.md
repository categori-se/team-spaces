# Self-host Team Spaces on AWS

This is the supported self-hosting profile for Team Spaces. It deploys the open-source product core into an AWS account you control. It is AWS-native rather than a Docker/PostgreSQL distribution: CloudFront and private S3 serve the web application, API Gateway invokes ARM Lambda, DynamoDB stores application records on demand, Cognito authenticates users, and a second private S3 bucket stores document bytes.

The generic installer is separate from any service operator's hosted configuration. It must not depend on a maintainer's AWS profile, domain, certificate, bucket, Cognito pool, release bucket, or account identifier.

## Cost contract

The design target is no paid idle compute and no provisioned database capacity. The core does not require a VM, container service, load balancer, NAT Gateway, provisioned Lambda concurrency, relational database cluster, search cluster, or standalone WAF.

This is not a promise of a zero AWS bill. AWS can charge for:

- CloudFront and API Gateway requests and data transfer.
- Lambda requests and duration.
- DynamoDB reads, writes, indexes, storage, backups, and point-in-time recovery.
- S3 objects, retained versions, requests, and transfer.
- Cognito monthly active users and messages outside applicable allowances.
- CloudWatch log ingestion and retained log bytes.
- Any optional alarm metrics, public-demo resets, email, scanning, integrations, or other operational features you enable.
- Domain registration, external DNS, AWS Support plans, taxes, and third-party services outside this stack.

Free allowances are shared by an AWS account or organization and may already be consumed. Persisted application data has a storage cost even when nobody signs in. “No paid idle compute” therefore describes the architecture, not a guaranteed invoice amount. See [the cost model](../cost-model.md) for the current light-use envelope and feature cost gates.

The minimal community profile makes its cost boundary explicit: it disables the shared public demo and its daily reset, CloudWatch metric alarms and the application AWS Budget, and DynamoDB point-in-time recovery. It still retains short-lived logs and stored application/web/document data. S3 versioning remains enabled. A production operator should decide deliberately whether the recovery value of PITR and the operational value of paid alarm metrics outweigh their baseline charges; the optional hosted profile enables both.

## Prerequisites

You need:

1. An AWS account in which you are authorized to create IAM, CloudFormation, CloudFront, S3, API Gateway, Lambda, DynamoDB, Cognito, and related observability resources.
2. AWS CLI credentials available through the normal AWS SDK credential chain or an explicitly selected `AWS_PROFILE`.
3. Node.js 24 or newer and npm.
4. AWS CDK bootstrapped in the target account and region.
5. A hostname you control.
6. An issued public ACM certificate in `us-east-1` that covers that hostname. CloudFront requires its viewer certificate in `us-east-1`, even when other regional resources are deployed there as well.

Confirm the identity before every first deployment or destructive operation:

```bash
aws sts get-caller-identity
```

Bootstrap CDK once for the selected account and region, replacing the example values:

```bash
npx cdk bootstrap aws://123456789012/us-east-1
```

CDK bootstrap resources, including retained deployment assets, belong to the AWS account rather than one Team Spaces stack and may have their own small storage cost.
Observable's content-hashed web objects are retained so a long-lived installation never loses assets still referenced by its current HTML. Review old unreferenced web objects and CDK assets during upgrades; do not apply an age-only expiration rule to current hashed objects because an installation that receives no deployment for that period would break.

## Configure the installation

Use [`.env.example`](../../.env.example) as a checklist. The generic deployment requires exactly these installation-specific values:

```text
TEAMSPACES_DOMAIN_NAME=team-spaces.example.com
ACM_CERTIFICATE_ARN=arn:aws:acm:us-east-1:123456789012:certificate/replace-me
```

The deployment command reads the process environment; it does not automatically load `.env`. Export a reviewed file in your shell or pass the values inline as shown below.

Do not use a certificate from another region. Do not commit a populated `.env`; `.env` files are ignored by Git, but shell history, CI logs, issue attachments, and retained CDK synthesis output still need normal secret hygiene.

Use `AWS_PROFILE` only when you need to override the normal credential chain:

```bash
AWS_PROFILE=your-profile aws sts get-caller-identity
```

The installer also accepts optional identity settings without binding the repository to one operator:

| Setting | Community default | Purpose |
| --- | --- | --- |
| `TEAMSPACES_STACK_NAME` | `teamspaces-community` | CloudFormation stack name. |
| `TEAMSPACES_WORKSPACE_NAME` | `Team Spaces` | Default workspace display name. |
| `TEAMSPACES_COGNITO_DOMAIN_PREFIX` | account-derived | Cognito prefix; supply a globally unique value for multiple installations. |
| `TEAMSPACES_APPLICATION_TAG` | `teamspaces` | Application cost-allocation tag. |
| `TEAMSPACES_ENVIRONMENT_TAG` | `community` | Environment tag. |
| `TEAMSPACES_OWNER_TAG` | `self-hosted` | Owner tag. |
| `TEAMSPACES_COST_CENTER_TAG` | application tag | Cost-center tag. |
| `TEAMSPACES_WORK_INDEX_READY` | `false` | Enables the scalable reader only after migration verification. |
| `TEAMSPACES_ENABLE_PITR` | `false` | Protects the application table with size-priced point-in-time recovery. |
| `TEAMSPACES_ENABLE_OPERATIONS` | `false` | Adds four core alarms, SNS email, and a tagged application Budget; requires `TEAMSPACES_BUDGET_EMAIL`. |
| `TEAMSPACES_ENABLE_PUBLIC_DEMO` | `false` | Adds the isolated anonymous showcase table/API/reset lane; ordinary private teams should leave it off. |
| `TEAMSPACES_BUDGET_EMAIL` | none | Required notification address when operations are enabled. |
| `TEAMSPACES_ALLOW_LOCAL_DEVELOPMENT_ORIGINS` | `false` | Adds localhost OAuth callbacks, API CORS, and CSP access for deliberate deployed-backend testing; leave off in normal installations. |

The community command intentionally uses generated S3 bucket names and creates a dedicated Cognito pool instead of importing another application's pool.

The root package remains marked `private` to prevent accidental npm publication. That setting does not affect self-hosting or the Apache-2.0 source license.

## Synthesize before deploying

Install the locked dependencies and synthesize the generic AWS profile:

```bash
npm ci

TEAMSPACES_DOMAIN_NAME=team-spaces.example.com \
ACM_CERTIFICATE_ARN=arn:aws:acm:us-east-1:123456789012:certificate/replace-me \
npm run infra:synth:aws
```

Synthesis is read-only with respect to the application stack, but it writes a local `cdk.out` assembly. Review the template, IAM changes, removal policies, resource ceilings, and cost-bearing resources before deployment. A successful synth does not validate DNS ownership, certificate issuance, account quotas, or every runtime permission.

## Deploy

Run the same reviewed revision with the same hostname and certificate:

```bash
TEAMSPACES_DOMAIN_NAME=team-spaces.example.com \
ACM_CERTIFICATE_ARN=arn:aws:acm:us-east-1:123456789012:certificate/replace-me \
npm run deploy:aws
```

`npm run deploy` is an alias for the generic AWS command. `npm run deploy:hosted` enables the optional hosted operations and showcase profile; it requires explicit environment configuration and must not be used as a self-hosting shortcut.
CDK retains its normal IAM-broadening approval prompt. Review the proposed changes rather than suppressing that prompt; an automated operator that deliberately uses `--require-approval never` owns that exception.

Record the CloudFormation stack name and these outputs after a successful deployment:

- `DistributionDomainName`.
- `WebBucketName`.
- `AttachmentBucketName`.
- `HttpApiUrl`.
- `UserPoolId` and `UserPoolClientId`.
- `CognitoDomain`.

Resolve the application table's physical name when an export or migration needs it:

```bash
aws cloudformation list-stack-resources \
  --stack-name teamspaces-community \
  --query "StackResourceSummaries[?starts_with(LogicalResourceId, 'DataTable')].PhysicalResourceId | [0]" \
  --output text
```

Create or update the public DNS record for `TEAMSPACES_DOMAIN_NAME` so it aliases or CNAMEs to `DistributionDomainName`. Wait for DNS and CloudFront propagation, then verify:

```bash
SMOKE_URL=https://team-spaces.example.com npm run smoke
```

The supported browser entry point is CloudFront. The web and document buckets must remain private.

### API origin boundary

The minimal community profile does not create or generate an origin-verification secret. Its authenticated application routes remain protected by Cognito JWT validation and server-side workspace authorization, and the shared public-demo routes are disabled. The regional API Gateway hostname and its unauthenticated health route remain directly reachable.

An operator who requires CloudFront to be the only accepted application origin can use the advanced origin-secret settings described in [the operations runbook](../operations-runbook.md#origin-secret-rollout-and-rotation). That control requires a stable high-entropy secret, an observation deployment, and a second enforcement deployment; it must not be “simplified” by generating a different value on every deploy. A hosted operator can use that advanced profile.

## Create the first user and workspace administrator

Self-sign-up is disabled. The deployment does not invent an email address, send an owner invitation, or create a system-wide administrator. Use the `UserPoolId` output to create the first Cognito user deliberately:

```bash
aws cognito-idp admin-create-user \
  --user-pool-id us-east-1_example \
  --username owner@example.com \
  --user-attributes Name=email,Value=owner@example.com Name=email_verified,Value=true
```

Sign in through the application and complete Cognito's temporary-password flow. On first authenticated bootstrap, Team Spaces creates that user a personal workspace and an administrator membership scoped to that workspace. This is not a global operator role. Create a team or client workspace in the application and add other members deliberately.

The installation-owned pool permits software-token MFA and disables SMS as a second factor. Enroll and require MFA according to your organization policy before adding sensitive production data; Team Spaces does not provision SMS delivery or a paid messaging dependency for the baseline.

At present there is no one-command owner invitation, cross-workspace super-administrator, or automated break-glass membership repair. Account-level Cognito access and an audited DynamoDB repair remain the operator recovery boundary; see [the operations runbook](../operations-runbook.md#cognito-administrator-recovery).

## Work-index migration gate

Keep `TEAMSPACES_WORK_INDEX_READY=false` for the first deployment of code that introduces the workspace work projection. New writes then populate the projection while cross-project reads retain the compatible path.

For an existing table, migrate one bounded page at a time. Review a dry-run page, apply that same page from the same starting cursor, and advance only to the cursor emitted by the successful apply:

```bash
TABLE_NAME=exact-table-name npm run migrate:work-index -- --page-limit 25
TABLE_NAME=exact-table-name npm run migrate:work-index -- --apply --page-limit 25

TABLE_NAME=exact-table-name npm run migrate:work-index -- --page-limit 25 --cursor <startingCursor>
TABLE_NAME=exact-table-name npm run migrate:work-index -- --apply --page-limit 25 --cursor <startingCursor>
```

After the final page has no `nextCursor`, verify from the beginning and write the readiness marker:

```bash
TABLE_NAME=exact-table-name npm run migrate:work-index -- --mark-ready
```

Only after a zero-repair verification succeeds should you set `TEAMSPACES_WORK_INDEX_READY=true` and deploy again. Runtime code requires both the setting and marker. Rehearse an existing production migration against a restored table first. The full invariants and cursor rules are documented in [DynamoDB access patterns](../access-patterns.md#work-query-v1-cursor-and-migration).

## Backup, export, and restore

These mechanisms solve different problems:

- DynamoDB point-in-time recovery, when explicitly enabled, protects the authenticated application table according to its configured retention window and stored size. It is off in the minimal community profile and on in the hosted production profile.
- S3 versioning and lifecycle policies protect recent document and web-object versions.
- A Team Spaces portable export is a bounded, versioned bundle of low-level DynamoDB AttributeValue records for a compatible Team Spaces data-model version.
- Document bytes are S3 objects and are not embedded in the DynamoDB export.

Record export:

```bash
TABLE_NAME=exact-table-name \
EXPORT_PATH=team-spaces-data.json \
npm run export:data
```

Keep the export encrypted and access-controlled. It can contain user identifiers, project content, document metadata, and other private workspace data.
The exporter creates a new mode-`0600` file and refuses to overwrite an existing path.

The portable command is deliberately limited to 25,000 items and a 64 MiB compact AttributeValue payload. It holds that bounded payload in memory and uses strongly consistent reads, which consume table read capacity. It fails without creating an output file when either ceiling is exceeded. For a larger installation, enable PITR and use [DynamoDB Export to S3](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/S3DataExport.HowItWorks.html), then plan a controlled table-scale migration; DynamoDB's native files are not accepted directly by `npm run import:data`.

The exporter scans page by page, but DynamoDB does not make a multi-page scan an atomic table snapshot while writes continue. For a recovery-grade point in time, export from a quiesced installation or a PITR-restored table. The bundle records the Team Spaces application version, data-model version, optional release identifier, source table and region, item count, payload bytes, and a SHA-256 checksum of the source items. The checksum detects accidental payload corruption; it is not a signature and does not authenticate the source metadata. Preserve an independently authenticated hash when audit provenance is required.

The file does not define the table, keys, GSIs, TTL setting, throughput ceilings, PITR setting, or S3 buckets. Deploy a compatible empty stack/table first.

Import first validates the bundle and data-model versions, supported AttributeValue union shape and basic value syntax, keys, duplicate records, bounded item/byte counts, and source checksum without contacting a target table:

```bash
IMPORT_PATH=team-spaces-data.json \
npm run import:data
```

The dry run reports `sourceItemCount`, `importableItemCount`, `skippedTargetMarkers`, and `sourceChecksum`; a source readiness marker is deliberately not part of the target import.

Apply only to a schema-compatible, quiesced target. Before its emptiness check or first write, apply describes the target and requires an active `PK`/`SK` table, active `GSI1` and `GSI2` with the expected string keys and `ALL` projections, and TTL enabled or enabling on `expiresAt`. The AWS principal running the command therefore needs `dynamodb:DescribeTable`, `dynamodb:DescribeTimeToLive`, `dynamodb:Scan`, and `dynamodb:BatchWriteItem` on the target. The safe default then checks that the target is empty and refuses a merge:

```bash
TABLE_NAME=empty-target-table \
IMPORT_PATH=team-spaces-data.json \
npm run import:data -- --apply
```

Use an export/import only between Team Spaces revisions that support the bundle's recorded data-model version. Physical-table preflight cannot prove application-level compatibility or migrate a newer model. A failed batch import may leave a partially populated target; recreate or empty that disposable target before retrying instead of bypassing the non-empty safety check. Copy the attachment bucket separately, preserve object keys and encryption, and compare object counts/checksums before directing users to the restored installation.

The importer deliberately omits the source table's `WORK_INDEX_V1` readiness marker. Keep `TEAMSPACES_WORK_INDEX_READY=false`, run the target-table verifier, wait for GSI propagation, and use `--mark-ready` before enabling the scalable reader.

Record import is immediately usable only when the recovery preserves the Cognito pool whose JWT `sub` values are stored as Team Spaces user IDs. Creating users in a new pool produces different subjects; memberships, ownership, assignments, meeting participants, time entries, saved views, and activity then require a reviewed identity-remapping migration. That migration is not yet provided.

Likewise, an S3 copy preserves object keys but not S3 VersionIds. Finalized document rows request their recorded `objectVersionId`, and copying into another bucket creates a different version. A cross-bucket migration therefore needs an attachment inventory plus a conditional metadata rewrite after target checksums and new VersionIds are recorded. That automation is also not yet provided. Do not present a raw record import plus bucket copy as a complete cross-install migration.

A DynamoDB point-in-time restore creates a new table. Switching the API to it, validating representative workspaces, and reconciling the change with CDK are currently operator-run steps rather than a fully automated failover. Do not delete the source table or attachment versions until the restore has been accepted. Follow [the restore runbook](../restore-runbook.md).

## Upgrade

For each upgrade:

1. Read the target revision's roadmap, release notes, migration notes, and changed environment requirements.
2. Confirm the recovery controls you selected and S3 versioning, then take a fresh record export and protect it with the matching attachment inventory.
3. Check out an exact release tag or reviewed commit and run `npm ci`.
4. Run the complete validation suite from the repository README.
5. Synthesize with the current installation values and inspect the CloudFormation/IAM diff.
6. Complete any documented two-release migration sequence in order.
7. Deploy and run the smoke test against the public hostname.
8. Verify sign-in, a representative read/write workflow, document access, alarms you enabled, and Cost Explorer tags.

Do not skip directly across a migration gate unless that release explicitly documents the path.

## Destroy and retained data

Destroying a stack is destructive infrastructure work, but it is intentionally not equivalent to erasing customer data. Before deletion, export records, inventory S3 objects and versions, record physical resource names, and review the synthesized removal policies.

Delete only the exact CloudFormation stack you recorded during deployment:

```bash
aws cloudformation delete-stack --stack-name <exact-stack-name>
aws cloudformation wait stack-delete-complete --stack-name <exact-stack-name>
```

The authenticated DynamoDB table, web bucket, attachment bucket, authenticated-API log group, and a Cognito user pool created by the stack use retain-oriented policies. They may remain and continue incurring storage or identity-related charges after the CloudFormation stack is gone. A public-demo table, when enabled by a hosted profile, is disposable and has a different removal policy.

Inspect retained resources by exact physical name and tag before deciding whether to delete them. Deleting a retained table, bucket, object version, or user pool is a separate irreversible act and is not authorized merely by deleting the stack. CDK bootstrap and release-artifact resources are also account-level and are not removed with Team Spaces.

## Current self-hosting limitations

- AWS is the supported persistent deployment target. Local development is memory-backed, not a production Docker profile.
- The initial Cognito user and operator recovery are manual.
- Record import targets an empty table and does not merge tenants.
- A new Cognito pool requires a user-subject remapping migration that is not yet automated.
- A new attachment bucket requires an inventory and document VersionId rewrite that is not yet automated.
- Point-in-time failover and CDK reconciliation are documented operator procedures, not automatic recovery.
- Search clusters, malware scanning, real-time collaboration, email delivery, and external integrations are optional future cost gates rather than baseline dependencies.

These limitations should remain explicit. A self-hosted installation is the complete product core, but its owner is responsible for AWS credentials, DNS, identity administration, monitoring choices, backups, upgrades, incident response, and the resulting AWS charges.
