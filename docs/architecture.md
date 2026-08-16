# Architecture

Team Spaces uses a static Observable Framework frontend, modular JavaScript Lambda functions, on-demand DynamoDB, private S3 buckets, Cognito, API Gateway, and CloudFront. The community baseline has no continuously running compute, no provisioned database capacity, and one application table. Monitoring, point-in-time recovery, and the isolated public showcase are explicit deployment options.

```text
Browser
  |
  | HTTPS
  v
CloudFront
  |-- /*      -> private S3 web bucket through Origin Access Control
  |-- /api/*  -> API Gateway HTTP API, caching disabled
                    |
                    v
                 Authenticated Lambda API
                    |-- protected DynamoDB application table
                    |-- private S3 document bucket through presigned URLs
                    |-- Cognito claims from JWT authorizer

Optional hosted-showcase profile
  |-- /api/v1/demo/* -> public-demo Lambda (no Cognito)
                           |-- disposable demo-only DynamoDB table
                           |-- fixed server-owned demo identity

  EventBridge Scheduler -> reset Lambda -> inactive demo slot -> atomic pointer flip
```

Capabilities that do not belong on the synchronous request path use an optional asynchronous lane:

```text
DynamoDB Streams / S3 events / API outbox
  -> SQS queue + dead-letter queue
  -> ARM Lambda worker
       |-- notification fan-out and email batches
       |-- query projections and report summaries
       |-- imports, exports, webhooks, and document processing

EventBridge Scheduler
  -> the same queue or worker for reminders, digests, recurring meetings,
     date alerts, and scheduled integration sync
```

SQS, Scheduler, Streams, and Lambda remain request-priced and add no always-on host. They are introduced only with the feature that consumes them, with retry limits, dead-letter handling, and concurrency ceilings.

## Architecture principles

- **Scale with use:** static files are cached at the edge; APIs, queues, schedules, compute, and DynamoDB are pay-per-use.
- **Bounded synchronous work:** list APIs use opaque cursors and stable keyset ordering. Cross-project screens must migrate from bounded pilot fan-out to workspace projections as their scale-sensitive access paths are implemented.
- **Direct mutations:** a mutable resource is addressed by its account/project key. Meeting create/update now demonstrate the target pattern: one transaction commits the canonical row with activity, and keyed creates also commit a TTL replay claim. Conditional writes already protect task and project versions; extending the same transaction/idempotency envelope to every mutation and projection remains required.
- **Explicit cost ceilings:** API rate/burst limits, Lambda reserved concurrency, DynamoDB on-demand maximum throughput, short log retention, and storage lifecycle rules bound ordinary work. Alarm metrics and budgets are optional operator controls rather than core dependencies.
- **Optional expensive capabilities:** full attachment-content search, malware scanning, real-time collaboration, BIM processing, and external connectors are independently enabled. Core planning never depends on an idle-priced search or relational cluster.

## Public Entry Point

CloudFront is the only supported application entry point. The web bucket blocks all public access and is read only by CloudFront through Origin Access Control. The document bucket blocks public access and is accessed through short-lived presigned URLs only.

The regional API Gateway `execute-api` hostname remains network-reachable. Private application routes still require Cognito JWTs and server-side workspace authorization. The community baseline leaves the unauthenticated health route directly reachable and does not invent or persist an origin secret.

The hosted production profile additionally requires a high-entropy `TEAMSPACES_ORIGIN_SECRET`. CloudFront injects the selected secret as a custom origin header and, after an explicit observation deployment, Lambda rejects requests that match neither the primary nor optional rotation slot. Separating propagation from enforcement prevents a first-rollout outage; accepting both populated slots permits ordered, zero-downtime rotation. The shared header is a pragmatic, demand-priced origin control; a dedicated API origin domain with the default endpoint disabled remains the stronger future option.

## Optional Public Demo Boundary

