// @ts-nocheck

import {ConflictError, ForbiddenError, ValidationError} from "../errors.js";

function parityBaseline(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["pass", "partial", "exclusion", "reference"].includes(key))
    || ![value.pass, value.partial, value.exclusion].every(count => Number.isSafeInteger(count) && count >= 0)
    || value.pass + value.partial + value.exclusion > 1000
    || value.reference !== undefined && (typeof value.reference !== "string" || !value.reference.trim() || value.reference.length > 160 || /[\u0000-\u001f\u007f]/.test(value.reference))) throw new ValidationError("Provide bounded parity counts and an optional version reference");
  return {pass: value.pass, partial: value.partial, exclusion: value.exclusion, ...(value.reference === undefined ? {} : {reference: value.reference.trim()})};
}

export async function prepareCoordinationRegistration(repository, context, input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["initiativeId", "projectIds", "enabled", "version", "parityBaseline"].includes(key))
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.initiativeId ?? "") || !Number.isSafeInteger(input.version) || input.version < 0
    || typeof input.enabled !== "boolean" || !Array.isArray(input.projectIds) || !input.projectIds.length || input.projectIds.length > 10 || new Set(input.projectIds).size !== input.projectIds.length) throw new ValidationError("Provide the initiative, exact community projects, enabled state, and current registration version");
  const current = await repository.getPublicCoordinationRegistration(input.initiativeId);
  if (current && current.workspaceId !== context.workspaceId) throw new ForbiddenError("This public initiative belongs to another workspace");
  if ((current?.version ?? 0) !== input.version) throw new ConflictError();
  const projects = [];
  for (const projectId of input.projectIds) {
    if (typeof projectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(projectId)) throw new ValidationError("Invalid community project reference");
    const project = await repository.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    if (project.archived || project.coordination?.initiativeId !== input.initiativeId || project.coordination?.facet !== "community") throw new ValidationError("Only community projects in this initiative can be publicly readable");
    projects.push(project);
  }
  const baseline = input.parityBaseline === undefined ? current?.parityBaseline : parityBaseline(input.parityBaseline);
  return {initiativeId: input.initiativeId, workspaceId: context.workspaceId, projectIds: [...input.projectIds], enabled: input.enabled, title: projects.length === 1 ? projects[0].name : input.initiativeId, ...(baseline ? {parityBaseline: baseline} : {}), version: input.version + 1, updatedAt: repository.now()};
}
