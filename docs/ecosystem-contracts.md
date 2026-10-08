# Team Spaces ecosystem contracts

Team Spaces remains a standalone Apache-2.0 application with its own workspace,
project, work-item, API, authorization and deployment behavior. Its existing
contracts package now re-exports the provider-neutral Workspace Contracts
0.1.0-alpha.9 source through `@categori/workspace-contracts`.

The exact source release is
[app-workspace-contracts v0.1.0-alpha.9](https://github.com/categori-se/app-workspace-contracts/tree/b2dd6f02d5588dd0f4a603901150e23ca29857d4).
The adopted package retains its Apache-2.0 LICENSE and NOTICE. Its runtime,
schemas, tests, package and license files match that immutable public export.
The source-owned package README retains historical development notes; current
source licensing and release status are recorded here. `private: true` prevents
npm registry publication; it does not make this GitHub source private.

The package shares identities and portable definitions for User, Workspace,
Project, Collection, notebook ownership and qualified references. A workspace is
a security boundary; an agency/client association is business context. Matching
names or email addresses do not join users or authorize cross-app access.
Collection ownership, organizational context, audience intent and target access
remain separate. A shared validator or owner field does not replace Team Spaces'
current API authorization or upstream permissions.

This source increment publishes the previously implemented package binding and
its existing regression check. It copies no unrelated application features,
private operator source, credentials, agent history or customer data, and changes
no existing dependency version. It performs no AWS deployment, native identity
activation, ownership migration or permission change.

Priority release considerations remain native provider/session and revocation
acceptance, exact runtime deployment evidence, and independently reviewed
cross-app mappings or sharing. The SDK source and its tests establish portable
contract behavior; they do not establish those production behaviors. Hosted
operations and commercial control-plane code retain their separate private
repository boundary.
