# Threat Model

## Assets

- Cognito identities and JWTs.
- Workspace membership and roles.
- Project metadata, tasks/comments, recurring meeting agendas/minutes, collaborative content and revisions, time/cost/resource data, integration links, external-share grants, activity history, attachment metadata/index text, and attachment objects.
- AWS infrastructure and deployment permissions.
- Disposable public-demo content; it is intentionally shared and is not a confidentiality boundary.

## Primary Risks

- Token theft from browser storage.
- Forged role or workspace identifiers from the browser.
- Public S3 exposure.
- Cross-site scripting in project text or Markdown.
- Server-side request forgery or redirect abuse through configured webhook/provider URLs.
- Leakage of scanner-extracted attachment text, directory credentials, provider credentials, or SCIM bearer material.
- Overbroad IAM permissions.
- Sensitive data in logs.
- Retried mutation duplicates.
- Concurrent lost updates and stale query projections.
- Attachment key guessing or public ACL mistakes.
- Direct use of the regional API Gateway endpoint to bypass CloudFront edge controls.
- A demo hostname reaching authenticated API routes, the primary hostname reaching anonymous demo routes, or a caller spoofing the edge's demo-host marker.
- OAuth callbacks, logout redirects, or future parent-domain cookies unintentionally sharing authenticated state with the public demo origin.
- Traffic or background-job amplification that causes unexpected spend.
- Anonymous callers attempting to select a private identity/account, reach a newly added mutation, upload untrusted bytes, exhaust the shared demo quota, or place sensitive information in disposable demo fields.

## Controls

- Cognito authorization-code flow with PKCE, per-login OAuth state validation, single-flight callback redemption, and no client secret in the static app.
- Team Spaces Managed Login v2 can use a pool's prefix endpoint while a shared custom domain remains on classic UI. A Cognito prefix-domain branding version is pool-wide and is not treated as a security-isolation boundary; use a dedicated pool when that boundary is required.
- API Gateway JWT authorization plus repeated membership and role checks in Lambda.
- Private S3 buckets with Block Public Access and CloudFront OAC.
- Checksum- and length-bound, single-use presigned S3 uploads with randomized keys, exact signed headers, private bucket policy, short URL/record expiry, finalize-time HEAD validation, version pinning, and pending-object lifecycle cleanup.
- Raw HTML is never interpreted by the application Markdown renderer; links are limited to HTTPS or application-relative targets and macros are rendered as text/known navigation.
- Capability inputs reject embedded secret-like properties. LDAP/provider configuration stores references or one-way hashes, not reusable credentials.
- Direct LDAP accepts only `ldaps://` without embedded credentials or paths, validates the server certificate and optional operator CA, uses bounded filters/results, performs service search followed by user bind, and never places the submitted password in membership data, tokens, activity, or logs. Directory identities cannot silently cross from one managed source to another.
- Provider requests reject redirects, private/loopback configuration, cross-origin path resolution, oversized responses, and unbounded page/path input. GitHub HMAC, GitLab shared-token, and collaboration HMAC verification happen before tenant mutations; delivery IDs are conditionally claimed with TTL replay protection. Provider-side task APIs require a separate constant-time bearer check and project allowlist.
- Webhook targets require public HTTPS without embedded credentials or literal private/loopback addresses, redirects are rejected, payloads are bounded, and delivery failures are recorded without response bodies.
- Scanner-extracted text remains an internal search value and is stripped from document list/detail/mutation/download responses.
- External task shares are expiring, recipient-bound, non-enumerable on denial, version-revocable, and expose only external-visible comments.
- CSP, HSTS, `nosniff`, restrictive referrer policy, and restrictive permissions policy.
- Least-privilege Lambda role.
- Structured logs with correlation IDs and no token or description logging.
- Version checks for updates; project-scoped work-item mutations use conditional DynamoDB writes.
- Notification schedules use sparse due-hour lookups, a one-concurrency worker, five-recipient batches, atomic per-user/period claims, bounded activity/work reads, two Scheduler retries, and a retained DLQ. A failed gateway attempt releases its claim so a Scheduler retry can deliver it; completed claims expire after 90 days.
- LDAP reconciliation uses one reserved concurrency, hourly scheduling, bounded directory result limits, two retries, and a retained DLQ. A directory size-limit response fails closed so an incomplete query cannot disable unseen users.
- Managed storage reconciliation is opt-in per exact workspace and resource, caps a run at 50 project/resource pairs, uses one reserved concurrency, retries idempotent reconciliation twice, and retains a DLQ. Microsoft removals are limited to configured managed email domains; Nextcloud removals require a configured managed principal prefix.
- HTTP API throttling, Lambda reserved concurrency, DynamoDB maximum on-demand throughput, short log retention, storage lifecycle rules, and budget alarms.
- GitHub OIDC for deployment credentials.
- A dedicated public-demo Lambda and PITR-off DynamoDB table with no authenticated-table or document-bucket IAM access.
- When an isolated demo hostname is configured, a CloudFront viewer-request guard compares the exact viewer `Host`, removes caller-supplied demo-host markers, rejects protected API routes on the demo host and demo API routes on other hosts, and adds the origin marker only to the exact demo-host/demo-route pair. The demo Lambda requires the marker as a repeated check. Hosted origin-secret enforcement separately rejects attempts to bypass that guard through the regional API endpoint.
- Cognito callback and logout URLs remain primary-origin-only. The demo origin cannot initiate sign-in or exchange an authorization code. Any future cookie-based authentication must use host-only `__Host-` cookies with `Secure`, `Path=/`, and no `Domain` attribute.
- A fixed server-owned demo identity and active-slot pointer; caller JWT, account, and local-demo headers are ignored on the public namespace.
- A default-deny public mutation policy, a CloudFront-and-Lambda 8 KiB request limit, no bodies on public reads, 1,024-character mutable fields, ten-record pages, a 32 KiB response ceiling, entity ceilings, a 500-attempt daily counter, a 2 RPS/10 burst route target, and reserved concurrency of ten so one normal page fan-out fits within the same bounded burst.
- Anonymous correlation IDs are restricted to 128 safe ASCII characters, raw request paths are sanitized and truncated before logging, and routine public 4xx failures rely on aggregate API metrics instead of per-request log records.
- Public uploads, finalize operations, accounts, memberships, workspace/profile mutations, and security controls are unavailable. The UI labels the workspace as shared, disposable, and unsuitable for sensitive data.
- Blue/green daily reset: only the inactive slot is cleared and seeded, and an optimistic pointer changes after verification. Reset and API roles are scoped only to the demo table.

