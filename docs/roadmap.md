# Roadmap

Team Spaces is developed as a useful, deployable open-source product at every milestone. This roadmap communicates direction rather than dates or contractual commitments. A capability moves to “implemented” only when its user experience, API, persistence, authorization, migration behavior, and proportionate automated evidence are present.

## Now: public-project and self-hosting foundation

Status: in progress.

- Keep the generic AWS deployment independent of any maintainer account, domain, certificate, buckets, and Cognito pool.
- Preserve a separate, explicit hosted-operator deployment profile.
- Publish installation, configuration, first-user, upgrade, recovery, teardown, cost, and edition documentation.
- Add community governance, contribution, security-reporting, support, conduct, and brand-use policies.
- Provide versioned DynamoDB export/import with dry-run validation and empty-target safety.
- Keep the public demo optional and isolated from authenticated customer data.
- Add synthesis tests that reject accidental baseline dependencies on WAF, NAT Gateway, provisioned compute, relational/search clusters, or other paid idle capacity.
- Establish repeatable tagged releases and migration notes.

Exit criteria: a new operator can inspect, deploy, verify, back up, upgrade, and deliberately remove Team Spaces in their own AWS account without relying on private maintainer infrastructure or undocumented knowledge.

## Correctness and scale foundation

Status: in progress.

- Finish opaque cursor pagination and stable keyset ordering for every collection.
- Remove remaining cross-project fan-out and scan fallbacks from production request paths.
- Extend conditional, transactional, and idempotent mutation behavior across resources.
- Formalize versioned record schemas and forward-compatible migrations.
- Expand cross-workspace isolation, projection-integrity, retry, and production-adapter tests.
- Add tested import/export compatibility rules and attachment inventories.

Cost gate: use existing on-demand tables and sparse projections. A new index requires a documented access pattern, write-amplification estimate, throughput ceiling, and migration path.

## Configurable work management

Status: partially implemented.

- Complete configurable types, statuses, transitions, priorities, forms, and typed custom fields.
- Add task relations, hierarchy, comments, history, templates, reusable queries, and bulk operations.
- Improve boards, tables, calendars, milestones, baselines, exports, and saved views without making the default workflow dense.
- Add explicit archive/restore and lifecycle tools for projects and work.

Cost gate: ordinary planning remains synchronous and on demand. Background projections are introduced only for measured access patterns.

## Collaboration and awareness

Status: partially implemented.

- Expand meetings to recurring series, reusable agendas, invitations, reminders, exports, and calendar delivery.
- Add rich comments, mentions, notifications, digests, wiki/content pages, news, and global metadata search.
- Add document revisions and optional content processing while keeping bytes outside DynamoDB.
- Connect decisions and follow-up work consistently across meetings, tasks, documents, and activity.

Cost gate: notifications, reminders, document processing, imports, exports, and webhooks use bounded SQS/Lambda/Scheduler lanes. Email and malware scanning are opt-in and metered. No worker exists merely to stay warm.

## Planning and financial control

Status: early/partial.

- Add interactive scheduling, dependencies, working calendars, resource capacity, and versioned schedule proposals.
- Complete Scrum backlogs, iterations, roadmaps, and portfolio forecasting.
- Add editable time history, rates, labor/unit costs, budgets, and configurable reports.
- Preserve a focused small-team default while advanced controls remain discoverable on demand.

Cost gate: expensive report materialization or schedule calculation runs as bounded jobs with concurrency and retry ceilings. No always-on analytics database is a baseline dependency.

## Administration and integrations

Status: early/partial.

- Add groups, custom roles, workspace modules, retention controls, and a filterable audit surface.
- Add webhooks and documented importers for common project-management formats.
- Add generic OIDC/SAML administration, then SCIM/LDAP where demand justifies it.
- Add maintained source-control and file-provider connectors behind queue-backed boundaries.
- Provide operator-visible usage, limits, and recovery state without exposing provider credentials to tenants.

Cost gate: integrations are independently enabled, avoid unnecessary polling, and cannot starve interactive work. Dedicated networking or storage remains an explicit operator choice.

## Separate surfaces

Status: planned after the underlying APIs mature.

- Mobile companion experiences.
- BIM/model workflows and client-side viewing where practical.
- Optional real-time collaborative editing.

These surfaces must reuse the same core API and authorization model. Conversion compute, WebSocket traffic, and large-model storage require separate budgets and rollback paths.

## Not planned as baseline infrastructure

The default AWS deployment will not add permanent VMs or containers, NAT Gateway, provisioned Lambda concurrency, RDS/Aurora, OpenSearch, ECS, EKS, or a standalone paid WAF merely for architectural fashion. A future optional service must be justified by measured demand, independently configurable, bounded, documented in the cost model, and removable without disabling ordinary project work.

Likewise, a PostgreSQL/Docker portability profile is not the current canonical data model. It may be evaluated later if sustained non-AWS self-hosting demand justifies maintaining a second persistence adapter and migration system.
