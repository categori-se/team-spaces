// @ts-check

import {createDynamoRepositoryFromEnv} from "../repositories/dynamo.js";

/**
 * Hourly reconciliation for explicitly configured managed provider resources.
 * Provider operations are idempotent; a failed run is retried by Scheduler.
 * @param {any} repository
 * @param {string} workspaceId
 */
export async function synchronizeManagedIntegrations(repository, workspaceId) {
  const workspace = await repository.getWorkspace({workspaceId});
  const context = {workspaceId, workspace, actorId: "integration-sync-service", user: {id: "integration-sync-service", email: "integration-sync@service.invalid", name: "Managed integration synchronization service"}, membership: {role: "workspace-admin", status: "active"}, correlationId: crypto.randomUUID()};
  const capabilities = await repository.getWorkspaceCapabilities(context);
  const jobs = (capabilities.connectors ?? []).filter((/** @type {any} */ connector) => connector.enabled !== false && connector.managedPermissions === true)
    .flatMap((/** @type {any} */ connector) => (connector.managedResources ?? []).map((/** @type {any} */ resource) => ({connectorId: connector.id, ...resource})))
    .slice(0, 50);
  const results = [];
  for (const job of jobs) {
    results.push({connectorId: job.connectorId, projectId: job.projectId, resourceId: job.resourceId, result: await repository.synchronizeIntegrationPermissions(context, job.connectorId, {projectId: job.projectId, resourceId: job.resourceId})});
  }
  return {workspaceId, synchronizedCount: results.length, results};
}

export async function handler() {
  const workspaceId = process.env.INTEGRATION_SYNC_WORKSPACE_ID;
  if (!workspaceId) throw new Error("INTEGRATION_SYNC_WORKSPACE_ID is required");
  return synchronizeManagedIntegrations(createDynamoRepositoryFromEnv(), workspaceId);
}
