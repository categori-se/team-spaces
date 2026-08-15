# Team Spaces

Team Spaces is an Apache-2.0 open-source project and work-management application for small teams. All implemented product capabilities—web application, API, authorization, projects, planning, meetings, documents, time, reports, activity, migrations, and AWS infrastructure—live in this repository; planned gaps remain visible on the public roadmap.

You can run the application locally or deploy it into an AWS account you control. A future managed Team Spaces service may sell provisioning, upgrades, monitoring, backups, support, and other operational conveniences, but it should run the same product core rather than a deliberately restricted community edition. See [editions and ownership](docs/editions.md) and the [public-core/private-operator repository model](docs/repository-model.md).

## Cost principle

The AWS architecture is designed to have **no paid idle compute and no provisioned database capacity**. Static assets use private S3 behind CloudFront; requests use API Gateway HTTP API and ARM Lambda; application data uses DynamoDB on-demand; identity uses Cognito; document bytes use private S3.

That principle does not mean an AWS bill is guaranteed to be zero. Requests, data stored, point-in-time recovery, object versions, logs, transfer, Cognito monthly active users, and optional operational features are billed according to their AWS pricing dimensions. Account-wide free allowances may already be consumed. Fixed-price services such as standalone WAF, NAT Gateway, provisioned compute, relational clusters, and search clusters are not part of the core deployment. Review [the cost model](docs/cost-model.md) before deploying.

## What is here

- A static Observable Framework application under `apps/web`.
- One modular JavaScript Lambda API under `services/api`.
- Shared contracts and domain behavior under `packages`.
- Workspace-aware server-side authorization and role checks.
- One on-demand DynamoDB application table with two sparse GSIs.
- Private document storage with short-lived presigned S3 URLs.
- AWS CDK infrastructure under `infra` with request and concurrency ceilings.
- A local in-memory adapter for development and tests.
- An optional isolated, bounded public demo for a shared showcase deployment.
- OpenAPI, architecture, access-pattern, security, cost, migration, and recovery documentation.

The implementation is incremental. Consult the [public roadmap](docs/roadmap.md) and [product scope](docs/product-scope.md) for what is implemented and what remains planned.

## Local development

Requirements:

- Node.js 24 or newer.
- npm.

Install dependencies and start the local API and web application:

```bash
npm install
npm run dev
```

The API listens on `http://localhost:8787`. Observable starts at `http://localhost:3000` and selects the next free port when necessary. Local development uses an in-memory repository: it is convenient for evaluation, but its data is not a production backup or persistent self-hosting profile.

Use `WEB_PORT=3001 npm run dev` to request a web port. Use `PORT=8788 WEB_PORT=3001 npm run dev` for an isolated API/web pair. For only the frontend, run `npm run dev:web`.

## Deploy to your AWS account

The community deployment creates an installation in the AWS account selected by your normal AWS credential chain. It requires a hostname and an issued ACM certificate in `us-east-1` for CloudFront:

```bash
TEAMSPACES_DOMAIN_NAME=team-spaces.example.com \
ACM_CERTIFICATE_ARN=arn:aws:acm:us-east-1:123456789012:certificate/example \
npm run infra:synth:aws

TEAMSPACES_DOMAIN_NAME=team-spaces.example.com \
ACM_CERTIFICATE_ARN=arn:aws:acm:us-east-1:123456789012:certificate/example \
npm run deploy:aws
```

`npm run deploy` is an alias for `npm run deploy:aws`. The generic command has no preselected AWS profile, domain, certificate, user pool, or bucket. Copy [`.env.example`](.env.example) as a configuration checklist; do not commit populated secrets.

After deployment, point the hostname at the `DistributionDomainName` stack output and create the first Cognito user. Self-sign-up is deliberately disabled, and the installer does not silently create a global administrator. The first authenticated user receives an administrator role only in their own new workspace. The complete procedure, migration gate, recovery model, upgrades, and retained-resource behavior are in the [AWS self-hosting guide](docs/self-hosting/aws.md).

## Record export and recovery boundaries

Export a versioned bundle of the DynamoDB application records:

```bash
TABLE_NAME=exact-table-name \
EXPORT_PATH=team-spaces-data.json \
npm run export:data
```

Validate the bundle first. Import writes only when `--apply` is supplied, and the default apply path refuses a non-empty target table:

```bash
IMPORT_PATH=team-spaces-data.json \
npm run import:data

TABLE_NAME=empty-target-table \
IMPORT_PATH=team-spaces-data.json \
npm run import:data -- --apply
```

These commands move DynamoDB records, not the table definition, Cognito identities, or document objects. A same-installation recovery can preserve the existing user pool and versioned attachment bucket. Moving into a new pool or bucket additionally requires user-id and S3-version reconciliation, which is not yet automated. See [AWS self-hosting](docs/self-hosting/aws.md#backup-export-and-restore) before treating a record bundle as a recovery plan.

## Validation

Run the release checks before proposing a change or deploying:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:infra
npm run build
npm run audit:licenses
npm run audit:vulns
npm run scan:secrets
```

## Documentation

- [Architecture](docs/architecture.md)
- [AWS self-hosting](docs/self-hosting/aws.md)
- [Community core and managed operations](docs/editions.md)
- [Public-core/private-operator repository model](docs/repository-model.md)
- [Roadmap](docs/roadmap.md)
- [Cost model](docs/cost-model.md)
- [DynamoDB access patterns and migrations](docs/access-patterns.md)
- [Authorization matrix](docs/authorization-matrix.md)
- [Threat model](docs/threat-model.md)
- [OpenAPI description](openapi.yaml)
- [Operations runbook](docs/operations-runbook.md)
- [Restore runbook](docs/restore-runbook.md)

## Hosted-operator boundary

A hosted service should keep production inventory, protected environment configuration, release orchestration, incident records, and service control-plane code in a separate private operator repository. That repository consumes this public product core as a Git submodule pinned to an exact reviewed commit; it does not maintain a private copy of the application.

Community operators should use `npm run deploy:aws`. Hosted operators may add environment-specific release controls around the same generic deployment, but those controls are not defaults or prerequisites for a community installation. See the [repository model](docs/repository-model.md) for the exact boundary and release flow.

## License

Team Spaces is licensed under the [Apache License 2.0](LICENSE). A byte-identical [web copy of the license](apps/web/src/LICENSE.txt), asset provenance from [NOTICE](NOTICE), and the generated [third-party software notices](apps/web/src/THIRD_PARTY_NOTICES.txt) ship with the web build. The package manifests remain marked `private` to prevent accidental npm publication; that does not restrict use of the source under the license.
