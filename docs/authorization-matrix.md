# Authorization Matrix

Server-side authorization resolves the selected account and membership from Cognito claims and DynamoDB. Browser-supplied account IDs are treated only as a selection request and are ignored unless the current user has active membership in that account. Browser-supplied roles are ignored.

| Permission | Admin | Portfolio manager | Project manager | Member | Viewer |
| --- | --- | --- | --- | --- | --- |
| Read workspace | yes | yes | yes | yes | yes |
| Manage workspace settings | yes | no | no | no | no |
| Create or update memberships | yes | no | no | no | no |
| Manage roles | yes | no | no | no | no |
| Manage portfolios | yes | yes | no | no | no |
| Create projects | yes | yes | yes | no | no |
| Update assigned projects | yes | yes | yes | no | no |
| Update assigned work | yes | yes | yes | yes | no |
| Record own time | yes | yes | yes | yes | no |
| Read reports | yes | yes | yes | yes | yes |
| Manage documents | yes | yes | yes | yes | no |
| Manage meetings | yes | yes | yes | yes | no |
| Save private views | yes | yes | yes | yes | yes |
| Manage wiki/news/forum content and planning resources | yes | yes | yes | yes | no |
| Read global search/notifications within project scope | yes | yes | yes | yes | yes |
| Manage capability design, custom roles, directories, webhooks, and scanners | yes | no | no | no | no |
| Link configured external records | yes | yes | yes | yes | no |
| Create/revoke external task shares | yes | yes | yes | no | no |
| Use configured read-only MCP tools | yes | yes | yes | yes | yes |
| Use configured mutating MCP tools | yes | yes | yes | yes | no |

When a membership has `projectIds`, read and mutation paths—including global search, MCP, integration links, repository snapshots, reports, notifications, content, meetings, and external sharing—are constrained to those projects inside the selected account. Empty `projectIds` means the role applies across the account. Custom roles contain only known server permissions. Activity is recorded for user-visible mutations, and external-share readers receive only externally visible comments.
