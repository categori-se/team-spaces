# DynamoDB Access Patterns

Authenticated Team Spaces data uses one protected on-demand DynamoDB table with a primary key and two GSIs. The public demo uses a second disposable table with the same entity/index shapes so its anonymous writes, throughput, IAM access, and backup policy remain isolated. The schema is designed from access patterns rather than normalized relational modeling.

## Table Keys

- `PK` string partition key.
- `SK` string sort key.
- `GSI1PK` and `GSI1SK` for workspace/project/report/date access.
- `GSI2PK` and `GSI2SK` for assignee and project/date secondary access.

## Entity Records

| Entity | PK | SK | Notes |
| --- | --- | --- | --- |
| Workspace/account | `WORKSPACE#<workspaceId>` | `META` | Account metadata; `accountType` is personal, team, or client |
| Work configuration | `WORKSPACE#<workspaceId>` | `WORK_CONFIGURATION` | Versioned task types, statuses, defaults, and role-scoped status transitions; absent records use the code-defined v1 default |
| Workspace capabilities | `WORKSPACE#<workspaceId>` | `CAPABILITIES` | Versioned lifecycle, entity-aware field definitions, enumeration values, forms/actions, finance/resources, identity, branding, notifications, integrations, sharing, security, SCIM, MCP, and work settings |
| Membership | `WORKSPACE#<workspaceId>` | `MEMBER#<userId>` | Role, status, profile, user custom fields, optional `projectIds` restriction, and directory source/external identity/department mapping |
| User account index | `USER#<userId>` | `ACCOUNT#<workspaceId>` | Account switcher lookup for current user |
| Portfolio | `WORKSPACE#<workspaceId>` | `PORTFOLIO#<portfolioId>` | Archive flag, name |
| Project | `PROJECT#<projectId>` | `META` | Project metadata |
| Project-to-portfolio projection | `WORKSPACE#<workspaceId>` | `PROJECT_PORTFOLIO#<portfolioId>#PROJECT#<projectId>` | Transactional duplicate used only for the portfolio project GSI |
| Task | `PROJECT#<projectId>` | `WORK#<workItemId>` | Task, milestone, risk, or issue; Work Query v1 also projects the canonical row into the workspace work GSI |
| Meeting | `PROJECT#<projectId>` | `MEETING#<meetingId>` | One-time or recurring/template meeting with bounded participants, agenda, attendance, attachment IDs, minutes, and outcomes; project/global sparse indexes order normalized start time |
| Project content | `PROJECT#<projectId>` | `CONTENT#<contentId>` | Wiki/document/news/forum canonical record; GSI1 supplies bounded workspace search |
| Content revision | `CONTENT#<contentId>` | `REVISION#<zero-paddedVersion>` | Immutable body/status revision plus canonical text operation/change key when produced by the collaborative editor |
| Content presence | `PROJECT#<projectId>` | `CONTENT_SESSION#<contentId>#<userId>#<clientId>` | Short TTL editor lease, never authoritative content |
| Planning resource | `PROJECT#<projectId>` | `PLANNING#<resourceId>` | Version (including custom fields), sprint, baseline snapshot, work calendar, or saved board; GSI1 groups workspace resources by kind |
| Activity | `PROJECT#<projectId>` | `ACTIVITY#<reverseTimestamp>#<activityId>` | Append-only mutation history |
| Notification read marker | `WORKSPACE#<workspaceId>#USER#<userId>` | `NOTIFICATION_READ#<activityId>` | Per-user read state with 180-day TTL |
| Notification preferences | `WORKSPACE#<workspaceId>#USER#<userId>` | `NOTIFICATION_PREFERENCES` | Versioned global/project participation and scheduled-summary settings; active schedules project to GSI2 by UTC hour |
| Notification digest claim | `WORKSPACE#<workspaceId>#USER#<userId>` | `NOTIFICATION_DIGEST#<frequency>#<date>` | Conditional per-period delivery claim with 90-day TTL |
| Meeting create claim | `WORKSPACE#<workspaceId>` | `IDEMPOTENCY#MEETING_CREATE#<sha256>` | Optional caller-key replay record scoped to workspace, actor, and operation; stores only hashes and the original result, and becomes TTL-cleanup eligible after 24 hours |
| Document | `PROJECT#<projectId>` | `DOCUMENT#<documentId>` | Metadata only; optional `workItemId`; object bytes live in private S3 |
| Time entry | `USER#<userId>` | `TIME#<date>#<timeEntryId>` | User/date timesheet with configured activity and time-entry custom fields |
| Active timer | `USER#<userId>` | `TIMER#<workspaceId>` | At most one conditional cross-device timer per user/workspace; retains activity/custom-field values until transactional stop |
| Saved view | `USER#<userId>` | `SAVED_VIEW#<viewId>` | Private view |
| Integration link | `WORKSPACE#<workspaceId>` | `INTEGRATION#<linkId>` | Project/task-scoped provider record link; credentials remain references in capabilities |
| Provider delivery claim | `WORKSPACE#<workspaceId>` | `PROVIDER_DELIVERY#<connectorId>#<deliveryId>` | Conditional webhook replay claim/result with 30-day TTL; failed processing releases the claim |
| Repository snapshot | `WORKSPACE#<workspaceId>` | `REPOSITORY_SNAPSHOT#<repositoryId>` | Bounded Git/SVN tree mirror and revision metadata |
| External share | `SHARE#<token>` | `META` | Recipient-bound share; a `SHARE_INDEX#<token>` workspace projection supports administration |
| Outbound-link event | `WORKSPACE#<workspaceId>` | `OUTBOUND#<reverseTimestamp>#<id>` | Captured policy decision when capture is enabled |
| Webhook delivery | `WORKSPACE#<workspaceId>` | `WEBHOOK_DELIVERY#<reverseTimestamp>#<id>` | Bounded automatic/test delivery status without response bodies or secrets |
| Report summary | `WORKSPACE#<workspaceId>` | `SUMMARY#PROJECT#<projectId>` | Compact project summary |
| Upload intent | returned by API | not persisted separately | Document starts as `pending` before finalize |

