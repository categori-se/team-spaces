# Threat Model

## Assets

- Cognito identities and JWTs.
- Workspace membership and roles.
- Project metadata, tasks, comments, one-time meeting agendas and minutes, time entries, activity history, attachment metadata, and attachment objects.
- AWS infrastructure and deployment permissions.
- Disposable public-demo content; it is intentionally shared and is not a confidentiality boundary.

## Primary Risks

- Token theft from browser storage.
- Forged role or workspace identifiers from the browser.
- Public S3 exposure.
- Cross-site scripting in project text or Markdown.
- Overbroad IAM permissions.
- Sensitive data in logs.
- Retried mutation duplicates.
- Concurrent lost updates and stale query projections.
- Attachment key guessing or public ACL mistakes.
- Direct use of the regional API Gateway endpoint to bypass CloudFront edge controls.
- Traffic or background-job amplification that causes unexpected spend.
- Anonymous callers attempting to select a private identity/account, reach a newly added mutation, upload untrusted bytes, exhaust the shared demo quota, or place sensitive information in disposable demo fields.

## Controls

- Cognito authorization-code flow with PKCE, per-login OAuth state validation, single-flight callback redemption, and no client secret in the static app.
- Team Spaces Managed Login v2 can use a pool's prefix endpoint while a shared custom domain remains on classic UI. A Cognito prefix-domain branding version is pool-wide and is not treated as a security-isolation boundary; use a dedicated pool when that boundary is required.
- API Gateway JWT authorization plus repeated membership and role checks in Lambda.
- Private S3 buckets with Block Public Access and CloudFront OAC.
- Checksum- and length-bound, single-use presigned S3 uploads with randomized keys, exact signed headers, private bucket policy, short URL/record expiry, finalize-time HEAD validation, version pinning, and pending-object lifecycle cleanup.
- Raw HTML disabled for application-rendered Markdown.
- CSP, HSTS, `nosniff`, restrictive referrer policy, and restrictive permissions policy.
- Least-privilege Lambda role.
- Structured logs with correlation IDs and no token or description logging.
- Version checks for updates; project-scoped work-item mutations use conditional DynamoDB writes.
- HTTP API throttling, Lambda reserved concurrency, DynamoDB maximum on-demand throughput, short log retention, storage lifecycle rules, and budget alarms.
- GitHub OIDC for deployment credentials.
- A dedicated public-demo Lambda and PITR-off DynamoDB table with no authenticated-table or document-bucket IAM access.
- A fixed server-owned demo identity and active-slot pointer; caller JWT, account, and local-demo headers are ignored on the public namespace.
- A default-deny public mutation policy, a CloudFront-and-Lambda 8 KiB request limit, no bodies on public reads, 1,024-character mutable fields, ten-record pages, a 32 KiB response ceiling, entity ceilings, a 500-attempt daily counter, a 2 RPS/10 burst route target, and reserved concurrency of ten so one normal page fan-out fits within the same bounded burst.
- Anonymous correlation IDs are restricted to 128 safe ASCII characters, raw request paths are sanitized and truncated before logging, and routine public 4xx failures rely on aggregate API metrics instead of per-request log records.
- Public uploads, finalize operations, accounts, memberships, workspace/profile mutations, and security controls are unavailable. The UI labels the workspace as shared, disposable, and unsuitable for sensitive data.
- Blue/green daily reset: only the inactive slot is cleared and seeded, and an optimistic pointer changes after verification. Reset and API roles are scoped only to the demo table.

## Open controls

- Meeting creates now scope, hash, and transactionally commit optional idempotency claims with the meeting and activity event; claims become eligible for asynchronous TTL cleanup after 24 hours. Other create/update routes do not yet provide this durable replay contract, so the transaction/idempotency envelope must still be extended application-wide.
- Structural upload validation is enforced; malware/clean-scan gating remains an opt-in capability that must be enabled before accepting untrusted public uploads.
- The API Gateway default hostname remains network-reachable. Production stages the CloudFront origin header with enforcement disabled for one completed deployment, then requires either the primary or temporary rotation secret. A dedicated origin domain with the default endpoint disabled remains a stronger defense-in-depth option.
- Conditional/transactional version enforcement must be applied consistently to projects, documents, memberships, saved views, and future product resources.
- API Gateway throttling is best-effort and AWS cost signals are delayed. The daily mutation counter and entity limits bound write amplification, but accepted public read traffic can still incur request charges. Standalone pay-as-you-go WAF remains off to avoid a fixed monthly floor; evaluate the CloudFront Free plan separately before relying on its bundled WAF.
- The global anonymous counter intentionally charges every attempted allowed-path mutation before application validation, because rejected requests still consume edge/API/Lambda work. Any visitor can therefore exhaust shared editing for the current reset cycle, including with invalid content; the demo remains readable and resets automatically. Stronger per-client fairness would require another identity or edge-abuse mechanism and is not presented as a current guarantee.
