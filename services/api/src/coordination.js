// @ts-nocheck

import {coordinationRoles, parseWorkQuery} from "@teamspaces/contracts";
import {hasPermission, permissions} from "./authorization/rbac.js";
import {ValidationError} from "./errors.js";

const projectLimit = 20;
const taskLimit = 100;

function initiativeKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new ValidationError("initiativeId must be a stable identifier");
  return value;
}

export function coordinationSummary(tasks, configuration) {
  const identity = (projectId, taskId) => JSON.stringify([projectId, taskId]);
  const accepted = new Set(tasks.filter(task => task.coordination?.acceptanceState === "accepted"
    && task.coordination.evidence?.length && configuration.statuses.some(status => status.id === task.status && status.closed)).map(task => identity(task.projectId, task.id)));
  const summary = {total: tasks.length, accepted: 0, running: 0, blocked: 0, review: 0, ready: 0, backlog: 0};
  for (const task of tasks) {
    if (accepted.has(identity(task.projectId, task.id))) summary.accepted += 1;
    else if (task.status === "blocked" || task.coordination?.decision || (task.blockedBy ?? []).some(id => !accepted.has(identity(task.projectId, id))) || (task.coordination?.dependencies ?? []).some(ref => !accepted.has(identity(ref.projectId, ref.taskId)))) summary.blocked += 1;
    else if (task.coordination?.acceptanceState === "review" || configuration.statuses.some(status => status.id === task.status && status.closed)) summary.review += 1;
    else if (task.status === "in-progress" || ["claimed", "preparing", "running"].includes(task.coordination?.run?.state)) summary.running += 1;
    else if (task.status === "ready") summary.ready += 1;
    else summary.backlog += 1;
  }
  return summary;
}

export async function coordinationDashboard(repository, context, requestedInitiativeId) {
  const initiativeId = requestedInitiativeId ? initiativeKey(requestedInitiativeId) : undefined;
  const candidates = await repository.listProjects({workspaceId: context.workspaceId, allowedProjectIds: context.membership?.projectIds, limit: projectLimit + 1});
  const projects = candidates.slice(0, projectLimit).filter(project => !project.archived && project.coordination && (!initiativeId || project.coordination.initiativeId === initiativeId));
  const pages = await Promise.all(projects.map(project => repository.listWorkItemsPage({
    ...parseWorkQuery(new URLSearchParams({limit: String(context.publicDemo ? 10 : taskLimit)}), {projectId: project.id, defaultSort: "id-asc"}),
    workspaceId: context.workspaceId,
    allowedProjectIds: context.membership?.projectIds
  })));
  const tasks = pages.flatMap(page => page.items).filter(task => task.coordination);
  const configuration = await repository.getWorkConfiguration(context);
  const registration = initiativeId ? await repository.getPublicCoordinationRegistration(initiativeId) : undefined;
  const dashboard = {
    schemaVersion: 1,
    initiativeId,
    title: initiativeId ? projects.find(project => project.coordination.facet === "internal")?.name ?? registration?.title ?? initiativeId : "Coordination",
    audience: "private",
    sample: false,
    roles: coordinationRoles,
    projects,
    tasks,
    summary: coordinationSummary(tasks, configuration),
    workConfiguration: configuration,
    ...(registration?.workspaceId === context.workspaceId && registration.parityBaseline ? {parityBaseline: registration.parityBaseline} : {}),
    canManage: !context.publicDemo && hasPermission(context.membership, permissions.workManage),
    canSetup: !context.publicDemo && hasPermission(context.membership, permissions.projectManage) && hasPermission(context.membership, permissions.workManage),
    truncated: candidates.length > projectLimit || pages.some(page => page.pageInfo?.hasNextPage)
  };
  return dashboard;
}