## GSIs

### GSI1: Workspace and Project Reporting

- Projects by workspace: `GSI1PK = WORKSPACE#<workspaceId>#PROJECTS`, `GSI1SK = STATUS#<status>#UPDATED#<updatedAt>#PROJECT#<projectId>`.
- Projects by portfolio: a duplicate projection uses `GSI1PK = WORKSPACE#<workspaceId>#PORTFOLIO#<portfolioId>#PROJECTS` while the canonical project remains in the workspace-project partition.
- Time by project/date: `GSI1PK = PROJECT#<projectId>#TIME`, `GSI1SK = DATE#<date>#TIME#<timeEntryId>`.
- Report summaries: `GSI1PK = WORKSPACE#<workspaceId>#REPORTS`, `GSI1SK = PROJECT#<updatedAt>#<projectId>`.
- Documents by workspace: `GSI1PK = WORKSPACE#<workspaceId>#DOCUMENTS`, `GSI1SK = UPDATED#<updatedAt>#DOCUMENT#<documentId>`.
- Work by workspace/update time: `GSI1PK = WORKSPACE#<workspaceId>#WORK`, `GSI1SK = UPDATED#<updatedAt>#PROJECT#<projectId>#WORK#<workItemId>`.
- Meetings by project/start time: `GSI1PK = PROJECT#<projectId>#MEETINGS`, `GSI1SK = START#<startsAt>#MEETING#<meetingId>`.
- Activity by workspace/reverse time: `GSI1PK = WORKSPACE#<workspaceId>#ACTIVITY`, `GSI1SK = TIME#<reverseTimestamp>#<activityId>`.
- Content by workspace/update time: `GSI1PK = WORKSPACE#<workspaceId>#CONTENT`, `GSI1SK = UPDATED#<reverseTimestamp>#<contentId>`.
- Planning resources by kind/start: `GSI1PK = WORKSPACE#<workspaceId>#PLANNING#<kind>`, `GSI1SK = START#<startDate>#<resourceId>`.

### GSI2: Assignments and Due Dates

- Assigned work: `GSI2PK = WORKSPACE#<workspaceId>#ASSIGNEE#<userId>`, `GSI2SK = DUE#<dueDate>#WORK#<workItemId>`.
- Meetings across accessible projects: `GSI2PK = WORKSPACE#<workspaceId>#MEETINGS`, `GSI2SK = START#<startsAt>#PROJECT#<projectId>#MEETING#<meetingId>`.
- Time across a workspace: `GSI2PK = WORKSPACE#<workspaceId>#TIME`, `GSI2SK = DATE#<date>#USER#<userId>#TIME#<timeEntryId>`.
- Scheduled notification preferences by due UTC hour: `GSI2PK = NOTIFICATION_SCHEDULE#HOUR#<00-23>`, `GSI2SK = ACTIVE#WORKSPACE#<workspaceId>#USER#<userId>`.

