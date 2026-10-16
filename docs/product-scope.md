# Product Scope

Team Spaces is a portfolio-first project and work management application for users who may work across a private personal account plus one or more team or client accounts. Its functional target is a comprehensive project-management surface with an original Observable Framework user experience and a demand-priced AWS serverless architecture.

The product roadmap, acceptance criteria, and current implementation evidence live in this document, the [roadmap](roadmap.md), and the audited [OpenProject parity matrix](openproject-parity.md). A feature is not complete merely because a similarly named field or read-only visualization exists.

## Scale and ownership target

The initial operating envelope is about 50 monthly active users, 500 active projects, and 50,000 tasks per installation, without hard-coding those as product limits. Request paths must use bounded pages, direct keys, or maintained projections; they must not scan the table or fan out once per project. Capacity can grow beyond that envelope by raising explicit cost and throughput limits rather than changing the product model.

The baseline deployment should have no permanent VM, container, database, NAT gateway, or search cluster. Optional capability services must be request-, schedule-, storage-, or connection-priced and independently enabled. See [cost-model.md](cost-model.md).

## Functional target

The functional target includes:

- Projects, subprojects, portfolios/programs, templates, lifecycle, configurable modules, dashboards, and membership.
- A configurable work-item engine with types, fields, forms, workflows, relations, comments, queries, bulk operations, exports, and history.
- Interactive Gantt scheduling, working calendars, baselines, roadmaps, calendars, agile boards, Scrum backlogs, sprints, and resource planning.
- Time, progress, rates, unit/labor costs, budgets, capacity, and configurable reports.
- Meetings, wiki, documents, collaborative content, forums, news, notifications, reminders, and global search.
- Users, groups, organization data, custom roles/permissions, custom fields, tenant administration, API, webhooks, migration, and documented security controls.
- Advanced administration and maintained GitHub, GitLab, Nextcloud, OneDrive, and SharePoint integrations.
- Separately tracked BIM and mobile companion surfaces.

Commercial support, hosted-service billing, installation assistance, training, and service-level commitments are operational offerings rather than application features.

## Capability layers

The target is organized into six independently testable layers. The first five satisfy the audited OpenProject 17.7.2 core criteria; their names still do not waive row-level acceptance evidence:

1. **Correctness and scale foundation:** cursor/keyset pages, stable work queries, direct keys, conditional/idempotent mutations, workspace projections, production-adapter tests, and versioned export/import.
2. **Configurable work engine:** types, statuses, priorities, forms, typed fields, actions, relations, bulk operations, reusable views, action boards, exports, calendars, schedules, sprints, and baselines.
3. **Collaboration and awareness:** threaded rich activity, mentions/reminders, notification/digest rules, recurring meetings, wiki/news/forum content, operation-based document collaboration, revisions, and global/attachment-content search.
4. **Planning and financial control:** automatic scheduling, work calendars, Scrum/burndown, capacity/skills/time off, editable exact time, rates, unit/labor costs, budgets, and reusable report definitions.
5. **Administration and integrations:** groups/departments/custom roles, lifecycle initiation/gates, branding, webhooks, Jira import, Git/SVN browsing, file/development/collaboration connectors, external sharing, OIDC/SAML deployment configuration, LDAP/SCIM, MCP, and malware-scanner callbacks.
6. **Separate surfaces:** BIM and native mobile remain deliberately tagged outside core parity; unsupported third-party connectors enter scope only through an explicit promotion.

The [parity matrix](openproject-parity.md) records acceptance evidence row by row. A regression or upstream functional addition must downgrade or extend that matrix rather than relying on this summary.

## Current implementation boundaries

Team Spaces implements the audited functional-parity core through a serverless-native model. Capability records are versioned workspace configuration, project/task/meeting/content mutations use optimistic versions and project authorization, and scale-sensitive cross-project reads use maintained workspace projections instead of per-project fan-out. Advanced calculations remain bounded synchronous operations at the target envelope; optional email gateways, scanners, and external provider credentials are deployment integrations rather than baseline always-on services.

Collaborative content uses an immutable revision log, operation endpoint, presence leases, and optimistic conflict detection. It is not a CRDT and does not claim offline multi-master merging. Global search is a bounded projection search suitable for the documented envelope; an external search cluster remains optional if measured installation size requires deeper indexing.

The public demo remains a deliberately narrower product boundary. It allows the reviewed core project/task/meeting/time/comment surfaces and safe new read-only pages, hides private integration/content mutations, uses fictional bounded previews, has no document-bucket access, and resets through isolated alternating DynamoDB slots.
