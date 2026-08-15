# Community Core and Managed Operations

Team Spaces has one product core. The web application, API, data model, authorization, migrations, and supported self-host deployment belong in the open-source repository under Apache-2.0.

The edition principle is:

> Run the complete Team Spaces product yourself, or pay a service operator to run the same product for you.

A hosted offering should earn its value through reliable operation, security, convenience, scale, and support. It should not turn the community project into a trial by removing ordinary project-management capabilities.

## Open-source core

The community core includes, as each capability is implemented:

- The browser application and API.
- Workspaces, memberships, and role-based authorization.
- Portfolios, projects, tasks, configurable work types and workflows.
- Planning views, meetings, decisions, follow-up work, documents, time, reports, and activity history.
- Document metadata and private object-storage integration.
- Data migrations and versioned export/import tooling.
- Local development, test fixtures, API documentation, and demo seed data.
- The supported AWS CDK deployment and its cost/security guardrails.
- Security documentation, upgrade notes, backup/restore procedures, and release artifacts.

Basic authentication, RBAC, audit history, import/export, and document metadata are product fundamentals. They must not be withheld merely to manufacture a paid tier.

## Managed operations

A future Team Spaces managed service may charge for work the software operator performs around the core, including:

- Account and workspace provisioning.
- DNS, certificates, identity-provider setup, and secret rotation.
- Automated upgrades, migration orchestration, backup verification, and restore drills.
- Monitoring, incident response, uptime objectives, and service-level agreements.
- Email reputation and delivery operations.
- Capacity planning, abuse controls, regional placement, and dedicated isolation.
- Private networking and customer-specific infrastructure.
- Billing, metering, invoicing, support, onboarding, and migration services.
- Higher contractual limits or dedicated resources whose AWS usage the service pays.

If features such as SSO, SCIM, malware scanning, connectors, or regional residency are implemented in the product, their product code and self-host configuration should remain part of the community core. A managed service can charge to provision, monitor, support, and operate them.

## Repository boundary

The managed service should deploy an exact release of this repository. A separate private operator repository may coordinate subscriptions, fleet provisioning, metering, support, and provider credentials, but it must not fork the product into a different application. It pins the public core at an exact Git submodule commit so both the core and operator release identities remain reviewable.

The public AWS template is not a reduced hosted trial. Conversely, operator-specific account identifiers, production secrets, release buckets, incident records, and customer operational data are deployment configuration rather than reusable product source.

The complete file boundary, clean-publication procedure, and contribution and release flow are defined in the [repository model](repository-model.md).

## Cost and responsibility

In a self-hosted installation, the operator controls the AWS account and pays AWS directly. “No paid idle compute” does not eliminate request, transfer, retained-data, backup, log, identity, or explicitly enabled monitoring costs. The operator also owns DNS, identity administration, upgrades, backups, recovery, security response, and support for their users.

In a managed service, the service operator owns those responsibilities and can price them as a subscription or usage-based service. The commercial value is reduced operational ownership, not hidden product functionality.

## License and name

The repository uses the Apache License 2.0. Any future control-plane licensing decision should be made explicitly and should not retroactively blur the license of this core.

The software license governs code, not the right to imply endorsement or operate under the Team Spaces name and visual identity. See [the trademark policy](../TRADEMARKS.md) for fair descriptive use, forks, and hosted-service naming.

This document describes a product and ownership boundary, not a promise that a managed Team Spaces service or every listed operational option is currently available.
