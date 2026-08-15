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

When a membership has `projectIds`, read and mutation paths are constrained to those projects inside the selected account. Empty `projectIds` means the role applies across the account. Activity is recorded for user-visible mutations.