## Open controls

- Meeting creates scope, hash, and transactionally commit optional idempotency claims with the meeting and activity event; claims become eligible for asynchronous TTL cleanup after 24 hours. Other create/update routes use direct addressing and optimistic versions but do not all provide durable replay after a lost response.
- Structural upload validation and quarantine are enforced. Scan requests carry short-lived object URLs through the configured scanner webhook, callbacks require the workspace scanner bearer credential, and only queued pending documents accept verdicts. Clean-scan gating is active when policy is `required`; operators still own scanner isolation, credential provisioning, engine maintenance, and failure handling.
- The API Gateway default hostname remains network-reachable. The isolated-host marker is routing defense, not a credential. Production stages the CloudFront origin-secret header with enforcement disabled for one completed deployment, then requires either the primary or temporary rotation secret so callers cannot forge the marker through the default endpoint. A dedicated origin domain with the default endpoint disabled remains a stronger defense-in-depth option.
- Most mutable parity resources enforce optimistic versions. Collaborative content additionally accepts recent stale bases through deterministic transforms, stable change-key replay suppression, a 100-revision history bound, and a conditional canonical/revision/activity transaction; older bases refresh instead of receiving an unbounded merge. Append-only activity, create-only saved views, presence leases, and connector event ingress use purpose-specific replay/bounds instead of a universal mutation claim.
- Public-HTTPS validation cannot by itself prevent DNS rebinding after resolution. Webhook execution should run behind deployment egress controls when untrusted administrators can configure endpoints.
- API Gateway throttling is best-effort and AWS cost signals are delayed. The daily mutation counter and entity limits bound write amplification, but accepted public read traffic can still incur request charges. Standalone pay-as-you-go WAF remains off to avoid a fixed monthly floor; evaluate the CloudFront Free plan separately before relying on its bundled WAF.
- The global anonymous counter intentionally charges every attempted allowed-path mutation before application validation, because rejected requests still consume edge/API/Lambda work. Any visitor can therefore exhaust shared editing for the current reset cycle, including with invalid content; the demo remains readable and resets automatically. Stronger per-client fairness would require another identity or edge-abuse mechanism and is not presented as a current guarantee.