Status is currently a validated residual filter on project, assignee, or workspace-work pages. A status-first access path requires a separate projection record; one canonical work item cannot occupy both an assignee and status partition in the same GSI.

## Required Queries

| Query | Index |
| --- | --- |
| Fetch current user and workspace membership | Table PK/SK |
| Fetch workspace task taxonomy and workflow | Strongly consistent table PK/SK read; fall back to the code-defined v1 default without writing on GET |
| Fetch/replace workspace capabilities | Strongly consistent `CAPABILITIES` read and conditional versioned Put; embedded secrets are rejected |
| Replace workspace task taxonomy and workflow | Conditional table Put on the expected version; first customization requires the virtual default version and `attribute_not_exists(PK)` |
| List user accounts | Table query on `USER#<userId>` account index |
| Create user account | Transaction writes account `META`, owner `MEMBER`, and user account index |
| Update current user profile preferences | Table PK/SK on membership |
| List workspace members | Table query on workspace PK |
| Update workspace settings | Table PK/SK |
| List workspace portfolios | Table query on workspace PK |
| List projects by workspace | GSI1 |
| List projects by portfolio | GSI1 |
| Filter projects by status, health, owner, or update time | GSI1 plus bounded API-side filtering for MVP |
| Fetch one project | Table PK/SK |
| List project tasks | Table query on project PK |
| Page cross-project work by most recent update | GSI1 workspace work partition |
| List tasks assigned to a user | GSI2 |
| Filter tasks by status and due date | Selected Work Query path plus bounded residual filtering |
| List meetings by project/start time | Existing GSI1 with a project- and query-bound opaque keyset cursor |
| Fetch one meeting | Direct `PROJECT#<projectId> / MEETING#<meetingId>` strongly consistent read after resolving project access |
| List meetings across a workspace | GSI2 workspace-meetings partition plus project-access filtering |
| Create one meeting | One transaction writes the conditional canonical row, activity event, and optional idempotency claim; changing content never reuses another caller's scoped key |
| Update one meeting | One transaction conditionally replaces the canonical version and appends activity; changing `startsAt` rewrites GSI1SK on that same row |
| List time entries by user and date range | Table query on user PK |
| List time entries by project and date range | GSI1 |
| List project activity in reverse chronological order | Table query on project PK |
| List workspace activity and notifications | GSI1 workspace-activity partition plus actor/mention/reminder filters |
| List/fetch project content and revisions | Project content prefix query, direct canonical key, and content revision partition |
| Update collaborative content presence | Conditional direct TTL lease key; expired leases are ignored before DynamoDB cleanup |
| Merge collaborative content | Strong current-content read plus at most 100 recent revision rows; transform the stable change against every intervening operation and transactionally write canonical content, immutable revision, and activity |
| List planning resources / compare baseline / burndown | Project planning prefix query or kind-specific GSI1; bounded project work query for derived comparison |
| Read/start/stop timer | Direct user/workspace timer key; conditional create and transactional stop/time-entry write |
| List saved views for a user | Table query on user PK |
| List project documents | Table query on project PK |
| List workspace documents | GSI1 |
| Filter documents by task | Project query or workspace document query plus bounded API-side `workItemId` filtering for MVP |
| Fetch, mutate, or download one document | Direct table PK/SK; API requires `projectId` with `documentId` |
| Build application data inventory | Existing bounded workspace, project, work, meeting, user, document, and activity queries |
| Fetch project-summary records for reporting | GSI1 |
| Search workspace records | Bounded workspace project/work/document/content/activity projections; project access is applied before text matching |
| Browse integrations, repository snapshots, shares, and deliveries | Workspace prefix query or exact token/snapshot key; every returned project reference is access-filtered |
| Reconcile LDAP users/groups | Workspace capability/member prefix queries plus exact conditional member/capability writes; no table scan |

## Guardrails

No user-facing endpoint may scan the table after data migration. During the pilot, `GET /accounts` may use a bounded scan fallback only when a user's legacy membership records predate the `USER#<userId> / ACCOUNT#<workspaceId>` index. A third GSI requires a new access-pattern entry and a cost review.

## Public Demo Slots and Reset

The demo table contains two isolated slots and one control pointer:

