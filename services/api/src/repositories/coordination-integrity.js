// @ts-nocheck

import {createHash} from "node:crypto";
import {ConflictError, ValidationError} from "../errors.js";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}

export function coordinationDigest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function coordinationProjectId(workspaceId, input) {
  const coordination = input.coordination;
  return coordination?.key ? `coord-${coordinationDigest([workspaceId, coordination.initiativeId, coordination.facet, coordination.key]).slice(0, 32)}` : undefined;
}

export function coordinationTaskId(workspaceId, projectId, input) {
  const coordination = input.coordination;
  return coordination?.sourceId && coordination?.taskKey ? `task-${coordinationDigest([workspaceId, projectId, coordination.sourceId, coordination.taskKey]).slice(0, 32)}` : undefined;
}

export function replayCoordinationCreate(existing, digest) {
  if (existing.deletedAt || existing.coordinationCreateDigest !== digest) throw new ConflictError("The coordination key already exists with different creation content; refresh and update its current version");
  return existing;
}

export function assertCoordinationUpdate(existing, input, configuration) {
  const next = {...existing, ...input};
  if (existing.id && input.coordination?.sourceId && !existing.coordination?.sourceId) throw new ConflictError("Synchronization keys must be selected when creating a task");
  if (existing.coordination?.sourceId && input.coordination && (existing.coordination.sourceId !== input.coordination.sourceId || existing.coordination.taskKey !== input.coordination.taskKey)) throw new ConflictError("A task's synchronization source and key cannot change");
  if (next.coordination?.acceptanceState === "accepted") {
    const closed = configuration.statuses.some(status => status.id === next.status && status.closed);
    if (!closed || !next.coordination.evidence?.length) throw new ValidationError("Accepted tasks must have a closed status and acceptance evidence");
  }
}

export function assertCoordinationProjectUpdate(existing, patch) {
  if (!patch.coordination) return;
  const identity = value => [value?.initiativeId, value?.facet, value?.key];
  if (patch.coordination.key && !existing.coordination?.key || existing.coordination?.key && coordinationDigest(identity(existing.coordination)) !== coordinationDigest(identity(patch.coordination))) throw new ConflictError("A keyed coordination project retains its initiative, facet, and key");
}

export async function assertCoordinationReferences(repository, context, projectId, input, existing = {}) {
  const next = input.coordination;
  if (!next?.dependencies?.length || coordinationDigest(next.dependencies) === coordinationDigest(existing.coordination?.dependencies ?? [])) return;
  const project = await repository.getProject(projectId, context.workspaceId, context.membership?.projectIds);
  if (!project.coordination?.initiativeId) throw new ValidationError("Cross-project task dependencies require a coordination initiative");
  for (const reference of next.dependencies) {
    if (existing.id === reference.taskId && projectId === reference.projectId) throw new ValidationError("A task cannot depend on itself");
    const dependencyProject = await repository.getProject(reference.projectId, context.workspaceId, context.membership?.projectIds);
    if (dependencyProject.coordination?.initiativeId !== project.coordination.initiativeId) throw new ValidationError("Connected tasks must belong to the same initiative");
    await repository.getCoordinationTask(context, reference.projectId, reference.taskId);
  }
}

export function resetCopiedCoordination(item) {
  delete item.coordinationCreateDigest;
  if (item.coordination) {
    const {sourceId, taskKey, run, ...coordination} = item.coordination;
    item.coordination = {...coordination, acceptanceState: "pending", evidence: []};
  }
  return item;
}