The hosted-showcase profile can start an explicit, session-scoped public demo without creating a Cognito user. The community profile does not synthesize the demo route, table, Lambdas, queue, schedule, seed resource, or demo alarms. When enabled, only `/api/v1/demo/{proxy+}` is unauthenticated at API Gateway. CloudFront origin verification still applies in the hosted profile, and the demo Lambda ignores caller identity, account-selection, and demo-identity headers. It always resolves a server-owned visitor and the currently active demo slot.

An operator can put that demo on a distinct `TEAMSPACES_PUBLIC_DEMO_DOMAIN_NAME`. The primary and demo names are aliases on one CloudFront distribution backed by the same private web bucket and static build; the option does not create a second distribution, API, or continuously running service. `runtime-config.json` publishes the exact demo origin so landing-page links cross into the demo deliberately, while direct visits to that origin enter demo mode automatically.

The two browser origins have an exact host/API boundary. The viewer-request guard removes any caller-supplied demo-host marker, rejects protected `/api/*` routes on the demo hostname, rejects `/api/v1/demo/*` on every other hostname, and injects an origin marker only for the exact demo hostname and demo namespace. The demo Lambda requires that marker when hostname isolation is enabled. This edge-and-origin check makes a forged viewer header or a copied demo URL on the authenticated hostname insufficient to cross the CloudFront boundary. Hosted origin-secret enforcement separately rejects a caller that attempts to forge the marker through the regional API endpoint.

Only the primary application origin initiates Cognito authorization and token exchange, and Cognito callback/logout URIs remain primary-origin-only. The demo origin neither becomes an OAuth callback/logout URI nor starts a login flow. Authentication currently uses browser storage rather than cookies. If authentication later uses cookies, host-scoped `__Host-` cookies with `Secure`, `Path=/`, and no `Domain` attribute are required; a parent-domain cookie would weaken this hostname boundary.

Anonymous records never enter the protected application table, its point-in-time backups, or the document bucket. A separate on-demand table has its own throughput maximums and PITR disabled. The demo API role can access only that table and has no S3 permissions. Its route policy is default-deny: ordinary project, task, board/workflow, meeting, time, comment, saved-view, and document-metadata exploration is allowed; account, membership, profile, workspace, security, upload, and finalize mutations are rejected server-side.

The demo makes those safe boundaries visible instead of simulating unavailable infrastructure. It opens a seeded meeting with agenda decisions and linked task follow-ups, presents fictional document records with short embedded plain-text previews, and explains which identity, membership, security, and file-transfer actions require a private workspace. The previews are bounded disposable fixture text in the demo table; they are not downloadable objects and never enter the protected document pipeline.

The table holds two alternating demo slots. The daily reset Lambda cleans and seeds the inactive slot, verifies it, then conditionally changes one active pointer. A failure before the pointer change leaves the previous demo intact. The reset uses registered project and user partitions with paginated queries and retried batch writes; it never scans or touches authenticated data. EventBridge Scheduler runs it at 05:00 UTC, and the same handler seeds the first slot through a deployment custom resource.

## Core Data Boundaries

- Workspace records are user-facing accounts. A user can have a private personal account and can create team or client accounts for shared portfolios and projects.
- Membership records bind users to accounts, store role and status, and may optionally restrict a member to specific projects inside the account.
- Portfolio, project, task, one-time meeting, time entry, saved view, document, and activity records are application data in DynamoDB.
- Authenticated document bytes are never stored in DynamoDB; DynamoDB stores metadata and S3 object keys only. The isolated disposable public demo may embed short fictional text previews solely to demonstrate organization without granting S3 access.
- Activity records are append-only capture events for user-visible mutations and document link generation.

As the product expands, the same table also holds configuration (modules, types, fields, workflows, calendars, roles), collaboration resources (comments, meetings, wiki/news/forum records), financial records, notification inboxes, idempotency claims, and compact query/report projections. Large bytes, generated exports, document revisions, and BIM models remain in S3.

## Query and projection boundary

