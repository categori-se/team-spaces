# Repository Model

Team Spaces uses a public-core/private-operator model. The public `team-spaces`
repository is the sole source of the product. A service operator may keep a
separate private `team-spaces-operator` repository for deployment configuration
and service operations, but it must consume the public core without copying or
forking it.

This boundary keeps the community edition complete, makes releases traceable,
and prevents production inventory from becoming part of the public source
history.

## Source-of-truth rule

All product behavior lands in the public repository first. This includes the
browser application, API, authorization rules, data model, migrations, generic
AWS infrastructure, local development tools, test fixtures, public-demo
behavior, documentation, and release-quality tests.

The private operator repository pins the public repository as a Git submodule,
normally at `core/team-spaces`. The submodule entry must name an exact public
commit SHA. Operator builds must not follow a branch, resolve a floating tag, or
copy a source snapshot into the private repository.

A hosted release therefore has two independently reviewable identities:

- the public core commit SHA; and
- the private operator commit SHA that pins and configures that core.

Release records and rollback instructions should retain both values.

## What belongs where

| Public `team-spaces` core | Private operator repository |
| --- | --- |
| Web application and API product code | Protected production environment configuration |
| Authorization, schemas, migrations, and data adapters | Account and resource inventory that an operator chooses not to publish |
| Generic, self-hostable AWS CDK and deployment tooling | Hosted release orchestration and environment-specific workflow wiring |
| Demo implementation, sample data, and safety limits | Provider bindings, secret references, and rotation records |
| Product documentation, OpenAPI, tests, and security guidance | Incident records, customer operational data, and internal support procedures |
| Export, import, backup, and upgrade interfaces | Billing, subscription, fleet-provisioning, and service-level control-plane code |
| Reusable fixes and improvements for any installation | The exact submodule pin plus operator-only policy and observability configuration |

Secrets do not belong in either Git repository. Product code must not be moved
into the private overlay merely because a hosted service uses it. If a private
operator change needs new application behavior or a reusable deployment
primitive, that prerequisite is implemented and reviewed in the public core
first.

## Clean initial publication

An existing private repository can contain useful but non-secret production
identifiers in old commits. Making that repository public or rewriting its
history is unnecessary and risky. The initial public repository is instead
created from a reviewed clean snapshot:

1. Audit the candidate tree and an explicit public-file allowlist.
2. Exclude private workflows, production inventories, operator records,
   generated credentials, build output, and the original `.git` directory.
3. Run secret, license, dependency, test, build, and infrastructure guardrails
   against the snapshot.
4. Initialize a new repository with a new root commit and publish it privately
   for a final review.
5. Scan the complete new history, then make that new repository public.

The original private history is preserved in the renamed operator repository;
it is neither published nor rewritten. After the one-time clean snapshot, the
public repository becomes the source of truth. Later core changes flow through
normal public commits rather than additional snapshots from private history.

The operator may keep an internal provenance record mapping the first public
commit to the private source commit used to prepare it. That record must not
contain secrets and does not make private history a product source.

## Contribution and release flow

Core changes follow this sequence:

1. Open a public issue or pull request against `team-spaces`.
2. Run the public validation and security gates and merge the reviewed change.
3. In `team-spaces-operator`, update the submodule to the exact reviewed public
   commit and review that one-line pin change with any operator configuration.
4. Verify that the pinned commit is reachable from the protected public main
   branch and that the operator repository contains no modified submodule
   working tree.
5. Build and deploy from an exact reviewed operator commit, recording both SHAs
   in immutable release metadata.
6. Promote, verify, or roll back the release using those recorded identities.

Operator-only changes may start in the private repository when they concern
environment configuration, fleet operations, billing, support, or another item
in the private column above. They must not introduce a private product fork. A
fix discovered while operating the service returns to the public core whenever
it changes reusable product behavior.

## License and notice handling

The public core is licensed under Apache-2.0. Source and binary distributions of
the core must preserve the repository's `LICENSE` and applicable `NOTICE`
material, retain applicable attribution notices, and mark modified files as
required by the license. The web distribution ships a copy of the Apache
license and generated software notices that begin with the project `NOTICE`
before the dependency inventory; release checks must fail if either artifact
is stale.

A private operator repository may use a separate license for its original
operator-only code. That separate license does not replace, narrow, or relabel
the Apache-2.0 terms of the pinned public submodule. Any distribution containing
the core must continue to satisfy the core and third-party notice obligations.

See [community core and managed operations](editions.md) for the product and
commercial boundary.
