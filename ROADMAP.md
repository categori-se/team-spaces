# Roadmap

Team Spaces is pre-1.0. This roadmap describes direction rather than promised
dates or service commitments. Priorities are refined through public issues and
working software.

## Product and architecture principles

- The open-source core should remain a useful project-management application,
  not a limited trial.
- The application begins as a modular monolith with explicit feature and data
  boundaries.
- The default AWS core should have no always-on compute and no optional
  fixed-price service floor. Charges should follow requests, retained data, or
  explicitly enabled schedules and operations.
- “Zero latent cost” is an architecture goal, not a zero-bill guarantee. AWS
  pricing, minimums, shared free allowances, stored data, backups, domains, and
  operator-selected monitoring can still create charges.
- Expensive integrations and operational controls should be independently
  enabled and documented.

## Near term: publishable self-hosting foundation

- Provide a generic AWS deployment that creates installation-owned identity,
  storage, API, and web resources without project-operator identifiers.
- Separate core, production, and public-demo deployment profiles.
- Make monitoring, retained backups, public demo, and custom domains explicit
  choices with cost consequences.
- Complete a versioned data export, import, backup, and restore workflow.
- Finish public documentation, release hygiene, dependency review, and security
  reporting.

## Next: modular core

- Organize API, contracts, persistence, and UI code around identity,
  workspaces, projects, work, meetings, documents, time, reports, and activity.
- Separate reusable demo seed data from test-only fixtures.
- Stabilize API and export schemas, bounded queries, migrations, and extension
  points.
- Improve accessibility, responsive behavior, and progressive disclosure for
  small teams.

## Later: collaboration and optional operations

- Deepen meeting, document, notification, audit, import, and export workflows.
- Add event-driven workers only for implemented asynchronous capabilities.
- Offer opt-in email, file scanning, webhooks, integrations, and richer search
  with explicit limits and cost models.
- Advance toward a stable 1.0 release after upgrade, restore, authorization,
  and public API guarantees are demonstrated.
