# Contributing to Team Spaces

Thank you for helping improve Team Spaces. Contributions of code,
documentation, tests, design feedback, and issue reports are welcome.

## Before you start

- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- Search existing issues before opening a new one.
- Open an issue before a large feature or architectural change so its scope,
  data model, security boundary, and AWS cost behavior can be discussed.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Development workflow

Team Spaces requires Node.js 24. AWS credentials are not needed for local
development or the normal validation loop.

```bash
npm ci
npm run dev
```

Create a focused branch, make the smallest coherent change, and run the checks
that apply. Before requesting review, run the complete project gate:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test
npm run test:integration
npm run test:infra
npm run audit:licenses
npm run audit:vulns
npm run scan:secrets
git diff --check
```

Maintainers preparing a repository for public release should additionally run `npm run scan:secrets:history`. That bounded local check supplements, but does not replace, the repository host's secret scanning and credential-revocation procedures.

Do not commit credentials, customer data, production exports, generated build
directories, or retained CDK synthesis output.

## Design expectations

- Keep the core useful and self-hostable without a proprietary service.
- Prefer modular application code over new independently deployed services.
- Preserve workspace authorization and bounded query behavior.
- Keep the default AWS path free of always-on compute. Identify request,
  storage, scheduled, and fixed-price cost effects in the pull request.
- Add infrastructure only with explicit limits, failure isolation, and an
  updated cost model.
- Include tests and update documentation when behavior, APIs, operations, or
  user-visible workflows change.
- Keep fixtures fictional and safe to publish.

## Pull requests

Explain the problem, the chosen approach, validation performed, compatibility
or migration effects, and AWS cost impact. Reviewers may ask for a smaller
change when unrelated concerns are mixed together.

The project uses Git history for attribution. By submitting a contribution,
you confirm that you have the right to submit it and agree that it is provided
under the repository's [Apache License 2.0](LICENSE), in accordance with
Section 5 of that license. No contributor license agreement is currently
required.
