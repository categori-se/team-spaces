# Operations Runbook

This runbook covers both the minimal community profile and optional hosted operations. Do not expect or create alarms, SNS, an AWS Budget, PITR, public-demo resources, or managed-login imports unless that profile was enabled deliberately.

## Community Routine Checks

1. Confirm CloudFront distribution status is deployed.
2. Run `npm run smoke` with `SMOKE_URL` set to the production URL.
3. Confirm `runtime-config.json` names the expected application origin, Cognito endpoint, and client, then exercise sign-in and sign-out in a private browser.
4. Review the finite-retention API logs for errors or unexpected traffic.
5. Review Cost Explorer by the installation's application tag and compare request/storage growth with [the cost model](cost-model.md).
6. Verify the backup, export, and restore controls that the operator chose to enable.

## Hosted Operations Checks

Run these checks only when the hosted operations and public-demo layers are enabled:

1. Run `APP_URL=<app-origin> npm run check:hosted-auth`. This probe intentionally requires the public demo and its bounded concurrent page reads; it is not a community-profile smoke command.
2. Review CloudWatch alarms for Lambda errors, Lambda throttles, API 5xx responses, and DynamoDB throttles.
3. Confirm the SNS alarm email subscription is active and review AWS Budget notifications. Hosted deploys must supply `TEAMSPACES_BUDGET_EMAIL`; activate the configured user-defined cost-allocation tag in the payer account before relying on the tag-filtered budget.
4. Run a regular smoke workflow from the operator's release system.
5. Confirm the public-demo Scheduler is enabled, its DLQ is empty, and `/api/v1/demo/bootstrap` returns the seeded workspace without a Cognito session.

When an AWS Budget is enabled, the CDK stack includes a short notification-policy revision in its physical name. CloudFormation treats budget notification and subscriber changes as replacements, and AWS Budgets requires account-unique names. The revision lets CloudFormation create the updated alert policy before deleting the prior managed budget. Do not rename or delete a live budget manually during a deployment; after a successful replacement, confirm that exactly one current budget remains and still sends to the intended subscriber.

## Public Demo Reset

The public demo is isolated from authenticated data in its own table. EventBridge Scheduler resets it every day at 05:00 UTC. The reset prepares the inactive `a`/`b` slot and changes the active pointer only after seed verification; never manually delete the active slot or the protected application table.

After deployment, verify:

1. The stack outputs include `PublicDemoTableName`, `PublicDemoApiFunctionName`, and `PublicDemoResetFunctionName`.
2. `GET <app-origin>/api/v1/demo/bootstrap` succeeds without a Cognito token and reports `publicDemo.shared=true`, a seed version, and the last/next reset time.
3. `GET /api/v1/bootstrap` still requires Cognito.
4. After the origin-enforcement deployment, a direct `execute-api` request to the demo bootstrap without the CloudFront origin header returns 403. During the documented first observation deployment, enforcement is deliberately off, so defer this check until the second deployment.
5. The public-demo table contains `SYSTEM#PUBLIC_DEMO / ACTIVE`, its workspace points to the selected slot, and the reset DLQ has no visible messages.
6. A task edit succeeds, while account/member/workspace and upload mutations return 403.

To request an immediate controlled reset, invoke the stack's `PublicDemoResetFunctionName` with `{"source":"teamspaces.public-demo","detail-type":"Manual public demo reset","force":true}`. Inspect the synchronous result, then repeat checks 2 and 5. Do not use DynamoDB TTL or ad-hoc table deletion as the reset mechanism.

If public traffic or abuse is unexpected, use the stack's `PublicDemoApiFunctionName` output to set that Lambda's reserved concurrency to zero. Leave the demo table and authenticated API intact. After investigation, restore its configured concurrency of ten and run a manual reset. The concurrency ceiling matches the route's burst so one page can issue its bounded parallel reads; reserved concurrency has no idle charge. API Gateway's 2 RPS/10 burst setting is best-effort, while the daily mutation and entity limits are the authoritative write-amplification controls.

## Work Index Rollout

For an installation with existing tasks, use two production releases:

1. Deploy with `TEAMSPACES_WORK_INDEX_READY=false`, `TEAMSPACES_ORIGIN_SECRET_SLOT=primary`, and `TEAMSPACES_ORIGIN_VERIFY_ENFORCED=false`. This enables dual writes while keeping the bounded legacy cross-project reader, and lets CloudFront finish propagating the new origin header before Lambda enforces it.
2. Run each dry-run/apply page pair from the same starting cursor as documented in [access patterns](access-patterns.md).
3. Run `TABLE_NAME=exact-table-name npm run migrate:work-index -- --mark-ready`. It performs the zero-repair pass, compares canonical and indexed work counts, and writes the required table marker only on success.
4. After the first deployment is complete, set `TEAMSPACES_ORIGIN_VERIFY_ENFORCED=true`. If the marker verification succeeded, also set `TEAMSPACES_WORK_INDEX_READY=true`; otherwise leave the work-index flag false. Deploy again. The unchanged primary secret is already present at CloudFront, so enforcement cannot race its propagation.
5. Confirm planning pagination and page-scoped summary labels in the production smoke test.

If verification fails, leave the flag false. The runtime also checks the marker, so the configuration switch alone cannot activate an unverified reader. Turning the flag off restores the legacy reader without disabling dual writes; it does not repair missing keys.

## Origin Secret Rollout and Rotation

The first secret-bearing release is deliberately observational: set `TEAMSPACES_ORIGIN_SECRET_SLOT=primary` and `TEAMSPACES_ORIGIN_VERIFY_ENFORCED=false`, deploy, and wait for the workflow, CloudFront deployment, and smoke checks to finish. Only then set enforcement to `true` and deploy the unchanged secret again. This avoids a 403 window while Lambda and CloudFront update at different speeds. A missing or malformed enforcement value makes a production deploy fail before CDK runs.

