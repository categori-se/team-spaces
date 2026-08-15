# ADR 0003: On-Demand DynamoDB as the Canonical Store

Status: accepted

## Context

Team Spaces has strongly related product concepts, but the supported AWS deployment is intentionally serverless and demand-priced. A baseline PostgreSQL cluster, container service, NAT gateway, or connection proxy would add an operational and billing floor before a team performs any work. Maintaining both relational and DynamoDB schemas would also split the open-source product into two persistence implementations before demand justifies that cost.

## Decision

Use one on-demand DynamoDB application table with no more than two GSIs as the canonical store. Every tenant-owned key or projection includes the workspace or project boundary required by its access pattern. Application authorization remains authoritative, with negative cross-workspace tests and exact project-partition reads protecting tenant isolation.

Store document bytes in private S3 and only their metadata and scoped object keys in DynamoDB. Keep the repository interface modular so another adapter can be evaluated later without changing product contracts.

The community AWS profile uses pay-per-request capacity and explicit maximum-throughput ceilings. PITR is a separately enabled durability choice because it is billed by protected bytes while idle.

## Consequences

- Access patterns must be documented before schema changes.
- The API transactionally maintains bounded projections for workspace, project, assignment, due-date, meeting, and activity queries rather than relying on request-time scans.
- Relations are validated in application transactions and repository invariants rather than foreign keys.
- Export and import preserve raw DynamoDB AttributeValue records so self-hosted operators have a versioned portability path.
- A PostgreSQL adapter remains possible if non-AWS portability or measured relational workloads justify its schema, migration, RLS, backup, and operating costs. It is not a baseline dependency.
