# ADR 0004: Cognito With Server-Side RBAC

## Decision

Use Cognito hosted UI with authorization-code flow and PKCE for authentication, API Gateway JWT authorization at the edge of the API, and repeated membership/role checks in Lambda.

## Consequences

The static client never stores a client secret, never provides trusted role data, and must reauthenticate when tokens expire.