Canonical project, work, and meeting records are stored under stable project keys. Workspace, portfolio, assignee, due-date, meeting-start, notification, and saved-query access uses sparse GSIs or transactionally maintained projection records. Project meeting pages reuse GSI1 with a project-meetings partition and UTC start-time sort key; there is no global meeting scan. Status is currently a bounded residual Work Query filter; a future status-first access path requires its own projection item. A projection may duplicate bounded display fields to avoid request-time fan-out; canonical records remain authoritative.

The workspace work projection has an explicit rollout boundary. New code dual-writes the projection while `TEAMSPACES_WORK_INDEX_READY=false`; cross-project reads retain the legacy path. The scalable reader activates only when both the deployment switch is true and the table contains the verifier-written `SYSTEM#MIGRATION / WORK_INDEX_V1` marker. This prevents a configuration mistake from exposing a partially backfilled index.

Text search starts with bounded token/prefix indexes in DynamoDB for metadata and rich text. Attachment-content indexing is opt-in. A search service may be enabled only when measured usage justifies its non-trivial active-hour cost and it can scale to zero while idle.

## Collaboration and scheduling boundary

- Meeting series store recurrence rules; occurrences and reminders are materialized asynchronously.
- Automatic scheduling runs as a bounded job and writes a versioned proposal before applying date changes. Manual edits remain normal conditional mutations.
- Rich collaborative editing can add API Gateway WebSocket connections and a Lambda/DynamoDB operation log without changing the static Observable deployment. It is not required for ordinary wiki/document editing.
- Email is derived from durable in-app notifications. Immediate mail is opt-in; batched digests are the cost-conscious default.

## Hosted deployment domain

Hosted operators supply the primary public hostname, optional isolated demo hostname, and CloudFront certificate through protected deployment configuration. One certificate must cover every configured alias. DNS remains external, so CDK accepts `domainName`, optional `publicDemoDomainName`, and `certificateArn` context values but does not create Route 53 records. The generic community installer likewise requires operator-owned hostnames and an issued CloudFront certificate in `us-east-1`; it creates no Route 53 hosted zone or DNS record. Operators add a new demo traffic record only after the reviewed deployment has attached its alias to a deployed distribution.

## Runtime Configuration

The static application reads `runtime-config.json` at runtime for Cognito and API settings. It never embeds private user or project data at build time.

## Account Selection

The frontend stores the selected account id locally and sends it as `x-teamspaces-account-id`. The API only honors that id after verifying the current user has active membership in the account. Without a selected account, the API selects the user's default active account, or creates a private personal account for a first-time user.

## Authentication

The community profile creates an installation-owned Cognito Lite pool, app client, and prefix domain. Self-sign-up is disabled, and the operator deliberately creates the first user.

The optional hosted profile can instead import an existing pool and use Managed Login v2 on an operator-configured Cognito prefix domain. It creates its own app client, applies a browser-adaptive light/dark style to that client, and writes the client id and prefix URL to `runtime-config.json` only after the style exists. A shared custom domain can remain on Hosted UI classic, avoiding a branding-version migration for applications that continue to use it. The prefix version is nevertheless pool-wide and is operational separation rather than a client-isolation boundary. With a custom domain also present, the prefix is used only for the explicit authorize, token, and logout endpoints—not OIDC discovery. Managed Login follows the browser/OS color preference; the separate Cognito origin cannot read the app's local theme override.

## Security Headers

CloudFront attaches CSP, HSTS, `X-Content-Type-Options: nosniff`, restrictive referrer policy, and restrictive permissions policy. API routes use exact-origin CORS.

## Cost and failure isolation

The HTTP API is throttled before Lambda, the API Lambda has reserved-concurrency limits, and DynamoDB on-demand throughput has explicit maximums. Future background consumers must use separate concurrency and dead-letter queues so imports, email, search indexing, or integrations cannot starve interactive work. See [cost-model.md](cost-model.md) for the light-use envelope and feature cost gates.