| Record | PK | SK | Purpose |
| --- | --- | --- | --- |
| Active pointer | `SYSTEM#PUBLIC_DEMO` | `ACTIVE` | Active slot, seed version, reset time, and optimistic pointer version |
| Daily quota | `WORKSPACE#<demoWorkspaceId>` | `PUBLIC_DEMO_QUOTA#<reset-cycle date>` | Atomic total and per-entity creation counters for the 05:00 UTC reset cycle, with TTL cleanup |
| Project registry | `WORKSPACE#<demoWorkspaceId>` | `DEMO_PARTITION#PROJECT#<projectId>` | Enumerates every seeded or visitor-created project partition for cleanup |

Member IDs, workspace IDs, project IDs, user partitions, and all secondary-index keys are slot-specific. A public project create transaction writes the canonical project, optional portfolio projection, and its registry row together. This keeps cleanup complete without a table scan.

The reset process queries the inactive workspace partition, reads its member and project registries, and queries those exact `USER#...` and `PROJECT#...` partitions. It batch-deletes child partitions with bounded retries before deleting their workspace registry, so a failed invocation retains the discovery records needed by its retry. It then batch-writes the canonical relative-date seed, verifies the workspace and project registry, and conditionally flips `SYSTEM#PUBLIC_DEMO / ACTIVE`. The active slot is never cleared in place. If cleanup, seeding, or verification fails, new requests continue using the prior slot.

Unlike an upgraded authenticated table, the disposable demo table is created with every task's workspace-work GSI attributes and a verified `SYSTEM#MIGRATION / WORK_INDEX_V1` readiness marker. Only the demo Lambda sets `WORK_INDEX_READY=true`, so its planning route uses ten-record keyset pages immediately; the authenticated table retains its independent two-release migration gate.

The demo handler caps a requested collection limit at ten before routing. Work and meeting routes retain opaque cursor pagination. Older list-shaped routes that do not yet have a cursor contract read at most one extra record, return at most the requested ten, and set `pageInfo.truncated=true` when more shared records exist; they never expose the larger collection just because the underlying adapter is Memory or DynamoDB.

Public-demo seed changes require an intentional `publicDemoSeedVersion` bump in the CDK stack. The deployment custom resource uses that property to decide whether to initialize a new seed immediately; without a bump, the next scheduled 05:00 UTC reset will still use the newly deployed code, but deployment itself will not force a refresh.

## One-time Meetings

A meeting is a single canonical project-partition record. The existing GSI1 provides chronological pages, so this slice adds no table, index, queue, scheduler, or other always-on service. Timestamps are normalized to UTC before they are used in `GSI1SK`; an optimistic start-time update conditionally replaces the canonical row and therefore updates its index order atomically. Cursors bind the complete GSI continuation key to the adapter, workspace, query version, and project ID and cannot be reused for a different project.

Every list, detail, create, and patch first resolves the project with the caller's optional `projectIds` restriction. Detail reads then use the project-scoped primary key. Participant validation batch-gets only membership keys inside the selected workspace and requires each invitee to be active and eligible for that project. Agenda task validation batch-gets only `WORK#<workItemId>` keys inside the meeting's project partition, so a globally valid ID from another project is rejected. Both checks are capped at 100 exact keys or fewer and never scan.

Serialized meeting content stays at or below 32 KiB. That cap is intentionally tighter than DynamoDB's item limit: a keyed create transaction stores both the meeting and its replay snapshot, and the combined transactional write must retain headroom below the deployment's 200-WRU table/GSI ceilings. A meeting embeds at most 50 unique participants, 50 flat agenda items, and 100 globally unique task links. The creator is inserted as a participant and cannot be removed. New meetings start in `draft`; transitions never return to draft. `closed` and `cancelled` rows accept only a status-only reopen to `open`, and agenda outcomes plus meeting minutes can change only while entering, occupying, or leaving `in-progress`.

Meeting creates and patches commit the canonical row and append-only activity in one DynamoDB transaction. Create callers may supply an 8-128 character `Idempotency-Key`; its workspace-, actor-, and operation-scoped SHA-256 claim becomes eligible for DynamoDB TTL cleanup after 24 hours. An exact retry strongly reads and returns the original result without another meeting or activity row, while reuse for different content returns 409. DynamoDB deletes expired TTL items asynchronously, so this replay/conflict behavior can remain beyond 24 hours until cleanup occurs. Raw caller keys are never persisted. The header remains optional for compatibility, so unkeyed retries do not receive this replay guarantee. Other resource mutations still need the shared transaction/idempotency envelope before the same guarantee can be claimed application-wide.

## Work Configuration v1

Each workspace has at most one `WORK_CONFIGURATION` record. The record is a full, versioned replacement containing active/inactive task types and statuses, default IDs, closed-state metadata, and the role allow-list for every permitted status transition. Reads are strongly consistent because task creation and status changes must validate against the same workspace policy administrators just updated.

