# Security Policy

## Supported versions

Team Spaces is currently pre-1.0. Security fixes are made on `main` and, once
tagged releases begin, on the latest supported release when practical. Older
commits, forks, and modified deployments are not maintained by this project.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Email
[security@categori.se](mailto:security@categori.se) with:

- the affected component and revision;
- reproduction steps or a minimal proof of concept;
- the likely impact and required access;
- any known mitigations; and
- how you would like to be credited.

Do not include live credentials, personal data, or customer records. If secure
transfer is required, ask for a suitable channel in the initial message.

The maintainers aim to acknowledge a complete report within five business
days, but this is a community project and that target is not a service-level
agreement. We will coordinate validation, remediation, release timing, and
responsible disclosure with the reporter. The project does not currently
operate a paid bug-bounty program.

## Scope and deployment responsibility

Reports about Team Spaces source code and the project's published deployment
templates are in scope. Vulnerabilities in AWS, browsers, identity providers,
or other dependencies should also be reported to their maintainers when the
issue is not caused by Team Spaces configuration or integration code.

Operators remain responsible for their AWS account, identity configuration,
domain and certificate controls, backups, monitoring choices, dependency
updates, and protection of deployment secrets. Review the threat model and
authorization documentation before exposing a deployment to users.

The project scans the current source tree in CI for common credential formats. Maintainers should also run `npm run scan:secrets:history` before making a previously private repository public and enable the repository host's secret scanning. If a credential has ever been committed, remove it from active use first; rewriting Git history is not a substitute for revocation and rotation.
