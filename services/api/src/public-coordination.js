// @ts-check

import {isIP} from "node:net";
import {coordinationRoles} from "@teamspaces/contracts";
import {ForbiddenError, HttpError, NotFoundError, PayloadTooLargeError, ValidationError} from "./errors.js";

export const publicCoordinationPathPrefix = "/api/v1/public/coordination";
export const publicProjectsPath = "/api/v1/public/projects";
export const publicDirectoryInitiativeLimit = 10;
export const publicCoordinationProjectLimit = 10;
export const publicCoordinationTaskLimit = 500;
const responseLimit = 256 * 1024;
const stableId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** @param {string} initiativeId */
export function publicCoordinationRegistrationKey(initiativeId) {
  return {PK: `PUBLIC_COORDINATION#${initiativeId}`, SK: "REGISTRATION"};
}

/** @param {any} registration @param {string} [initiativeId] */
export function assertPublicCoordinationRegistration(registration, initiativeId = registration?.initiativeId) {
  if (!registration || registration.enabled !== true || !stableId.test(initiativeId ?? "")
    || registration.initiativeId !== initiativeId || typeof registration.workspaceId !== "string" || !stableId.test(registration.workspaceId)
    || !Number.isSafeInteger(registration.version) || registration.version < 1
    || !Array.isArray(registration.projectIds) || !registration.projectIds.length || registration.projectIds.length > publicCoordinationProjectLimit
    || registration.projectIds.some((/** @type {unknown} */ id) => typeof id !== "string" || !stableId.test(id))
    || new Set(registration.projectIds).size !== registration.projectIds.length) throw new NotFoundError("Public initiative not found");
  return registration;
}

/** @param {any} project @param {any} registration */
export function assertRegisteredCommunityProject(project, registration) {
  if (!project || project.deletedAt || project.archived || project.workspaceId !== registration.workspaceId
    || !registration.projectIds.includes(project.id) || project.coordination?.initiativeId !== registration.initiativeId
    || project.coordination?.facet !== "community") throw new NotFoundError("Public initiative not found");
  return project;
}

/** @param {unknown} value @param {string} [fallback] @param {number} [limit] */
function text(value, fallback = "", limit = 2000) {
  return typeof value === "string" ? value.slice(0, limit) : fallback;
}

/** Public links carry no credentials, signed queries, fragments or local hosts. @param {any} evidence */
function publicEvidenceLink(evidence) {
  if (!evidence || evidence.visibility !== "public" || typeof evidence.url !== "string"
    || evidence.url.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(evidence.url)) return undefined;
  try {
    const url = new URL(evidence.url);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port && url.port !== "443") return undefined;
    if (isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".") || !/^[a-z0-9.-]+$/.test(host)) return undefined;
    if (/(?:^|\.)(?:localhost|local|internal|intranet|lan|home|test|invalid|example|onion)$/.test(host)) return undefined;
    const path = decodeURIComponent(url.pathname);
    if (/[\\\u0000-\u001f\u007f]/.test(path) || /(?:^|\/)(?:home|Users|tmp|etc|proc|var|\.ssh|\.aws)(?:\/|$)/i.test(path)) return undefined;
    return {label: text(evidence.label, "Public evidence", 160), url: url.href, visibility: "public"};
  } catch {
    return undefined;
  }
}

