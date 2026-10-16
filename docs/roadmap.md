# Roadmap

Team Spaces is developed as a useful, deployable open-source product at every milestone. This roadmap communicates direction rather than dates or contractual commitments. A capability moves to “implemented” only when its user experience, API, persistence, authorization, migration behavior, and proportionate automated evidence are present.

## Current delivery roadmap — October 16

The local OpenProject 17.7.2 baseline records 39 implemented core outcomes.
Current-release parity and deployed acceptance are separate gates: the public
release still needs the reviewed matrix/evidence, and the upstream 17.8–17.9.2
delta remains open. The [parity matrix](openproject-parity.md) defines these bounds.

The **Team Spaces [community edition]** project tracks the complete public product
core in `categori-se/team-spaces`. Operators consume an exact public core pin and
manage deployment and service acceptance in their own private projects. Public
issue identities can appear on both boards without withholding product features.
The anonymous tracker is read-only. Current public work is also on the
[Team Spaces GitHub board](https://github.com/orgs/categori-se/projects/3).

| Delivery lane | Priority and responsible role | Work and exit evidence |
| --- | --- | --- |
| Public release baseline | Critical · Workflow review | Review and publish the existing 17.7.2 core candidate and matrix, with exact source/build/test evidence and unresolved gates stated. |
| Newer-version comparison | High · Coordinator | Map official 17.8–17.9.2 changes to existing outcomes before claiming newer-release parity. |
| Focused feature deltas | High/medium · Feature delivery and UI/UX | Complete the selected version-model, MCP, document-to-task and time-policy gaps after the comparison; review the other changed planning/export/admin journeys individually. |
| Daily workflow quality | High · UI/UX | Review project selection, tasks, planning, dependencies, meetings and time as one accessible journey; retain prioritized findings. |
| Connected project reliability | High · Maintenance | Validate existing-issue adoption, conflict handling, restart recovery and initiative isolation. Define bounded event/schedule mechanics before unattended sync is enabled. |
| Clean self-host acceptance | High · Workflow review | Build and verify the exact candidate with installation, first-user, ordinary work, recovery and upgrade evidence; live/cloud targets require their own execution scope. |
| Optional demo-origin isolation | Medium · Feature delivery | Reuse [existing issue #7](https://github.com/categori-se/team-spaces/issues/7); retain generic installation defaults and primary-origin sign-in. The real roadmap remains separate and read-only. |

Milestones follow priority and prerequisite evidence. A completed implementation baseline does
not close publication, independent installation, live-provider or operator rollout
tasks. BIM, native mobile and unsupported third-party adapters stay outside the
core claim and are not silently added to this delivery queue.

The maintained product surfaces and cost constraints below remain in force.

## Public-project and self-hosting foundation

Status: implemented; maintained continuously.

- Keep the generic AWS deployment independent of any maintainer account, domain, certificate, buckets, and Cognito pool.
- Preserve a separate, explicit hosted-operator deployment profile.
- Publish installation, configuration, first-user, upgrade, recovery, teardown, cost, and edition documentation.
- Add community governance, contribution, security-reporting, support, conduct, and brand-use policies.
- Provide versioned DynamoDB export/import with dry-run validation and empty-target safety.
- Keep the public demo optional and isolated from authenticated customer data.
- Add synthesis tests that reject accidental baseline dependencies on WAF, NAT Gateway, provisioned compute, relational/search clusters, or other paid idle capacity.
- Establish repeatable tagged releases and migration notes.

Exit criteria met: a new operator can inspect, deploy, verify, back up, upgrade, and deliberately remove Team Spaces in their own AWS account without relying on private maintainer infrastructure or undocumented knowledge.

## Correctness and scale foundation

Status: implemented; hardening continues.

- Preserve opaque cursor pagination and stable keyset ordering for high-volume collections.
- Keep production request paths on direct keys, bounded pages, and workspace projections.
- Extend transactional replay guarantees to lower-risk mutations where retries justify the extra writes.
- Maintain versioned contracts, export/import compatibility, isolation, projection-integrity, and adapter tests.

Cost gate: use existing on-demand tables and sparse projections. A new index requires a documented access pattern, write-amplification estimate, throughput ceiling, and migration path.

## Configurable work management

Status: broad implementation present; custom fields are generalized across the current source entity sections, while wider 17.7.2 behavioral revalidation continues.

- Maintain configurable types, statuses, transitions, priorities, forms, entity-aware typed/calculated fields, actions, relations, hierarchy, templates, reusable queries, and bounded bulk operations.
- Keep boards, tables, calendars, milestones, baselines, exports, saved views, archive/restore, and lifecycle controls coherent as the contract evolves.

Cost gate: ordinary planning remains synchronous and on demand. Background projections are introduced only for measured access patterns.

## Collaboration and awareness

Status: implemented; convergent collaborative editing, persistent actionable notifications, per-user/project preferences, and duplicate-safe scheduled daily/weekly gateway delivery are present, with hardening continuing.

- Maintain recurring meetings/templates/attendance/calendar/PDF, threaded rich activity, mentions/reminders, notifications/digests, wiki/news/forum content, deterministic collaborative transforms, autosave/live sync, revisions, and bounded global search.
- Preserve the connection among decisions, follow-up work, documents, meetings, and activity.

Cost gate: notification summaries use an independently enabled hourly EventBridge Scheduler target, a one-concurrency ARM worker, sparse due-hour subscriptions, five-recipient batches, and a retained DLQ. All other export, webhook, and scanner handoff paths remain bounded and request-driven.

## Planning and financial control

Status: broad implementation present; retained historical baseline ranges and an interactive weekly resource planner are implemented, with deeper 17.7.2 planning revalidation continuing.

- Maintain interactive scheduling, dependencies, work calendars, baselines, Scrum/backlog/sprints/burndown, resource capacity, editable time, rates, costs, budgets, and configurable reports.
- Preserve a focused small-team default while advanced controls remain discoverable on demand.

Cost gate: current report and schedule calculations are synchronously bounded at the documented operating envelope. Larger installations may move the same contracts to capped jobs; no always-on analytics database is a baseline dependency.

## Administration and integrations

Status: implemented for the audited core. Provider-authenticated maintained integrations, direct LDAPS authentication/querying, scheduled LDAP reconciliation, SCIM Users/Groups, and product-managed antivirus dispatch/callback gating are present.

- Maintain groups/departments/custom roles, modules, audit, automatic webhooks, Jira import, repository/file/development connectors, OIDC/SAML deployment configuration, LDAP/SCIM, MCP, external sharing, outbound-link controls, and scanner callbacks.
- Maintain the GitHub, GitLab, Nextcloud/openDesk, Microsoft Graph, and XWiki adapters with external credential references, project authorization, bounded execution, verified/replay-protected callbacks, and failure isolation.

Cost gate: integrations are independently enabled, avoid unnecessary polling, and cannot starve interactive work. Dedicated networking or storage remains an explicit operator choice.

## Separate surfaces

Status: separately tracked and not required for the core parity claim.

- Native mobile binaries and BIM/model workflows.
- An optional WebSocket or offline-first CRDT transport if measured collaboration latency or offline demand justifies it; the baseline operational-transform editor remains convergent.

These surfaces must reuse the same core API and authorization model. Conversion compute, WebSocket traffic, and large-model storage require separate budgets and rollback paths.

## Not planned as baseline infrastructure

The default AWS deployment will not add permanent VMs or containers, NAT Gateway, provisioned Lambda concurrency, RDS/Aurora, OpenSearch, ECS, EKS, or a standalone paid WAF merely for architectural fashion. A future optional service must be justified by measured demand, independently configurable, bounded, documented in the cost model, and removable without disabling ordinary project work.

Likewise, a PostgreSQL/Docker portability profile is not the current canonical data model. It may be evaluated later if sustained non-AWS self-hosting demand justifies maintaining a second persistence adapter and migration system.
