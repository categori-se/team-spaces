// @ts-nocheck

import {ContractValidationError} from "./index.js";

export const coordinationRoles = Object.freeze([
  {id: "coordinator", name: "Coordinator", responsibility: "Priorities, dependencies, decisions, and integration."},
  {id: "ui-ux", name: "UI / UX", responsibility: "Consistent interfaces and simpler user journeys."},
  {id: "workflow-review", name: "Workflow review", responsibility: "Reproduce issues and verify complete user workflows."},
  {id: "feature-delivery", name: "Feature delivery", responsibility: "Complete prioritized capabilities with acceptance evidence."},
  {id: "maintenance", name: "Maintenance", responsibility: "Bounded cleanup, dependencies, and documentation."}
]);

function object(value, fields, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContractValidationError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new ContractValidationError(`${name}.${key} is not supported`);
  return value;
}

function text(value, name, maximum = 2000) {
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new ContractValidationError(`${name} must be text of at most ${maximum} characters`);
  return value.trim();
}

function key(value, name) {
  const result = text(value, name, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) throw new ContractValidationError(`${name} must be a stable identifier`);
  return result;
}

function choice(value, choices, name) {
  if (!choices.includes(value)) throw new ContractValidationError(`${name} must be one of ${choices.join(", ")}`);
  return value;
}

function link(value, name) {
  const result = text(value, name, 2048);
  let url;
  try { url = new URL(result); } catch { throw new ContractValidationError(`${name} must be an HTTPS or local loopback URL`); }
  const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback || url.username || url.password) throw new ContractValidationError(`${name} must be an HTTPS or local loopback URL without credentials`);
  return url.href;
}

export function parseProjectCoordination(value) {
  if (value === undefined) return undefined;
  const input = object(value, ["initiativeId", "facet", "key", "repository", "githubProject"], "coordination");
  return {
    initiativeId: key(input.initiativeId, "coordination.initiativeId"),
    facet: choice(input.facet, ["community", "internal"], "coordination.facet"),
    ...(input.key === undefined ? {} : {key: key(input.key, "coordination.key")}),
    ...(input.githubProject === undefined ? {} : {githubProject: (() => {
      object(input.githubProject, ["url", "visibility"], "coordination.githubProject");
      return {url: link(input.githubProject.url, "coordination.githubProject.url"), visibility: choice(input.githubProject.visibility, ["public", "private"], "coordination.githubProject.visibility")};
    })()}),
    ...(input.repository === undefined ? {} : {repository: (() => {
      object(input.repository, ["url", "branch", "visibility"], "coordination.repository");
      return {url: link(input.repository.url, "coordination.repository.url"), branch: text(input.repository.branch ?? "main", "coordination.repository.branch", 200), visibility: choice(input.repository.visibility, ["public", "private"], "coordination.repository.visibility")};
    })()})
  };
}

export function parseTaskCoordination(value) {
  if (value === undefined) return undefined;
  const input = object(value, ["roleId", "sourceId", "taskKey", "scopePaths", "nextAction", "decision", "acceptanceState", "evidence", "run", "dependencies", "parityIds", "sourceRefs"], "coordination");
  const result = {
    roleId: choice(input.roleId, coordinationRoles.map(role => role.id), "coordination.roleId"),
    acceptanceState: choice(input.acceptanceState ?? "pending", ["pending", "review", "accepted"], "coordination.acceptanceState"),
    nextAction: text(input.nextAction ?? "", "coordination.nextAction"),
    decision: text(input.decision ?? "", "coordination.decision"),
    scopePaths: [],
    evidence: []
  };
  if (input.sourceId !== undefined || input.taskKey !== undefined) {
    result.sourceId = key(input.sourceId, "coordination.sourceId");
    result.taskKey = key(input.taskKey, "coordination.taskKey");
  }
  for (const field of ["parityIds", "sourceRefs"]) {
    if (input[field] === undefined) continue;
    if (!Array.isArray(input[field]) || input[field].length > 30) throw new ContractValidationError(`coordination.${field} must contain at most 30 references`);
    result[field] = [...new Set(input[field].map(value => field === "parityIds" ? key(value, `coordination.${field}`) : text(value, `coordination.${field}`, 500)))];
  }
  if (input.dependencies !== undefined) {
    if (!Array.isArray(input.dependencies) || input.dependencies.length > 30) throw new ContractValidationError("coordination.dependencies must contain at most 30 task references");
    result.dependencies = input.dependencies.map(reference => {
      object(reference, ["projectId", "taskId"], "coordination.dependencies");
      return {projectId: key(reference.projectId, "coordination.dependencies.projectId"), taskId: key(reference.taskId, "coordination.dependencies.taskId")};
    });
    if (new Set(result.dependencies.map(ref => `${ref.projectId}:${ref.taskId}`)).size !== result.dependencies.length) throw new ContractValidationError("coordination.dependencies must be unique");
  }
  if (input.scopePaths !== undefined) {
    if (!Array.isArray(input.scopePaths) || input.scopePaths.length > 30) throw new ContractValidationError("coordination.scopePaths must contain at most 30 paths");
    result.scopePaths = [...new Set(input.scopePaths.map(path => {
      const parsed = text(path, "coordination.scopePaths", 300);
      if (!parsed || parsed.startsWith("/") || parsed.includes("\\") || parsed.split("/").includes("..")) throw new ContractValidationError("coordination.scopePaths must be repository-relative paths");
      return parsed;
    }))];
  }
  if (input.evidence !== undefined) {
    if (!Array.isArray(input.evidence) || input.evidence.length > 20) throw new ContractValidationError("coordination.evidence must contain at most 20 links");
    result.evidence = input.evidence.map(item => {
      object(item, ["label", "url", "visibility"], "coordination.evidence");
      const label = text(item.label, "coordination.evidence.label", 160);
      if (!label) throw new ContractValidationError("coordination.evidence.label is required");
      return {label, url: link(item.url, "coordination.evidence.url"), visibility: choice(item.visibility ?? "private", ["private", "public"], "coordination.evidence.visibility")};
    });
  }
  if (input.run !== undefined) {
    const run = object(input.run, ["id", "state", "updatedAt", "sourceRevision", "url"], "coordination.run");
    const state = typeof run.state === "string" ? run.state.toLowerCase().replaceAll("_", "-") : run.state;
    result.run = {
      id: key(run.id, "coordination.run.id"),
      state: choice(state, ["planned", "queued", "claimed", "preparing", "running", "succeeded", "failed", "interrupted", "cancelled", "candidate-ready", "no-changes"], "coordination.run.state"),
      sourceRevision: text(run.sourceRevision ?? "", "coordination.run.sourceRevision", 160)
    };
    if (typeof run.updatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(run.updatedAt) || Number.isNaN(Date.parse(run.updatedAt))) throw new ContractValidationError("coordination.run.updatedAt must be an ISO timestamp");
    result.run.updatedAt = new Date(run.updatedAt).toISOString();
    if (run.url !== undefined) result.run.url = link(run.url, "coordination.run.url");
  }
  if (result.acceptanceState === "accepted" && !result.evidence.length) throw new ContractValidationError("Accepted tasks require acceptance evidence");
  return result;
}