For a later rotation from primary value A to a newly generated value B, keep enforcement enabled and use both slots:

1. Store B as `TEAMSPACES_ORIGIN_SECRET_NEXT`, keep the slot `primary`, and deploy. Lambda now accepts A or B while CloudFront still sends A.
2. Change `TEAMSPACES_ORIGIN_SECRET_SLOT=next` and deploy. CloudFront moves to B while Lambda accepts both values.
3. Replace `TEAMSPACES_ORIGIN_SECRET` with B, change the slot back to `primary`, delete `TEAMSPACES_ORIGIN_SECRET_NEXT`, and deploy. Both the pre-update and post-update CloudFront configurations send B, so either resource update order is safe.

Never overwrite the primary secret in one step while it is the only value Lambda accepts. Never place either value in a retained synth output, command log, issue, or runbook.

## Emergency API Shutdown

To disable mutating API traffic without deleting data:

1. Set the API Lambda reserved concurrency to `0`. Removing the CloudFront behavior alone is not an authoritative shutdown control.
2. Leave DynamoDB and S3 buckets intact.
3. Restore concurrency after the incident is resolved.

The normal defaults are 25 API requests/second with a burst of 50, 10 concurrent API Lambda executions, 500 maximum DynamoDB read request units, and 200 maximum write request units for the table and each GSI. These are best-effort blast-radius controls, not monthly spending caps. Change them only with a load result and updated cost estimate.

## Cognito Administrator Recovery

Use the AWS console or CLI with the account owner role to add a temporary workspace administrator to Cognito, then add a corresponding membership record through an audited repair script.

## Cognito Managed Login

The hosted profile can use Managed Login v2 on an existing prefix endpoint while a shared custom domain remains on Hosted UI classic for other app clients. The stack updates only the configured prefix endpoint, creates the Team Spaces client-specific style, and writes the new runtime URL after that style exists. Confirm other clients' domain use in protected operator inventory: a prefix version is pool-wide and is not a hard client-isolation boundary.

Stage the first rollout. Keep the GitHub production-environment variable `TEAMSPACES_USE_MANAGED_LOGIN=false` for the first reviewed deployment. That deployment provisions and styles the v2 prefix while browsers continue using the configured fallback custom domain. A domain-version update is external and not transactionally restored by CloudFormation: if the deployment rolls back after the update, the prefix can remain on v2, while the app remains safely on the custom domain. Inspect the stack events and repeat the checks below before proceeding.

After deployment, verify the isolation and style:

```bash
aws cognito-idp describe-user-pool-domain \
  --domain "$COGNITO_MANAGED_LOGIN_DOMAIN_PREFIX" \
  --region "$AWS_REGION" \
  --query 'DomainDescription.{status:Status,version:ManagedLoginVersion}'

aws cognito-idp describe-user-pool-domain \
  --domain "$COGNITO_FALLBACK_DOMAIN" \
  --region "$AWS_REGION" \
  --query 'DomainDescription.{status:Status,version:ManagedLoginVersion}'

aws cognito-idp describe-managed-login-branding-by-client \
  --user-pool-id "$COGNITO_USER_POOL_ID" \
  --client-id "$COGNITO_CLIENT_ID" \
  --return-merged-resources \
  --region "$AWS_REGION" \
  --query 'ManagedLoginBranding.Settings.categories.global.colorSchemeMode'
```

The prefix must be `ACTIVE` on version `2`, the shared custom domain must remain on version `1`, and the Team Spaces style must report `DYNAMIC`. Directly open the prefix authorization URL and exercise sign-in, invalid credentials, and password reset in fresh private browsers using both light and dark OS/browser modes. When those checks pass, set `TEAMSPACES_USE_MANAGED_LOGIN=true`, deploy a second reviewed `main` SHA, then verify sign-out and the full application callback. The Cognito page follows browser preference because its separate origin cannot read the app's local theme override.

To roll back the application entry point without deleting the style or changing the custom domain, set the GitHub production-environment variable `TEAMSPACES_USE_MANAGED_LOGIN=false` and deploy the last known-good reviewed `main` SHA. This returns Team Spaces to the configured fallback domain; leave the prefix and branding resource intact for diagnosis. A new SHA that contains an invalid branding update can fail before writing the fallback runtime configuration, which is why the known-good SHA matters. Set the variable back to `true` only after the prefix authorize page and callback flow pass.

## DNS cutover

Keep the live distribution, API, Cognito, bucket, certificate, and DNS validation identifiers in protected operator inventory. Before cutover, confirm the ACM certificate is `ISSUED`, the stack is `UPDATE_COMPLETE`, and the CloudFront distribution is deployed. If a client still sees `Server Not Found`, check public resolver propagation and local/VPN DNS cache before changing CloudFront.

`runtime-config.json` is created outside the Observable build and must be preserved during web asset deployments. The CDK bucket deployment excludes `runtime-config.json` from prune so future deploys do not delete it.

For a domain cutover or certificate replacement:

1. Confirm the app ACM certificate is `ISSUED`.
2. If validation is pending, add the ACM validation CNAME supplied by AWS; do not copy a record from another installation.
3. Deploy the reviewed hosted profile with the intended AWS identity.
4. Copy the CloudFront `DistributionDomainName` output.
5. Create or update the operator's DNS record to point the application hostname at that exact output.
6. Wait for DNS propagation.
7. Confirm `<app-origin>/runtime-config.json` returns JSON, not `index.html`.
8. Run `SMOKE_URL=<app-origin> npm run smoke`.
9. Run `APP_URL=<app-origin> npm run check:hosted-auth`.