/** Metadata-only discovery of explicitly published projects. @param {any} repository */
export async function publicProjectDirectory(repository) {
  const listing = await repository.listPublicCoordinationInitiatives();
  const projects = [];
  for (const initiativeId of listing.initiativeIds.slice(0, publicDirectoryInitiativeLimit)) {
    try {
      const registration = assertPublicCoordinationRegistration(await repository.getPublicCoordinationRegistration(initiativeId), initiativeId);
      const records = await repository.readPublicCoordinationProjects(registration);
      const current = assertPublicCoordinationRegistration(await repository.getPublicCoordinationRegistration(initiativeId), initiativeId);
      if (current.version !== registration.version || current.workspaceId !== registration.workspaceId || JSON.stringify(current.projectIds) !== JSON.stringify(registration.projectIds)) continue;
      for (const record of records) {
        assertRegisteredCommunityProject(record, current);
        projects.push({id: record.id, name: text(record.name, "Public project", 240), initiativeId});
      }
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
  }
  return {audience: "public", readOnly: true, projects, truncated: listing.truncated === true};
}

/** Construct a response from current canonical records, never a stored public copy. @param {any} state */
export function publicCoordinationProjection(state) {
  const registration = assertPublicCoordinationRegistration(state.registration);
  const projects = state.projects.map((/** @type {any} */ project) => assertRegisteredCommunityProject(project, registration));
  if (projects.length !== registration.projectIds.length || new Set(projects.map((/** @type {any} */ project) => project.id)).size !== projects.length) throw new NotFoundError("Public initiative not found");
  const projectIds = new Set(projects.map((/** @type {any} */ project) => project.id));
  const canonicalTasks = state.tasks.filter((/** @type {any} */ task) => task && !task.deletedAt && task.workspaceId === registration.workspaceId && projectIds.has(task.projectId));
  const byId = new Map(canonicalTasks.map((/** @type {any} */ task) => [task.id, task]));
  if (byId.size !== canonicalTasks.length) throw new NotFoundError("Public initiative not found");
  const closedStatusIds = new Set((state.workConfiguration?.statuses ?? []).filter((/** @type {any} */ status) => status.closed === true).map((/** @type {any} */ status) => status.id));
  const accepted = new Set(canonicalTasks.filter((/** @type {any} */ task) => task.coordination?.acceptanceState === "accepted" && closedStatusIds.has(task.status) && task.coordination.evidence?.length).map((/** @type {any} */ task) => task.id));
  const roleIds = new Set(coordinationRoles.map((/** @type {any} */ role) => role.id));
  const tasks = canonicalTasks.map((/** @type {any} */ task) => {
    const coordination = task.coordination ?? {};
    const dependencies = new Set((Array.isArray(task.blockedBy) ? task.blockedBy : []).filter((/** @type {any} */ id) => typeof id === "string" && byId.has(id)));
    for (const dependency of Array.isArray(coordination.dependencies) ? coordination.dependencies : []) {
      const target = byId.get(dependency?.taskId);
      if (target && target.projectId === dependency.projectId && projectIds.has(dependency.projectId)) dependencies.add(dependency.taskId);
    }
    const blockedBy = [...dependencies];
    const decision = text(coordination.decision);
    return {
      id: text(task.id, "", 128), projectId: text(task.projectId, "", 128), title: text(task.title, "Task", 240),
      status: text(task.status, "intake", 80), priority: text(task.priority, "medium", 80),
      blockedBy,
      blocked: task.status === "blocked" || Boolean(decision.trim()) || blockedBy.some((id) => !accepted.has(id)),
      acceptanceCriteria: text(task.acceptanceCriteria),
      coordination: {
        roleId: roleIds.has(coordination.roleId) ? coordination.roleId : "coordinator",
        nextAction: text(coordination.nextAction),
        ...(decision ? {decision} : {}),
        parityIds: (Array.isArray(coordination.parityIds) ? coordination.parityIds : []).filter((/** @type {unknown} */ id) => typeof id === "string" && stableId.test(id)).slice(0, 200),
        acceptanceState: accepted.has(task.id) ? "accepted" : coordination.acceptanceState === "review" || closedStatusIds.has(task.status) ? "review" : "pending",
        evidence: (Array.isArray(coordination.evidence) ? coordination.evidence : []).map(publicEvidenceLink).filter(Boolean)
      }
    };
  });
  const summary = {total: tasks.length, accepted: 0, running: 0, blocked: 0, review: 0, ready: 0, backlog: 0};
  for (const task of tasks) {
    if (task.coordination.acceptanceState === "accepted") summary.accepted += 1;
    else if (task.blocked) summary.blocked += 1;
    else if (task.coordination.acceptanceState === "review") summary.review += 1;
    else if (task.status === "in-progress") summary.running += 1;
    else if (task.status === "ready") summary.ready += 1;
    else summary.backlog += 1;
  }
  const baseline = registration.parityBaseline;
  const parityBaseline = baseline && [baseline.pass, baseline.partial, baseline.exclusion].every((count) => Number.isSafeInteger(count) && count >= 0)
    && baseline.pass + baseline.partial + baseline.exclusion <= 1000
    ? {pass: baseline.pass, partial: baseline.partial, exclusion: baseline.exclusion,
      ...(typeof baseline.reference === "string" && baseline.reference.length <= 160 && !/[\u0000-\u001f\u007f]/.test(baseline.reference) ? {reference: baseline.reference} : {})} : undefined;
  return {
    schemaVersion: 1, initiativeId: registration.initiativeId,
    title: text(registration.title, "Public project", 240),
    audience: "public", sample: false, readOnly: true, canManage: false, canSetup: false,
    roles: coordinationRoles.map((/** @type {any} */ role) => ({id: role.id, name: role.name, responsibility: role.responsibility})),
    projects: projects.map((/** @type {any} */ project) => {
      const repository = publicEvidenceLink({...project.coordination?.repository, label: "Source repository"});
      const githubProject = publicEvidenceLink({...project.coordination?.githubProject, label: "GitHub project"});
      return {id: project.id, name: text(project.name, "Community project", 240), coordination: {
        initiativeId: registration.initiativeId, facet: "community",
        ...(repository ? {repository: {url: repository.url, visibility: "public"}} : {}),
        ...(githubProject ? {githubProject: {url: githubProject.url, visibility: "public"}} : {})
      }};
    }),
    tasks, summary, truncated: false,
    ...(parityBaseline ? {parityBaseline} : {}),
    workConfiguration: {statuses: (state.workConfiguration?.statuses ?? []).map((/** @type {any} */ status) => ({id: text(status.id, "", 80), label: text(status.label, "", 160), closed: status.closed === true}))}
  };
}

/**
 * Independent read-only authority: no identity, bootstrap, account headers or
 * generic application router participates in an anonymous tracker request.
 * @param {{repository: any, originAllows: (headers: Record<string, string | undefined>) => boolean}} dependencies
 */
export function createPublicCoordinationHandler({repository, originAllows}) {
  return async (/** @type {any} */ event) => {
    const headers = {"content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff"};
    try {
      if (!originAllows(event.headers ?? {})) throw new ForbiddenError("Requests must use the supported application entry point");
      const method = event?.requestContext?.http?.method ?? event?.httpMethod ?? "GET";
      const path = event?.rawPath ?? event?.path ?? "";
      const match = path.match(/^\/api\/v1\/public\/coordination\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/);
      const directory = path === publicProjectsPath;
      if (method !== "GET" || (!match && !directory)) throw new ForbiddenError("Public coordination is read-only");
      if (event.body || event.rawQueryString) throw new ValidationError("Public tracker reads do not accept a body or query parameters");
      if (directory) return {statusCode: 200, headers, body: JSON.stringify({data: await publicProjectDirectory(repository)})};
      if (!match) throw new NotFoundError("Public initiative not found");
      const registration = assertPublicCoordinationRegistration(await repository.getPublicCoordinationRegistration(match[1]), match[1]);
      const state = await repository.readPublicCoordinationState(registration);
      const current = assertPublicCoordinationRegistration(await repository.getPublicCoordinationRegistration(match[1]), match[1]);
      if (JSON.stringify([current.version, current.workspaceId, current.projectIds, current.title, current.parityBaseline]) !== JSON.stringify([registration.version, registration.workspaceId, registration.projectIds, registration.title, registration.parityBaseline])) throw new NotFoundError("Public initiative not found");
      const body = JSON.stringify({data: publicCoordinationProjection({...state, registration})});
      if (Buffer.byteLength(body, "utf8") > responseLimit) throw new PayloadTooLargeError("Public tracker exceeds its response limit");
      return {statusCode: 200, headers, body};
    } catch (error) {
      const problem = error instanceof HttpError ? error : new HttpError(500, "Internal Server Error", "The public tracker could not be read");
      return {statusCode: problem.status, headers, body: JSON.stringify({type: "urn:team-spaces:problem:public-coordination", title: problem.title, status: problem.status, detail: problem.detail})};
    }
  };
}
