# Agent Instructions

Work from `team.spaces/`, the git repository root.

## Non-Negotiables

- Treat the repository's product scope and feature-coverage documents as the requirements source.
- Use Observable Framework pages and reactive JavaScript for the frontend.
- Keep mutations inside explicit event handlers.
- Do not place private data in build-time loaders or static generated files.
- Keep CloudFront as the only public production entry point.
- Keep the web and attachment buckets private.
- Do not add prohibited AWS services listed in `docs/product-scope.md` and infra tests.
- Prefer task/time period/milestone/intake/workflow step language in UI, docs, API contracts, fixtures, and tests. Treat tasks as the smallest project unit that connects to notes, status, documents, assignees, time, dependencies, and activity. Do not add alternate branded planning terminology unless the user explicitly asks for an integration-specific import or export.

## Validation Loop

Before stopping, run the commands in `docs/implementation/validation-loop.md`. If a command fails, fix the failure or document the blocker in the pull request or issue that owns the work.

## AWS Context

Use the normal AWS credential chain for a community installation and confirm the target identity before any deployment. A hosted profile is an explicit operator path documented separately; do not assume an operator account, profile, domain, certificate, identity pool, or bucket when working on the reusable core.
