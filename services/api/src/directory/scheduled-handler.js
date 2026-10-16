// @ts-check

import {createLdapDirectoryRuntime} from "./ldap.js";
import {environmentCredentialResolver} from "../integrations/provider-adapters.js";
import {createDynamoRepositoryFromEnv} from "../repositories/dynamo.js";

export async function handler() {
  const workspaceId = process.env.LDAP_WORKSPACE_ID;
  if (!workspaceId) throw new Error("LDAP_WORKSPACE_ID is required");
  const repository = createDynamoRepositoryFromEnv();
  const workspace = await repository.getWorkspace({workspaceId});
  const context = {workspaceId, workspace, actorId: "ldap-sync-service", user: {id: "ldap-sync-service", email: "ldap-sync@service.invalid", name: "LDAP synchronization service"}, membership: {role: "workspace-admin", status: "active"}, correlationId: crypto.randomUUID()};
  const ldapRuntime = createLdapDirectoryRuntime({resolveCredential: environmentCredentialResolver()});
  return repository.synchronizeLdapDirectory(context, ldapRuntime);
}
