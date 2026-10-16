# Public and private project coordination

Team Spaces manages multiple projects under its own platform identity. The landing
page links to `/projects`, a public directory containing only explicitly published
projects. Sign-in opens `/app/projects`, which lists the projects available to the
current member. `/app/coordination` combines accessible work; an optional
`initiativeId` query selects one connected program.

## Connected work

Projects share an initiative without sharing access. Each project records its
repository, branch, facet and optional GitHub Projects board. Community and
internal facets describe work; neither publishes records automatically. Tasks
retain stable source/task keys, acceptance criteria, role, priority, next action,
parity references and explicit dependency pairs. Cross-project dependencies must
stay in the same workspace and initiative and require access to their targets.

Five responsibilities organize work: coordination, UI/UX, workflow review,
feature delivery and maintenance. Roles identify responsibility. They do not
start agents or imply that work is running. Execution records and detailed agent
context remain private. Workers need separate branches and agreed file scopes;
the coordinator sequences overlapping edits and integration.

Task status and acceptance are separate. Acceptance requires a configured closed
status and evidence. A successful model run does not accept a task. A published
parity baseline may include pass, partial and exclusion counts plus a bounded
reference label; it does not complete roadmap tasks.

## Publication and access

A workspace administrator with access to the selected projects registers eligible
community projects with `PUT /api/v1/coordination/public-registration`. The request
includes `initiativeId`, exact project IDs, `enabled`, and the current registration
version. An existing registration belongs to its original workspace. Internal,
archived and unrelated projects are ineligible. Disabling registration revokes
publication. Every public read checks current project eligibility again.

Anonymous visitors use two read-only endpoints:

- `GET /api/v1/public/projects` lists published project metadata.
- `GET /api/v1/public/coordination/{initiativeId}` returns the selected roadmap.

These responses are bounded, use `Cache-Control: no-store`, and apply an explicit
field allowlist. Public writes are denied regardless of identity or demo headers.
The public page offers no task editing, delegation or private bootstrap controls.
Authenticated application routes retain the normal workspace and project grants.

Published titles, criteria, priorities, roles, next actions, decisions, parity IDs
and explicitly public evidence links are visible. Keep proprietary content in an
internal project. Public responses omit owner identities, comments, activity,
source paths, synchronization identities, agent runs, private links, private
project counts and hidden dependency references. Public dependencies resolve only
to other published tasks. The real project tracker is separate from the optional
disposable demonstration environment.

## GitHub Projects

A GitHub connector selects an exact repository and ProjectsV2 board, its expected
visibility and a credential reference. The provider reader checks board association
and caller project grants before fetching items. It reports bounded pagination and
filtered or redacted results. Draft items require explicit opt-in. Select the
planning field with `githubStatusField` when it differs from `Status`.

A private board can reference public issues from an explicit `sharedRepositories`
allowlist. Each foreign repository must be confirmed public. Other repositories
are filtered. The same public issue node may appear on public and private boards,
so common work retains one identity while proprietary issues stay private.

Credentials belong in operator-managed secret storage, outside project records
and browser bundles. The server resolves credential references. Integration links
retain issue and board identities without publishing private destinations.

Synchronization should use a finite preview, an expected plan hash, optimistic
versions and durable checkpoints. Preserve human edits, fence unknown mutation
outcomes, and require fresh approval after conflicts. Define bounded event or
schedule mechanics before enabling unattended writes. The product's provider
browser does not itself enable an autonomous GitHub write loop.

## Credential isolation in shared installations

Each hosted credential must include a nonempty `bindings` array prepared by the
operator with `integrationCredentialBinding(workspaceId, connector)`. A binding
fixes the server-owned workspace ID, connector ID and SHA-256 of the complete
reviewed connector configuration. Resolution rejects missing context, another
workspace, or changed provider destinations, repositories, boards or configuration
before making a provider request. Repositories overwrite any configured workspace
field with the authenticated request's workspace identity.

Changing a bound connector requires an operator to review and refresh its binding.
Bindings live beside the credential in secret storage and are removed before the
credential reaches a provider adapter. Resolver calls without connector context,
including attempts to reuse a provider credential for a directory binding, fail.
Unbound credentials remain supported for trusted single-workspace local setups;
shared hosted installations must use bound credentials.

## Local development

The local server supports a private program manifest and durable state directory:

```bash
TEAMSPACES_PROGRAM_MANIFEST=/absolute/private/path/program.json \
TEAMSPACES_LOCAL_STATE_DIR=/absolute/private/path/state \
PORT=8798 WEB_PORT=3018 APP_ORIGIN=http://127.0.0.1:3018 npm run dev
```

These files belong in private ignored storage. Enrollment creates ordinary project
and task records once. Restarts restore records and preserve edits rather than
replaying the manifest. Local owner-key sessions are restricted to loopback and do
not replace hosted Cognito authentication. Hosted enrollment requires an explicit
workspace owner and server-side authorization.
