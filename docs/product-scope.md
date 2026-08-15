# Product Scope

Team Spaces is a portfolio-first project and work management application for users who may work across a private personal account plus one or more team or client accounts. Its functional target is a comprehensive project-management surface with an original Observable Framework user experience and a demand-priced AWS serverless architecture.

The product roadmap, acceptance criteria, and current implementation evidence live in this document, the [roadmap](roadmap.md), and the linked architecture and contract documents. A feature is not complete merely because a similarly named field or read-only visualization exists.

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

## Delivery sequencing

The target is delivered incrementally, but later phases are not out of scope:

1. **Correctness and scale foundation:** real cursor pagination, stable work queries, direct addressing, conditional/idempotent mutations, projections, and production adapter tests.
2. **Configurable work engine:** types, statuses, workflows, typed custom fields, relations, bulk operations, shared views, boards, exports, and baselines.
3. **Collaboration and awareness:** rich comments/mentions, notifications, reminders, meetings, wiki, news/forums, global search, and document revisions.
4. **Planning and financial control:** automatic scheduling, working calendars, Scrum, resource capacity, time editing, rates, costs, budgets, and configurable reporting.
5. **Administration and integrations:** groups/custom roles, tenant module settings, webhooks, imports, Git/file connectors, SSO/SCIM/LDAP, malware scanning, and enterprise add-ons.
6. **Separate surfaces:** BIM workflows and a mobile companion after the underlying APIs are stable and complete enough to support them.

Each phase must remain deployable and useful. Roadmap status changes only after UI, API, persistence, authorization, and proportionate automated evidence exist.

## Current implemented increments

Work Configuration v1 removes the fixed task taxonomy without adding an AWS service. Each workspace has one versioned DynamoDB record for task types, statuses, active/closed behavior, defaults, and role-aware transitions. Existing workspaces use a migration-free virtual default until an administrator customizes it. Task creation, edits, queries, boards, filters, badges, and bulk updates consume the same configuration; stale configuration writes and forbidden transitions fail explicitly.

Task list views also provide bounded current-page bulk editing for up to 25 work packages. Updates are sequential, project-scoped, and versioned, so the feature stays within the pilot API/Lambda guardrails and reports item-level conflicts without a batch service or queue.

Meetings v1 adds a project-scoped one-time-meeting workflow without adding AWS infrastructure. A meeting remains one bounded, aggregate-32-KiB DynamoDB record containing details, participants who must be active when added while historical participants remain removable, an ordered flat agenda, presenter and same-project task links, minutes, and outcomes. The lifecycle moves from draft to open and in progress, then locks when closed; optimistic versions prevent concurrent overwrites. Creates and patches commit activity atomically, and a keyed create can safely replay its original result until its TTL-cleaned claim is removed (eligible after 24 hours). Chronological pages use the existing sparse GSI. Recurring series, notifications, calendar delivery, templates, attachments, exports, and global participant views remain separate increments so they do not create an idle scheduler, queue, or email dependency before those behaviors exist.

The public demo presents these increments as a guided small-team story rather than a feature inventory. It starts with attention and assignments, moves into a compact editable board, and opens an in-progress meeting with agenda decisions, owners, minutes, and linked follow-up tasks. Settings shows fictional team workload, project-scoped access, editable status columns, and recent activity while clearly identifying private-only identity and security controls. Four document records include bounded fictional text previews; real upload, download, and document bytes remain disabled for anonymous visitors.