For workspaces created before this record existed, a missing item resolves to the immutable code-defined configuration at version 1. The first customization submits version 1 and conditionally creates persisted version 2; later replacements condition on the stored version. Existing type and status IDs cannot be removed, so old task records remain readable; administrators deactivate an ID instead. Unchanged inactive legacy values remain valid on unrelated edits, while a changed type/status must target an active definition and a status change must be permitted for the caller's current workspace role.

The configuration record is additive and needs no backfill, GSI, or migration flag. Task rows retain their current project partition and workspace/assignee index attributes. Configuration updates emit the existing workspace activity record, and task create/update activity continues to use the existing append-only activity access path.

## Work Query v1 Cursor and Migration

Work Query v1 chooses one ordered access path per request: the project partition for `id-asc`, GSI2 assignment records for `due-asc`, or the GSI1 workspace work partition for `updated-desc`. The API applies the remaining validated filters while iterating a bounded number of DynamoDB query pages. Its opaque cursor binds the continuation key to the workspace, query version, filters, and sort so it cannot be reused for a different query.

Canonical task rows created or updated by Work Query v1 code receive the workspace-work `GSI1PK` and `GSI1SK` attributes. DynamoDB does not add those attributes to rows that already exist. Before deploying the cross-project `/planning` reader to an installation with existing tasks, run a controlled backfill that updates every `PROJECT#<projectId> / WORK#<workItemId>` row with:

- `GSI1PK = WORKSPACE#<workspaceId>#WORK`
- `GSI1SK = UPDATED#<updatedAt>#PROJECT#<projectId>#WORK#<workItemId>`

Project-scoped task reads remain compatible before the backfill because they query the base project partition. Updating an old task through the project-scoped patch route also adds its work-index attributes, but that incremental behavior is not a substitute for the deployment backfill. Until all old rows are backfilled, cross-project Work Query v1 results are incomplete by design; deployment validation must compare canonical task counts with indexed task counts before the route is considered ready.

Legacy projects associated with portfolios also require a one-time repair. Keep each canonical `PROJECT#<projectId> / META` row in `WORKSPACE#<workspaceId>#PROJECTS`, then write its `WORKSPACE#<workspaceId> / PROJECT_PORTFOLIO#<portfolioId>#PROJECT#<projectId>` projection into the portfolio GSI partition. New creates and patches maintain both records transactionally. Validate that every project appears once in the workspace query and every portfolio association has exactly one projection before enabling portfolio lists.

Use the bounded, resumable migration command one scan page at a time. It defaults to a dry run and emits a cursor bound to the exact table ARN. Review and apply the same page from the same starting cursor; only advance to the cursor emitted by a successful apply:

```bash
TABLE_NAME=exact-table-name npm run migrate:work-index -- --page-limit 25
TABLE_NAME=exact-table-name npm run migrate:work-index -- --apply --page-limit 25

# For every subsequent page, use the previous apply's nextCursor twice:
TABLE_NAME=exact-table-name npm run migrate:work-index -- --page-limit 25 --cursor <startingCursor>
TABLE_NAME=exact-table-name npm run migrate:work-index -- --apply --page-limit 25 --cursor <startingCursor>
```

Continue until `nextCursor` is absent, then run the full-table verifier from the beginning:

```bash
TABLE_NAME=exact-table-name npm run migrate:work-index -- --mark-ready
```

`--mark-ready` refuses to write the readiness marker unless it reaches the end of the table, reports zero `workRepairs`, `projectRepairs`, and `projectionRepairs`, and finds the same canonical and GSI work-row count for every workspace. GSI propagation is eventual, so a count mismatch immediately after the last repair should be retried later, not bypassed. First rehearse against a restored/non-production table. The script validates row identity, uses conditional updates for canonical rows, verifies portfolio projections, and uses a transaction for each project repair; a concurrent edit fails instead of being overwritten.

Production rollout is deliberately two-phase. Deploy this code first with `TEAMSPACES_WORK_INDEX_READY=false`; writes populate the new keys while cross-project planning retains the legacy reader. Run the backfill and `--mark-ready`, then set the protected deployment variable to `TEAMSPACES_WORK_INDEX_READY=true` and deploy again. The runtime requires both the configuration switch and the table marker, so a missing verification step cannot expose the incomplete GSI reader. Do not migrate before the dual-write release and do not enable the reader before verification, because either ordering can create or expose index holes.
