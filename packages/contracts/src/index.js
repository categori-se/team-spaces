// @ts-check

import {parseProjectCoordination, parseTaskCoordination} from "./coordination.js";
export {coordinationRoles, parseProjectCoordination, parseTaskCoordination} from "./coordination.js";

export * from "./workspace-contracts.js";

export const appName = "Team Spaces";

export class ContractValidationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ContractValidationError";
  }
}

export const roles = Object.freeze({
  admin: "workspace-admin",
  portfolioManager: "portfolio-manager",
  projectManager: "project-manager",
  member: "member",
  viewer: "viewer"
});

export const accountTypes = Object.freeze([
  "personal",
  "team",
  "client"
]);

export const roleLabels = Object.freeze({
  [roles.admin]: "Workspace administrator",
  [roles.portfolioManager]: "Portfolio manager",
  [roles.projectManager]: "Project manager",
  [roles.member]: "Member",
  [roles.viewer]: "Viewer"
});

export const permissions = Object.freeze({
  workspaceRead: "workspace:read",
  workspaceManage: "workspace:manage",
  portfolioManage: "portfolio:manage",
  projectCreate: "project:create",
  projectManage: "project:manage",
  workManage: "work:manage",
  meetingManage: "meeting:manage",
  timeManageOwn: "time:manage:own",
  reportRead: "report:read",
  attachmentManage: "attachment:manage",
  savedViewManage: "saved-view:manage"
});

export const rolePermissions = Object.freeze({
  [roles.admin]: Object.values(permissions),
  [roles.portfolioManager]: [
    permissions.workspaceRead,
    permissions.portfolioManage,
    permissions.projectCreate,
    permissions.projectManage,
    permissions.workManage,
    permissions.meetingManage,
    permissions.timeManageOwn,
    permissions.reportRead,
    permissions.attachmentManage,
    permissions.savedViewManage
  ],
  [roles.projectManager]: [
    permissions.workspaceRead,
    permissions.projectCreate,
    permissions.projectManage,
    permissions.workManage,
    permissions.meetingManage,
    permissions.timeManageOwn,
    permissions.reportRead,
    permissions.attachmentManage,
    permissions.savedViewManage
  ],
  [roles.member]: [
    permissions.workspaceRead,
    permissions.workManage,
    permissions.meetingManage,
    permissions.timeManageOwn,
    permissions.reportRead,
    permissions.attachmentManage,
    permissions.savedViewManage
  ],
  [roles.viewer]: [
    permissions.workspaceRead,
    permissions.reportRead,
    permissions.savedViewManage
  ]
});

export const projectStatuses = Object.freeze([
  "proposed",
  "active",
  "paused",
  "complete",
  "archived"
]);

export const healthStates = Object.freeze([
  "on-track",
  "watch",
  "at-risk",
  "blocked"
]);

export const priorities = Object.freeze(["low", "medium", "high", "critical"]);

export const projectModules = Object.freeze([
  "work",
  "meetings",
  "documents",
  "time",
  "wiki",
  "news",
  "forums"
]);

export const workSchedulingModes = Object.freeze(["manual", "automatic"]);

export const workRelationTypes = Object.freeze([
  "predecessor",
  "successor",
  "blocks",
  "blocked-by",
  "duplicates",
  "duplicated-by",
  "related"
]);

export const lifecyclePhases = Object.freeze([
  "Proposed",
  "Approved",
  "Planning",
  "Execution",
  "Closing",
  "Closed"
]);

export const gateDecisions = Object.freeze([
  "pending",
  "approved",
  "rejected",
  "needs-revision"
]);

export const workItemTypes = Object.freeze(["task", "feature", "bug", "milestone", "risk", "issue"]);

export const workStatuses = Object.freeze([
  "intake",
  "ready",
  "in-progress",
  "blocked",
  "done"
]);

export const workConfigurationVersion = 1;
export const maxWorkTypes = 20;
export const maxWorkStatuses = 30;
export const maxWorkTransitions = 300;

const defaultWorkflowRoles = Object.freeze([
  roles.admin,
  roles.portfolioManager,
  roles.projectManager,
  roles.member
]);

/** @type {Readonly<Record<string, string>>} */
const defaultTypeLabels = Object.freeze({
  task: "Task",
  feature: "Feature",
  bug: "Bug",
  milestone: "Milestone",
  risk: "Risk",
  issue: "Issue"
});

/** @type {Readonly<Record<string, string>>} */
const defaultStatusLabels = Object.freeze({
  intake: "Intake",
  ready: "Ready",
  "in-progress": "In progress",
  blocked: "Blocked",
  done: "Done"
});

/**
 * The fallback is deliberately permissive so adopting configuration does not
 * change the behavior of an existing workspace. Administrators can replace
 * this complete graph with a narrower role-aware workflow.
 */
export const defaultWorkConfiguration = Object.freeze({
  schemaVersion: workConfigurationVersion,
  version: 1,
  defaultTypeId: "task",
  defaultStatusId: "intake",
  types: Object.freeze(workItemTypes.map((id) => Object.freeze({
    id,
    label: defaultTypeLabels[id],
    active: true
  }))),
  statuses: Object.freeze(workStatuses.map((id) => Object.freeze({
    id,
    label: defaultStatusLabels[id],
    active: true,
    closed: id === "done"
  }))),
  transitions: Object.freeze(workStatuses.flatMap((fromStatusId) => workStatuses
    .filter((toStatusId) => toStatusId !== fromStatusId)
    .map((toStatusId) => Object.freeze({
      fromStatusId,
      toStatusId,
      roles: defaultWorkflowRoles
    }))))
});

export const workspaceCapabilitiesSchemaVersion = 1;

export const notificationParticipationRules = Object.freeze(["assigned", "accountable", "watching"]);
export const customFieldEntityTypes = Object.freeze(["work-item", "project", "user", "group", "version", "time-entry", "time-entry-activity", "priority"]);

export const defaultNotificationPreferences = Object.freeze({
  version: 1,
  participationRules: [...notificationParticipationRules],
  projectOverrides: [],
  dateAlertsEnabled: true,
  emailDigest: "none",
  deliveryWebhookId: "",
  digestHourUtc: 8,
  weeklyDay: 1
});

export const defaultWorkspaceCapabilities = Object.freeze({
  schemaVersion: workspaceCapabilitiesSchemaVersion,
  version: 1,
  dashboard: {widgets: ["my-work", "project-health", "upcoming", "activity"], sharedTemplates: []},
  lifecycle: {phases: lifecyclePhases.map((label) => ({id: label.toLowerCase().replaceAll(" ", "-"), label, gates: []})), initiation: {enabled: false, reviewerIds: [], templateProjectId: "", requestFields: []}},
  priorities: priorities.map((id) => ({id, name: id[0].toUpperCase() + id.slice(1), color: "", active: true})),
  timeEntryActivities: [{id: "general", name: "General", active: true, customFields: {}}],
  customFields: [],
  forms: [],
  customActions: [],
  groups: [],
  departments: [],
  customRoles: [],
  finance: {currency: "USD", rates: [], unitCosts: [], budgets: [], reportDefinitions: []},
  resources: {profiles: [], allocations: [], timeOff: []},
  branding: {organizationName: "", logoUrl: "", faviconUrl: "", touchIconUrl: "", primaryColor: "", accentColor: "", pdfFont: "", pdfFooter: ""},
  authentication: {mfaRequired: false, oidcProviders: [], samlProviders: [], ldap: {enabled: false, host: "", baseDn: "", bindCredentialReference: "", syncGroups: false}},
  notifications: {participationRules: [], emailDigest: "none", dateAlerts: [], securityAlerts: true},
  webhooks: [],
  repositories: [],
  connectors: [],
  externalSharing: {enabled: false, defaultExpiresDays: 30},
  outboundLinks: {policy: "warn", captureEvents: true, allowDomains: []},
  security: {malwareScanning: "optional", uploadQuarantine: true, installationBadge: true, scannerWebhookId: "", scannerCredentialHash: ""},
  scim: {enabled: false, bearerCredentialHash: ""},
  mcp: {enabled: false, readOnly: true, allowedToolIds: []},
  work: {
    automaticSubjectPattern: "",
    exactTimeRequired: false,
    readOnlyStatusIds: [],
    tableColumns: [],
    highlightRules: []
  }
});

export const intakeGroups = Object.freeze([
  "ideas",
  "bugs",
  "maintenance",
  "ready"
]);

export const documentStatuses = Object.freeze([
  "pending",
  "ready",
  "archived"
]);

export const documentCategories = Object.freeze([
  "brief",
  "decision",
  "design",
  "contract",
  "evidence",
  "other"
]);

export const projectContentKinds = Object.freeze([
  "wiki-page",
  "document",
  "news",
  "forum-topic"
]);

export const projectContentStatuses = Object.freeze([
  "draft",
  "published",
  "locked",
  "archived"
]);

export const planningResourceKinds = Object.freeze([
  "version",
  "sprint",
  "baseline",
  "work-calendar",
  "board"
]);

export const planningResourceStatuses = Object.freeze([
  "planned",
  "active",
  "closed",
  "archived"
]);

export const boardDimensions = Object.freeze([
  "status",
  "assignee",
  "team",
  "version",
  "sprint",
  "subproject",
  "priority",
  "type"
]);

export const meetingStatuses = Object.freeze([
  "draft",
  "open",
  "in-progress",
  "closed",
  "cancelled"
]);

export const meetingQueryVersion = 1;
export const maxMeetingPageSize = 50;
export const maxMeetingParticipants = 50;
export const maxMeetingAgendaItems = 50;
export const maxMeetingWorkItemLinks = 100;
// A keyed create transaction stores the meeting and one replay snapshot. Keep
// their combined transactional write units comfortably below the deployed
// table's 200-WRU on-demand ceiling, with room for keys and activity metadata.
export const maxMeetingPayloadBytes = 32 * 1024;

/**
 * Meetings move forward through the facilitated lifecycle. Closed and
 * cancelled meetings may be explicitly reopened, but no transition returns a
 * meeting to draft.
 */
export const meetingStatusTransitions = Object.freeze({
  draft: Object.freeze(["open", "cancelled"]),
  open: Object.freeze(["in-progress", "closed", "cancelled"]),
  "in-progress": Object.freeze(["open", "closed", "cancelled"]),
  closed: Object.freeze(["open"]),
  cancelled: Object.freeze(["open"])
});

export const maxPageSize = 100;
export const maxAttachmentSizeBytes = 25 * 1024 * 1024;
export const workQueryVersion = 1;
export const workQuerySorts = Object.freeze(["updated-desc", "due-asc", "id-asc"]);

/**
 * @typedef {typeof roles[keyof typeof roles]} Role
 * @typedef {typeof permissions[keyof typeof permissions]} Permission
 */

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** @param {unknown} value */
function isPublicHttpsUrl(value) {
  try {
    const url = new URL(String(value));
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:" || url.username || url.password || !host) return false;
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return false;
    const octets = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
    if (octets && (octets.some((octet) => octet > 255) || octets[0] === 10 || octets[0] === 127 || octets[0] === 0 || octets[0] === 169 && octets[1] === 254 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 192 && octets[1] === 168)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isDateOnly(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a stable user-defined work taxonomy identifier. Labels remain freely
 * editable, while IDs are intentionally URL-, index-, and cursor-safe.
 *
 * @param {unknown} value
 * @param {string} [name]
 */
export function parseWorkConfigurationId(value, name = "id") {
  if (typeof value !== "string") throw new ContractValidationError(`${name} must be a string`);
  const id = value.trim();
  if (id.length < 1 || id.length > 48 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) {
    throw new ContractValidationError(`${name} must be a lowercase identifier of at most 48 characters`);
  }
  return id;
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function workConfigurationLabel(value, name) {
  if (!isNonEmptyString(value)) throw new ContractValidationError(`${name} is required`);
  const label = value.trim();
  if (label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new ContractValidationError(`${name} must be at most 80 characters and contain no control characters`);
  }
  return label;
}

/**
 * Parse a complete Work Configuration v1 replacement.
 *
 * @param {unknown} body
 */
export function parseWorkConfigurationInput(body) {
  if (!isObject(body)) throw new ContractValidationError("Work configuration body is required");
  if (body.version === undefined) throw new ContractValidationError("Work configuration version is required");
  if (body.schemaVersion !== undefined && Number(body.schemaVersion) !== workConfigurationVersion) {
    throw new ContractValidationError(`Work configuration schemaVersion must be ${workConfigurationVersion}`);
  }
  if (!Array.isArray(body.types) || body.types.length < 1 || body.types.length > maxWorkTypes) {
    throw new ContractValidationError(`Work configuration must contain from 1 to ${maxWorkTypes} types`);
  }
  if (!Array.isArray(body.statuses) || body.statuses.length < 1 || body.statuses.length > maxWorkStatuses) {
    throw new ContractValidationError(`Work configuration must contain from 1 to ${maxWorkStatuses} statuses`);
  }
  if (!Array.isArray(body.transitions) || body.transitions.length > maxWorkTransitions) {
    throw new ContractValidationError(`Work configuration transitions must be an array with at most ${maxWorkTransitions} entries`);
  }

  const types = body.types.map((item, index) => {
    if (!isObject(item)) throw new ContractValidationError(`types[${index}] must be an object`);
    if (typeof item.active !== "boolean") throw new ContractValidationError(`types[${index}].active must be a boolean`);
    return {
      id: parseWorkConfigurationId(item.id, `types[${index}].id`),
      label: workConfigurationLabel(item.label, `types[${index}].label`),
      active: item.active
    };
  });
  const statuses = body.statuses.map((item, index) => {
    if (!isObject(item)) throw new ContractValidationError(`statuses[${index}] must be an object`);
    if (typeof item.active !== "boolean") throw new ContractValidationError(`statuses[${index}].active must be a boolean`);
    if (typeof item.closed !== "boolean") throw new ContractValidationError(`statuses[${index}].closed must be a boolean`);
    return {
      id: parseWorkConfigurationId(item.id, `statuses[${index}].id`),
      label: workConfigurationLabel(item.label, `statuses[${index}].label`),
      active: item.active,
      closed: item.closed
    };
  });

  const typeIds = new Set(types.map((item) => item.id));
  const statusIds = new Set(statuses.map((item) => item.id));
  if (typeIds.size !== types.length) throw new ContractValidationError("Work configuration type IDs must be unique");
  if (statusIds.size !== statuses.length) throw new ContractValidationError("Work configuration status IDs must be unique");
  if (!types.some((item) => item.active)) throw new ContractValidationError("Work configuration requires an active type");
  if (!statuses.some((item) => item.active)) throw new ContractValidationError("Work configuration requires an active status");

  /** @type {Set<string>} */
  const allowedRoles = new Set(Object.values(roles));
  const transitionKeys = new Set();
  const transitions = body.transitions.map((item, index) => {
    if (!isObject(item)) throw new ContractValidationError(`transitions[${index}] must be an object`);
    const fromStatusId = parseWorkConfigurationId(item.fromStatusId, `transitions[${index}].fromStatusId`);
    const toStatusId = parseWorkConfigurationId(item.toStatusId, `transitions[${index}].toStatusId`);
    if (!statusIds.has(fromStatusId) || !statusIds.has(toStatusId)) {
      throw new ContractValidationError(`transitions[${index}] must reference known statuses`);
    }
    if (fromStatusId === toStatusId) throw new ContractValidationError(`transitions[${index}] cannot be a self-transition`);
    if (!statuses.find((status) => status.id === toStatusId)?.active) {
      throw new ContractValidationError(`transitions[${index}] must target an active status`);
    }
    if (!Array.isArray(item.roles) || item.roles.length < 1) {
      throw new ContractValidationError(`transitions[${index}].roles must contain at least one role`);
    }
    const transitionRoles = item.roles.map((role, roleIndex) => {
      if (typeof role !== "string" || !allowedRoles.has(role)) {
        throw new ContractValidationError(`transitions[${index}].roles[${roleIndex}] is not a known role`);
      }
      return role;
    });
    if (new Set(transitionRoles).size !== transitionRoles.length) {
      throw new ContractValidationError(`transitions[${index}].roles must be unique`);
    }
    const key = `${fromStatusId}:${toStatusId}`;
    if (transitionKeys.has(key)) throw new ContractValidationError("Work configuration transitions must be unique");
    transitionKeys.add(key);
    return {fromStatusId, toStatusId, roles: transitionRoles};
  });

  const defaultTypeId = parseWorkConfigurationId(body.defaultTypeId, "defaultTypeId");
  const defaultStatusId = parseWorkConfigurationId(body.defaultStatusId, "defaultStatusId");
  if (!types.find((item) => item.id === defaultTypeId)?.active) {
    throw new ContractValidationError("defaultTypeId must reference an active type");
  }
  if (!statuses.find((item) => item.id === defaultStatusId)?.active) {
    throw new ContractValidationError("defaultStatusId must reference an active status");
  }

  return {
    schemaVersion: workConfigurationVersion,
    version: intInRange(body.version, 0, 1, 1000000),
    defaultTypeId,
    defaultStatusId,
    types,
    statuses,
    transitions
  };
}

/**
 * Preserve stable taxonomy IDs so historical work remains interpretable.
 * Existing values may be renamed or deactivated, but not removed.
 *
 * @param {{types?: Array<{id?: string}>, statuses?: Array<{id?: string}>}} current
 * @param {{types?: Array<{id?: string}>, statuses?: Array<{id?: string}>}} next
 */
export function assertWorkConfigurationUpdate(current, next) {
  const nextTypeIds = new Set((next.types ?? []).map((item) => item.id));
  const nextStatusIds = new Set((next.statuses ?? []).map((item) => item.id));
  for (const item of current.types ?? []) {
    if (!nextTypeIds.has(item.id)) throw new ContractValidationError(`Work type ${item.id} cannot be removed; deactivate it instead`);
  }
  for (const item of current.statuses ?? []) {
    if (!nextStatusIds.has(item.id)) throw new ContractValidationError(`Work status ${item.id} cannot be removed; deactivate it instead`);
  }
}

/**
 * @param {{transitions?: Array<{fromStatusId: string, toStatusId: string, roles?: string[]}>}} configuration
 * @param {string} fromStatusId
 * @param {string} toStatusId
 * @param {string | undefined} role
 */
export function isWorkTransitionAllowed(configuration, fromStatusId, toStatusId, role) {
  if (fromStatusId === toStatusId) return true;
  return Boolean(role && (configuration.transitions ?? []).some((transition) => (
    transition.fromStatusId === fromStatusId
      && transition.toStatusId === toStatusId
      && transition.roles?.includes(role)
  )));
}

/**
 * Enforce a configured type/status target. Existing work may retain a value
 * that was later deactivated, but cannot newly adopt one.
 *
 * @param {{types?: Array<{id: string, active: boolean}>, statuses?: Array<{id: string, active: boolean}>, transitions?: Array<{fromStatusId: string, toStatusId: string, roles?: string[]}>}} configuration
 * @param {{type: string, status: string, previousType?: string, previousStatus?: string, role?: string, creating?: boolean}} mutation
 */
export function assertWorkItemConfiguration(configuration, mutation) {
  const type = configuration.types?.find((item) => item.id === mutation.type);
  const status = configuration.statuses?.find((item) => item.id === mutation.status);
  if (!type) throw new ContractValidationError(`Unknown work type: ${mutation.type}`);
  if (!status) throw new ContractValidationError(`Unknown work status: ${mutation.status}`);
  if ((mutation.creating || mutation.type !== mutation.previousType) && !type.active) {
    throw new ContractValidationError(`Work type is inactive: ${mutation.type}`);
  }
  if ((mutation.creating || mutation.status !== mutation.previousStatus) && !status.active) {
    throw new ContractValidationError(`Work status is inactive: ${mutation.status}`);
  }
  if (!mutation.creating && mutation.previousStatus !== undefined && mutation.status !== mutation.previousStatus
      && !isWorkTransitionAllowed(configuration, mutation.previousStatus, mutation.status, mutation.role)) {
    throw new ContractValidationError(`Transition from ${mutation.previousStatus} to ${mutation.status} is not allowed for this role`);
  }
}

/**
 * Querying an inactive value remains valid so historical work is findable,
 * while an unknown identifier is rejected instead of silently returning an
 * empty result that could mask a configuration typo.
 *
 * @param {{types?: Array<{id: string}>, statuses?: Array<{id: string}>}} configuration
 * @param {{type?: string, status?: string}} query
 */
export function assertWorkQueryConfiguration(configuration, query) {
  if (query.type && !configuration.types?.some((item) => item.id === query.type)) {
    throw new ContractValidationError(`Expected one of: ${(configuration.types ?? []).map((item) => item.id).join(", ")}`);
  }
  if (query.status && !configuration.statuses?.some((item) => item.id === query.status)) {
    throw new ContractValidationError(`Expected one of: ${(configuration.statuses ?? []).map((item) => item.id).join(", ")}`);
  }
}

/**
 * @param {readonly string[]} allowed
 * @param {unknown} value
 * @returns {string}
 */
export function enumValue(allowed, value) {
  if (typeof value === "string" && allowed.includes(value)) return value;
  throw new ContractValidationError(`Expected one of: ${allowed.join(", ")}`);
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
export function intInRange(value, fallback, min = 0, max = 100) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ContractValidationError(`Expected integer from ${min} to ${max}`);
  }
  return parsed;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function stringList(value) {
  if (Array.isArray(value)) return value.filter(isNonEmptyString).map((item) => item.trim()).slice(0, 25);
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 25);
  }
  return [];
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function projectModuleList(value) {
  if (value === undefined) return [...projectModules];
  if (!Array.isArray(value)) throw new ContractValidationError("modules must be an array");
  const modules = value.map((item) => enumValue(projectModules, item));
  if (new Set(modules).size !== modules.length) throw new ContractValidationError("modules must be unique");
  return modules;
}

/**
 * Typed relations are the canonical relation contract. Legacy parentId,
 * blockedBy, and relatedIds fields remain accepted for existing clients.
 * @param {unknown} value
 */
function workRelations(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) {
    throw new ContractValidationError("relations must be an array with at most 50 entries");
  }
  const relations = value.map((item, index) => {
    if (!isObject(item) || !isNonEmptyString(item.targetId)) {
      throw new ContractValidationError(`relations[${index}].targetId is required`);
    }
    return {
      type: enumValue(workRelationTypes, item.type),
      targetId: item.targetId.trim().slice(0, 128),
      lagDays: intInRange(item.lagDays, 0, -3650, 3650)
    };
  });
  const keys = relations.map((item) => `${item.type}:${item.targetId}`);
  if (new Set(keys).size !== keys.length) throw new ContractValidationError("relations must be unique by type and targetId");
  return relations;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function stringRecord(value) {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => isNonEmptyString(key) && (typeof item === "string" || typeof item === "number" || typeof item === "boolean"))
    .slice(0, 20)
    .map(([key, item]) => [key.trim().slice(0, 64), String(item).trim().slice(0, 512)]));
}

/** @param {unknown} value */
export function customFieldRecord(value) {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) throw new ContractValidationError("Custom field keys must be stable identifiers");
    if (item === null || typeof item === "boolean" || typeof item === "number") return [key, item];
    if (typeof item === "string") return [key, item.trim().slice(0, 100000)];
    if (Array.isArray(item) && item.length <= 50 && item.every((entry) => typeof entry === "string" || typeof entry === "number")) {
      return [key, item.map((entry) => typeof entry === "string" ? entry.trim().slice(0, 512) : entry)];
    }
    throw new ContractValidationError(`Custom field ${key} contains an unsupported value`);
  }));
}

/**
 * @param {unknown} input
 * @param {string} name
 */
function queryValue(input, name) {
  if (input && typeof input === "object" && "get" in input && typeof input.get === "function") {
    return input.get(name) ?? undefined;
  }
  return isObject(input) ? input[name] : undefined;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} maxLength
 */
function optionalQueryString(value, name, maxLength = 200) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ContractValidationError(`${name} must be a string`);
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > maxLength) throw new ContractValidationError(`${name} must be at most ${maxLength} characters`);
  return text;
}

/**
 * Parse the versioned Work Query v1 contract. `dueFrom` and `dueTo` are
 * inclusive date bounds; `dateFrom` and `dateTo` remain accepted aliases.
 *
 * Sorts intentionally map to an existing DynamoDB access path:
 * - `updated-desc` uses the workspace work index.
 * - `due-asc` requires `assigneeId` and uses the assignment index.
 * - `id-asc` requires `projectId` and uses the project partition.
 *
 * @param {URLSearchParams | Record<string, unknown>} input
 * @param {{projectId?: string, defaultSort?: string}} [defaults]
 */
export function parseWorkQuery(input, defaults = {}) {
  const suppliedProjectId = optionalQueryString(queryValue(input, "projectId"), "projectId", 128);
  const projectId = defaults.projectId ?? suppliedProjectId;
  if (defaults.projectId && suppliedProjectId && suppliedProjectId !== defaults.projectId) {
    throw new ContractValidationError("projectId does not match the route");
  }
  const typeValue = optionalQueryString(queryValue(input, "type"), "type", 64);
  const statusValue = optionalQueryString(queryValue(input, "status"), "status", 64);
  const assigneeId = optionalQueryString(queryValue(input, "assigneeId"), "assigneeId", 128);
  const milestoneName = optionalQueryString(queryValue(input, "milestoneName"), "milestoneName", 128);
  const periodId = optionalQueryString(queryValue(input, "periodId"), "periodId", 128);
  const search = optionalQueryString(queryValue(input, "search"), "search", 200);
  const dueFromValue = queryValue(input, "dueFrom") ?? queryValue(input, "dateFrom");
  const dueToValue = queryValue(input, "dueTo") ?? queryValue(input, "dateTo");
  const dueFrom = optionalQueryString(dueFromValue, "dueFrom", 10);
  const dueTo = optionalQueryString(dueToValue, "dueTo", 10);
  if (dueFrom && !isDateOnly(dueFrom)) throw new ContractValidationError("dueFrom must be YYYY-MM-DD");
  if (dueTo && !isDateOnly(dueTo)) throw new ContractValidationError("dueTo must be YYYY-MM-DD");
  if (dueFrom && dueTo && dueFrom > dueTo) throw new ContractValidationError("dueFrom must not be after dueTo");

  const requestedSort = optionalQueryString(queryValue(input, "sort"), "sort", 32);
  const defaultSort = defaults.defaultSort ?? (projectId ? "id-asc" : assigneeId ? "due-asc" : "updated-desc");
  const sort = enumValue(workQuerySorts, requestedSort ?? defaultSort);
  if (sort === "id-asc" && !projectId) throw new ContractValidationError("id-asc sort requires projectId");
  if (sort === "due-asc" && !assigneeId) throw new ContractValidationError("due-asc sort requires assigneeId");

  const cursor = optionalQueryString(queryValue(input, "cursor"), "cursor", 8192);
  return {
    version: workQueryVersion,
    projectId,
    type: typeValue ? parseWorkConfigurationId(typeValue, "type") : undefined,
    status: statusValue ? parseWorkConfigurationId(statusValue, "status") : undefined,
    assigneeId,
    dueFrom,
    dueTo,
    milestoneName,
    periodId,
    search,
    sort,
    limit: intInRange(queryValue(input, "limit"), maxPageSize, 1, maxPageSize),
    cursor
  };
}

const meetingControlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const meetingMutableFields = Object.freeze([
  "title",
  "description",
  "startsAt",
  "endsAt",
  "status",
  "location",
  "participantIds",
  "agendaItems",
  "minutes",
  "recurrence",
  "template",
  "attachmentIds",
  "attendance",
  "invitationMessage"
]);

/**
 * @param {unknown} value
 * @param {string} name
 */
export function parseMeetingIdentifier(value, name = "id") {
  if (typeof value !== "string") throw new ContractValidationError(`${name} must be a string`);
  const id = value.trim();
  if (id.length < 1 || id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    throw new ContractValidationError(`${name} must be a stable identifier of at most 128 characters`);
  }
  return id;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} maxLength
 * @param {boolean} [required]
 */
function meetingText(value, name, maxLength, required = false) {
  if (typeof value !== "string") throw new ContractValidationError(`${name} must be a string`);
  const text = value.trim();
  if ((required && !text) || text.length > maxLength || meetingControlCharacters.test(text)) {
    const requirement = required ? "non-empty and " : "";
    throw new ContractValidationError(`${name} must be ${requirement}at most ${maxLength} characters and contain no control characters`);
  }
  return text;
}

/**
 * Normalize meeting timestamps to UTC so lexical DynamoDB ordering matches
 * chronological ordering regardless of the submitted offset.
 * @param {unknown} value
 * @param {string} name
 */
function meetingTimestamp(value, name) {
  if (typeof value !== "string" || value.length > 64
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new ContractValidationError(`${name} must be an ISO 8601 timestamp with a timezone`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ContractValidationError(`${name} must be a valid timestamp`);
  return date.toISOString();
}

/** @param {unknown} value */
function meetingLocation(value) {
  const location = meetingText(value, "location", 500);
  const looksLikeUrl = location.includes("://") || /^[a-z][a-z0-9+.-]*:[^\s]/i.test(location);
  if (looksLikeUrl) {
    try {
      const url = new URL(location);
      if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("unsupported protocol");
    } catch {
      throw new ContractValidationError("location URLs must be valid HTTP or HTTPS URLs");
    }
  }
  return location;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} maxItems
 */
function meetingIdentifierList(value, name, maxItems) {
  if (!Array.isArray(value)) throw new ContractValidationError(`${name} must be an array`);
  if (value.length > maxItems) throw new ContractValidationError(`${name} must contain at most ${maxItems} entries`);
  const values = value.map((item, index) => parseMeetingIdentifier(item, `${name}[${index}]`));
  if (new Set(values).size !== values.length) throw new ContractValidationError(`${name} must be unique`);
  return values;
}

/** @param {unknown} value */
function parseMeetingAgendaItems(value) {
  if (!Array.isArray(value)) throw new ContractValidationError("agendaItems must be an array");
  if (value.length > maxMeetingAgendaItems) {
    throw new ContractValidationError(`agendaItems must contain at most ${maxMeetingAgendaItems} entries`);
  }
  const agendaItems = value.map((item, index) => {
    if (!isObject(item)) throw new ContractValidationError(`agendaItems[${index}] must be an object`);
    const presenterId = item.presenterId === undefined || item.presenterId === ""
      ? undefined
      : parseMeetingIdentifier(item.presenterId, `agendaItems[${index}].presenterId`);
    return {
      id: parseMeetingIdentifier(item.id, `agendaItems[${index}].id`),
      section: meetingText(item.section ?? "General", `agendaItems[${index}].section`, 100),
      title: meetingText(item.title, `agendaItems[${index}].title`, 200, true),
      durationMinutes: intInRange(item.durationMinutes, 0, 0, 1440),
      ...(presenterId ? {presenterId} : {}),
      workItemIds: meetingIdentifierList(item.workItemIds ?? [], `agendaItems[${index}].workItemIds`, 25),
      notes: meetingText(item.notes ?? "", `agendaItems[${index}].notes`, 10000),
      outcome: meetingText(item.outcome ?? "", `agendaItems[${index}].outcome`, 10000)
    };
  });
  const agendaIds = agendaItems.map((item) => item.id);
  if (new Set(agendaIds).size !== agendaIds.length) throw new ContractValidationError("agenda item IDs must be unique");
  const workItemIds = agendaItems.flatMap((item) => item.workItemIds);
  if (workItemIds.length > maxMeetingWorkItemLinks) {
    throw new ContractValidationError(`agendaItems may link at most ${maxMeetingWorkItemLinks} work items`);
  }
  if (new Set(workItemIds).size !== workItemIds.length) {
    throw new ContractValidationError("agenda work item links must be unique");
  }
  return agendaItems;
}

/** @param {unknown} value */
function parseMeetingRecurrence(value) {
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) throw new ContractValidationError("recurrence must be an object");
  const until = value.until === undefined || value.until === "" ? undefined : value.until;
  if (until !== undefined && !isDateOnly(until)) throw new ContractValidationError("recurrence.until must be YYYY-MM-DD");
  return {
    frequency: enumValue(["daily", "weekly", "monthly"], value.frequency ?? "weekly"),
    interval: intInRange(value.interval, 1, 1, 52),
    weekdays: value.weekdays === undefined ? [] : weekdayList(value.weekdays),
    until,
    occurrences: intInRange(value.occurrences, 0, 0, 500)
  };
}

/** @param {unknown} value */
function parseMeetingAttendance(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxMeetingParticipants) throw new ContractValidationError("attendance must be a bounded array");
  const records = value.map((item, index) => {
    if (!isObject(item)) throw new ContractValidationError(`attendance[${index}] must be an object`);
    return {
      userId: parseMeetingIdentifier(item.userId, `attendance[${index}].userId`),
      status: enumValue(["invited", "accepted", "tentative", "declined", "attended", "absent"], item.status ?? "invited"),
      note: meetingText(item.note ?? "", `attendance[${index}].note`, 500)
    };
  });
  if (new Set(records.map((item) => item.userId)).size !== records.length) throw new ContractValidationError("attendance user IDs must be unique");
  return records;
}

/** @param {{startsAt?: unknown, endsAt?: unknown}} meeting */
export function assertMeetingSchedule(meeting) {
  if (typeof meeting.startsAt !== "string" || typeof meeting.endsAt !== "string" || meeting.endsAt <= meeting.startsAt) {
    throw new ContractValidationError("endsAt must be after startsAt");
  }
}

/** @param {unknown} meeting */
export function assertMeetingPayloadSize(meeting) {
  const size = new TextEncoder().encode(JSON.stringify(meeting)).byteLength;
  if (size > maxMeetingPayloadBytes) {
    throw new ContractValidationError(`Meeting content must be at most ${maxMeetingPayloadBytes} bytes`);
  }
}

/**
 * @param {string} currentStatus
 * @param {string} nextStatus
 */
export function assertMeetingTransition(currentStatus, nextStatus) {
  if (currentStatus === nextStatus) return;
  const transitions = /** @type {Record<string, readonly string[]>} */ (meetingStatusTransitions);
  if (!(transitions[currentStatus] ?? []).includes(nextStatus)) {
    throw new ContractValidationError(`Meeting transition from ${currentStatus} to ${nextStatus} is not allowed`);
  }
}

/**
 * Enforce lifecycle locks after a parsed patch has been merged with the
 * current record. Outcomes and minutes can be captured while entering,
 * occupying, or leaving the facilitated in-progress state.
 * @param {Record<string, any>} current
 * @param {Record<string, any>} next
 * @param {Record<string, any>} patch
 */
export function assertMeetingUpdate(current, next, patch) {
  assertMeetingSchedule(next);
  assertMeetingPayloadSize(next);
  if (current.status === "closed" || current.status === "cancelled") {
    const submittedBusinessFields = meetingMutableFields.filter((field) => patch[field] !== undefined);
    if (next.status !== "open" || submittedBusinessFields.length !== 1 || submittedBusinessFields[0] !== "status") {
      throw new ContractValidationError("A closed or cancelled meeting is read-only and must be reopened with a status-only patch");
    }
  }
  assertMeetingTransition(current.status, next.status);

  const currentAgenda = /** @type {Array<{id: string, outcome?: string}>} */ (current.agendaItems ?? []);
  const nextAgenda = /** @type {Array<{id: string, outcome?: string}>} */ (next.agendaItems ?? []);
  const previousOutcomes = new Map(currentAgenda.map((item) => [item.id, item.outcome ?? ""]));
  const nextOutcomes = new Map(nextAgenda.map((item) => [item.id, item.outcome ?? ""]));
  const outcomeIds = new Set([...previousOutcomes.keys(), ...nextOutcomes.keys()]);
  const outcomeChanged = patch.agendaItems !== undefined
    && [...outcomeIds].some((id) => (previousOutcomes.get(id) ?? "") !== (nextOutcomes.get(id) ?? ""));
  const minutesChanged = patch.minutes !== undefined && String(current.minutes ?? "") !== String(next.minutes ?? "");
  const inProgressWindow = current.status === "in-progress" || next.status === "in-progress";
  if ((outcomeChanged || minutesChanged) && !inProgressWindow) {
    throw new ContractValidationError("Meeting outcomes and minutes are writable only while the meeting is in progress");
  }
}

/**
 * @param {URLSearchParams | Record<string, unknown>} input
 */
export function parseMeetingQuery(input) {
  const projectIdValue = optionalQueryString(queryValue(input, "projectId"), "projectId", 128);
  return {
    version: meetingQueryVersion,
    projectId: projectIdValue ? parseMeetingIdentifier(projectIdValue, "projectId") : undefined,
    limit: intInRange(queryValue(input, "limit"), 25, 1, maxMeetingPageSize),
    cursor: optionalQueryString(queryValue(input, "cursor"), "cursor", 8192)
  };
}

/** @param {unknown} body */
export function parseMeetingInput(body) {
  if (!isObject(body)) throw new ContractValidationError("Meeting body is required");
  if (body.status !== undefined && body.status !== "draft") {
    throw new ContractValidationError("New meetings must start in draft");
  }
  const recurrence = parseMeetingRecurrence(body.recurrence);
  const meeting = {
    projectId: parseMeetingIdentifier(body.projectId, "projectId"),
    title: meetingText(body.title, "title", 200, true),
    description: meetingText(body.description ?? "", "description", 20000),
    startsAt: meetingTimestamp(body.startsAt, "startsAt"),
    endsAt: meetingTimestamp(body.endsAt, "endsAt"),
    status: "draft",
    location: meetingLocation(body.location ?? ""),
    participantIds: meetingIdentifierList(body.participantIds ?? [], "participantIds", maxMeetingParticipants),
    agendaItems: parseMeetingAgendaItems(body.agendaItems ?? []),
    minutes: meetingText(body.minutes ?? "", "minutes", 50000),
    ...(recurrence ? {recurrence} : {}),
    template: Boolean(body.template),
    attachmentIds: meetingIdentifierList(body.attachmentIds ?? [], "attachmentIds", 100),
    attendance: parseMeetingAttendance(body.attendance),
    invitationMessage: meetingText(body.invitationMessage ?? "", "invitationMessage", 2000)
  };
  assertMeetingSchedule(meeting);
  if (meeting.minutes || meeting.agendaItems.some((item) => item.outcome)) {
    throw new ContractValidationError("Draft meetings cannot contain outcomes or minutes");
  }
  assertMeetingPayloadSize(meeting);
  return meeting;
}

/** @param {unknown} body */
export function parseMeetingPatchInput(body) {
  if (!isObject(body)) throw new ContractValidationError("Meeting patch body is required");
  if (body.version === undefined) throw new ContractValidationError("Meeting version is required");
  const patch = {
    projectId: parseMeetingIdentifier(body.projectId, "projectId"),
    version: intInRange(body.version, 0, 1, 1000000),
    title: body.title === undefined ? undefined : meetingText(body.title, "title", 200, true),
    description: body.description === undefined ? undefined : meetingText(body.description, "description", 20000),
    startsAt: body.startsAt === undefined ? undefined : meetingTimestamp(body.startsAt, "startsAt"),
    endsAt: body.endsAt === undefined ? undefined : meetingTimestamp(body.endsAt, "endsAt"),
    status: body.status === undefined ? undefined : enumValue(meetingStatuses, body.status),
    location: body.location === undefined ? undefined : meetingLocation(body.location),
    participantIds: body.participantIds === undefined
      ? undefined
      : meetingIdentifierList(body.participantIds, "participantIds", maxMeetingParticipants),
    agendaItems: body.agendaItems === undefined ? undefined : parseMeetingAgendaItems(body.agendaItems),
    minutes: body.minutes === undefined ? undefined : meetingText(body.minutes, "minutes", 50000),
    recurrence: body.recurrence === undefined ? undefined : parseMeetingRecurrence(body.recurrence),
    template: body.template === undefined ? undefined : Boolean(body.template),
    attachmentIds: body.attachmentIds === undefined ? undefined : meetingIdentifierList(body.attachmentIds, "attachmentIds", 100),
    attendance: body.attendance === undefined ? undefined : parseMeetingAttendance(body.attendance),
    invitationMessage: body.invitationMessage === undefined ? undefined : meetingText(body.invitationMessage, "invitationMessage", 2000)
  };
  const parsed = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  if (!meetingMutableFields.some((field) => parsed[field] !== undefined)) {
    throw new ContractValidationError("Meeting patch must include a field to update");
  }
  assertMeetingPayloadSize(parsed);
  return parsed;
}

/** @param {unknown} body */
export function parseMeetingCopyInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.projectId)) throw new ContractValidationError("projectId is required");
  const startsAt = body.startsAt === undefined ? undefined : meetingTimestamp(body.startsAt, "startsAt");
  const endsAt = body.endsAt === undefined ? undefined : meetingTimestamp(body.endsAt, "endsAt");
  if (Boolean(startsAt) !== Boolean(endsAt)) throw new ContractValidationError("startsAt and endsAt must be supplied together");
  if (startsAt && endsAt && endsAt <= startsAt) throw new ContractValidationError("endsAt must be after startsAt");
  return {
    projectId: body.projectId.trim(),
    title: typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : undefined,
    startsAt,
    endsAt,
    asTemplate: Boolean(body.asTemplate)
  };
}

/** @param {unknown} body */
export function parseMeetingAttendanceResponseInput(body) {
  if (!isObject(body) || body.version === undefined) throw new ContractValidationError("version is required");
  return {
    version: intInRange(body.version, 0, 1, 1000000),
    status: enumValue(["accepted", "tentative", "declined", "attended", "absent"], body.status),
    note: meetingText(body.note ?? "", "note", 500)
  };
}

/**
 * @param {unknown} body
 * @returns {{name: string, description?: string}}
 */
export function parsePortfolioInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.name)) {
    throw new ContractValidationError("Portfolio name is required");
  }
  return {
    name: body.name.trim(),
    description: typeof body.description === "string" ? body.description.trim() : undefined
  };
}

/**
 * @param {unknown} body
 * @returns {{version: number, name?: string, description?: string, archived?: boolean}}
 */
export function parsePortfolioPatchInput(body) {
  if (!isObject(body)) throw new ContractValidationError("Portfolio patch body is required");
  if (body.version === undefined) throw new ContractValidationError("Portfolio version is required");
  const patch = {
    version: intInRange(body.version, 0, 0, 1000000),
    name: typeof body.name === "string" && body.name ? body.name.trim() : undefined,
    description: typeof body.description === "string" ? body.description.trim() : undefined,
    archived: body.archived === undefined ? undefined : Boolean(body.archived)
  };
  return {
    version: patch.version,
    ...(patch.name === undefined ? {} : {name: patch.name}),
    ...(patch.description === undefined ? {} : {description: patch.description}),
    ...(patch.archived === undefined ? {} : {archived: patch.archived})
  };
}

/**
 * @param {unknown} body
 * @returns {{name: string, accountType?: string, defaultProjectPrefix?: string, dataRetentionDays?: number}}
 */
export function parseWorkspaceInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.name)) {
    throw new ContractValidationError("Workspace name is required");
  }
  return {
    name: body.name.trim(),
    accountType: typeof body.accountType === "string" && body.accountType ? enumValue(accountTypes, body.accountType) : undefined,
    defaultProjectPrefix: typeof body.defaultProjectPrefix === "string" && body.defaultProjectPrefix ? body.defaultProjectPrefix.trim() : undefined,
    dataRetentionDays: intInRange(body.dataRetentionDays, 0, 0, 3650)
  };
}

/**
 * @param {unknown} body
 */
export function parseAccountInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.name)) {
    throw new ContractValidationError("Account name is required");
  }
  return {
    name: body.name.trim(),
    accountType: typeof body.accountType === "string" && body.accountType ? enumValue(accountTypes, body.accountType) : "client",
    defaultProjectPrefix: typeof body.defaultProjectPrefix === "string" && body.defaultProjectPrefix ? body.defaultProjectPrefix.trim() : undefined
  };
}

/**
 * @param {unknown} body
 */
export function parseMembershipInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.email)) {
    throw new ContractValidationError("Member email is required");
  }
  const role = typeof body.role === "string" ? body.role.trim() : roles.viewer;
  if (!(/** @type {string[]} */ (Object.values(roles))).includes(role) && !/^custom:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(role)) {
    throw new ContractValidationError("Member role must be a built-in role or custom:<role-id>");
  }
  return {
    userId: typeof body.userId === "string" && body.userId ? body.userId.trim() : undefined,
    email: body.email.trim().toLowerCase(),
    name: typeof body.name === "string" && body.name ? body.name.trim() : body.email.trim().toLowerCase(),
    role,
    status: typeof body.status === "string" && body.status ? enumValue(["active", "invited", "disabled"], body.status) : "active",
    projectIds: body.projectIds === undefined ? undefined : stringList(body.projectIds),
    customFields: body.customFields === undefined ? undefined : customFieldRecord(body.customFields)
  };
}

/**
 * @param {unknown} body
 */
export function parseProfileInput(body) {
  if (!isObject(body)) throw new ContractValidationError("Profile body is required");
  return {
    name: typeof body.name === "string" && body.name ? body.name.trim() : undefined,
    title: typeof body.title === "string" && body.title ? body.title.trim() : undefined,
    department: typeof body.department === "string" && body.department ? body.department.trim() : undefined,
    timezone: typeof body.timezone === "string" && body.timezone ? body.timezone.trim() : undefined,
    locale: typeof body.locale === "string" && body.locale ? body.locale.trim() : undefined,
    customFields: body.customFields === undefined ? undefined : customFieldRecord(body.customFields)
  };
}

/**
 * Parse a user's notification-center and scheduled-summary preferences. The
 * object is intentionally a full, versioned replacement so indexed schedule
 * state cannot drift after partial updates.
 * @param {unknown} body
 */
export function parseNotificationPreferencesInput(body) {
  if (!isObject(body) || !Number.isInteger(Number(body.version)) || Number(body.version) < 1) {
    throw new ContractValidationError("Notification preference version is required");
  }
  const participationRules = stringList(body.participationRules);
  if (participationRules.some((rule) => !notificationParticipationRules.includes(rule))) {
    throw new ContractValidationError("participationRules contains an unsupported rule");
  }
  if (!Array.isArray(body.projectOverrides) || body.projectOverrides.length > 100) {
    throw new ContractValidationError("projectOverrides must contain at most 100 records");
  }
  const projectOverrides = body.projectOverrides.map((override) => {
    if (!isObject(override) || !isNonEmptyString(override.projectId)) {
      throw new ContractValidationError("Every notification project override needs a projectId");
    }
    const rules = stringList(override.participationRules);
    if (rules.some((rule) => !notificationParticipationRules.includes(rule))) {
      throw new ContractValidationError("A project override contains an unsupported participation rule");
    }
    return {projectId: override.projectId.trim(), participationRules: rules};
  });
  if (new Set(projectOverrides.map((override) => override.projectId)).size !== projectOverrides.length) {
    throw new ContractValidationError("Notification project overrides must be unique");
  }
  const emailDigest = enumValue(["none", "daily", "weekly"], body.emailDigest);
  const deliveryWebhookId = typeof body.deliveryWebhookId === "string" ? body.deliveryWebhookId.trim() : "";
  if (deliveryWebhookId.length > 128) throw new ContractValidationError("deliveryWebhookId must be at most 128 characters");
  if (emailDigest !== "none" && !deliveryWebhookId) throw new ContractValidationError("Scheduled email summaries need a delivery webhook");
  const digestHourUtc = Number(body.digestHourUtc);
  if (!Number.isInteger(digestHourUtc) || digestHourUtc < 0 || digestHourUtc > 23) {
    throw new ContractValidationError("digestHourUtc must be an integer from 0 through 23");
  }
  const weeklyDay = Number(body.weeklyDay);
  if (!Number.isInteger(weeklyDay) || weeklyDay < 0 || weeklyDay > 6) {
    throw new ContractValidationError("weeklyDay must be an integer from 0 through 6");
  }
  return {
    version: Number(body.version),
    participationRules,
    projectOverrides,
    dateAlertsEnabled: body.dateAlertsEnabled !== false,
    emailDigest,
    deliveryWebhookId,
    digestHourUtc,
    weeklyDay
  };
}

/**
 * @param {unknown} body
 */
export function parseProjectInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.name)) {
    throw new ContractValidationError("Project name is required");
  }
  const startDate = body.startDate === undefined || body.startDate === "" ? undefined : body.startDate;
  const targetDate = body.targetDate === undefined || body.targetDate === "" ? undefined : body.targetDate;
  if (startDate !== undefined && !isDateOnly(startDate)) throw new ContractValidationError("startDate must be YYYY-MM-DD");
  if (targetDate !== undefined && !isDateOnly(targetDate)) throw new ContractValidationError("targetDate must be YYYY-MM-DD");
  return {
    name: body.name.trim(),
    description: typeof body.description === "string" ? body.description.trim() : "",
    portfolioId: typeof body.portfolioId === "string" && body.portfolioId ? body.portfolioId : undefined,
    parentProjectId: typeof body.parentProjectId === "string" && body.parentProjectId ? body.parentProjectId.trim() : undefined,
    ownerId: typeof body.ownerId === "string" && body.ownerId ? body.ownerId : undefined,
    status: enumValue(projectStatuses, body.status ?? "active"),
    health: enumValue(healthStates, body.health ?? "on-track"),
    priority: enumValue(priorities, body.priority ?? "medium"),
    phase: body.phase === undefined ? undefined : projectPhase(body.phase),
    startDate,
    targetDate,
    percentComplete: intInRange(body.percentComplete, 0, 0, 100),
    modules: projectModuleList(body.modules),
    template: Boolean(body.template),
    customFields: customFieldRecord(body.customFields),
    tags: stringList(body.tags),
    ...(body.coordination === undefined ? {} : {coordination: parseProjectCoordination(body.coordination)})
  };
}

/**
 * @param {unknown} body
 */
export function parseProjectPatchInput(body) {
  if (!isObject(body)) throw new ContractValidationError("Project patch body is required");
  if (body.version === undefined) throw new ContractValidationError("Project version is required");
  const patch = {
    name: typeof body.name === "string" && body.name ? body.name.trim() : undefined,
    description: typeof body.description === "string" ? body.description.trim() : undefined,
    portfolioId: typeof body.portfolioId === "string" ? body.portfolioId.trim() : undefined,
    parentProjectId: typeof body.parentProjectId === "string" ? body.parentProjectId.trim() : undefined,
    ownerId: typeof body.ownerId === "string" ? body.ownerId.trim() : undefined,
    status: typeof body.status === "string" && body.status ? enumValue(projectStatuses, body.status) : undefined,
    health: typeof body.health === "string" && body.health ? enumValue(healthStates, body.health) : undefined,
    priority: typeof body.priority === "string" && body.priority ? enumValue(priorities, body.priority) : undefined,
    phase: typeof body.phase === "string" && body.phase ? projectPhase(body.phase) : undefined,
    startDate: body.startDate === "" ? "" : isDateOnly(body.startDate) ? body.startDate : undefined,
    targetDate: body.targetDate === "" ? "" : isDateOnly(body.targetDate) ? body.targetDate : undefined,
    percentComplete: body.percentComplete === undefined ? undefined : intInRange(body.percentComplete, 0, 0, 100),
    favorite: body.favorite === undefined ? undefined : Boolean(body.favorite),
    archived: body.archived === undefined ? undefined : Boolean(body.archived),
    modules: body.modules === undefined ? undefined : projectModuleList(body.modules),
    template: body.template === undefined ? undefined : Boolean(body.template),
    customFields: body.customFields === undefined ? undefined : customFieldRecord(body.customFields),
    tags: body.tags === undefined ? undefined : stringList(body.tags),
    version: body.version === undefined ? undefined : intInRange(body.version, 0, 0, 1000000),
    ...(body.coordination === undefined ? {} : {coordination: parseProjectCoordination(body.coordination)})
  };
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

/** @param {unknown} value */
function projectPhase(value) {
  if (!isNonEmptyString(value) || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value)) throw new ContractValidationError("phase must be from 1 to 80 characters");
  return value.trim();
}

/** @param {unknown} body */
export function parseProjectCopyInput(body) {
  if (!isObject(body)) throw new ContractValidationError("Project copy body is required");
  return {
    name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined,
    parentProjectId: typeof body.parentProjectId === "string" && body.parentProjectId.trim() ? body.parentProjectId.trim() : undefined,
    includeTasks: body.includeTasks === undefined ? true : Boolean(body.includeTasks),
    asTemplate: Boolean(body.asTemplate)
  };
}

/** @param {unknown} body */
export function parseVersionInput(body) {
  if (!isObject(body) || body.version === undefined) throw new ContractValidationError("version is required");
  return {version: intInRange(body.version, 0, 1, 1000000)};
}

/**
 * @param {unknown} body
 */
export function parseWorkItemInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.title) && !body.autoSubject) throw new ContractValidationError("Task title is required unless autoSubject is enabled");
  return {
    title: isNonEmptyString(body.title) ? body.title.trim() : "",
    autoSubject: Boolean(body.autoSubject),
    description: typeof body.description === "string" ? body.description.trim() : "",
    type: isNonEmptyString(body.type) ? parseWorkConfigurationId(body.type, "type") : undefined,
    status: isNonEmptyString(body.status) ? parseWorkConfigurationId(body.status, "status") : undefined,
    priority: parseWorkConfigurationId(body.priority ?? "medium", "priority"),
    assigneeId: typeof body.assigneeId === "string" && body.assigneeId ? body.assigneeId : undefined,
    teamId: typeof body.teamId === "string" && body.teamId ? body.teamId.trim().slice(0, 128) : undefined,
    accountableId: typeof body.accountableId === "string" && body.accountableId ? body.accountableId : undefined,
    reporterId: typeof body.reporterId === "string" && body.reporterId ? body.reporterId : undefined,
    startDate: isDateOnly(body.startDate) ? body.startDate : undefined,
    dueDate: isDateOnly(body.dueDate) ? body.dueDate : undefined,
    estimateMinutes: intInRange(body.estimateMinutes, 0, 0, 100000),
    remainingMinutes: intInRange(body.remainingMinutes, 0, 0, 100000),
    percentComplete: intInRange(body.percentComplete, 0, 0, 100),
    effortPoints: intInRange(body.effortPoints, 0, 0, 100),
    category: typeof body.category === "string" && body.category ? body.category.trim().slice(0, 100) : undefined,
    versionName: typeof body.versionName === "string" && body.versionName ? body.versionName.trim().slice(0, 100) : undefined,
    versionId: typeof body.versionId === "string" && body.versionId ? body.versionId.trim().slice(0, 128) : undefined,
    sprintId: typeof body.sprintId === "string" && body.sprintId ? body.sprintId.trim().slice(0, 128) : undefined,
    schedulingMode: enumValue(workSchedulingModes, body.schedulingMode ?? "manual"),
    periodId: typeof body.periodId === "string" && body.periodId ? body.periodId.trim() : undefined,
    periodName: typeof body.periodName === "string" && body.periodName ? body.periodName.trim() : undefined,
    periodGoal: typeof body.periodGoal === "string" && body.periodGoal ? body.periodGoal.trim() : undefined,
    intakeGroup: typeof body.intakeGroup === "string" && body.intakeGroup ? enumValue(intakeGroups, body.intakeGroup) : undefined,
    milestoneName: typeof body.milestoneName === "string" && body.milestoneName ? body.milestoneName.trim() : undefined,
    parentId: typeof body.parentId === "string" && body.parentId ? body.parentId.trim() : undefined,
    blockedBy: stringList(body.blockedBy),
    relatedIds: stringList(body.relatedIds),
    relations: workRelations(body.relations),
    watcherIds: stringList(body.watcherIds),
    acceptanceCriteria: typeof body.acceptanceCriteria === "string" ? body.acceptanceCriteria.trim() : "",
    customFields: customFieldRecord(body.customFields),
    tags: stringList(body.tags),
    ...(body.coordination === undefined ? {} : {coordination: parseTaskCoordination(body.coordination)})
  };
}

/**
 * @param {unknown} body
 */
export function parseWorkItemPatchInput(body) {
  if (!isObject(body)) throw new ContractValidationError("Task patch body is required");
  if (body.version === undefined) throw new ContractValidationError("Task version is required");
  const patch = {
    title: typeof body.title === "string" && body.title ? body.title.trim() : undefined,
    description: typeof body.description === "string" ? body.description.trim() : undefined,
    type: typeof body.type === "string" && body.type ? parseWorkConfigurationId(body.type, "type") : undefined,
    status: typeof body.status === "string" && body.status ? parseWorkConfigurationId(body.status, "status") : undefined,
    priority: typeof body.priority === "string" && body.priority ? parseWorkConfigurationId(body.priority, "priority") : undefined,
    assigneeId: typeof body.assigneeId === "string" ? body.assigneeId.trim() : undefined,
    teamId: typeof body.teamId === "string" ? body.teamId.trim().slice(0, 128) : undefined,
    accountableId: typeof body.accountableId === "string" ? body.accountableId.trim() : undefined,
    startDate: body.startDate === "" ? "" : isDateOnly(body.startDate) ? body.startDate : undefined,
    dueDate: body.dueDate === "" ? "" : isDateOnly(body.dueDate) ? body.dueDate : undefined,
    estimateMinutes: body.estimateMinutes === undefined ? undefined : intInRange(body.estimateMinutes, 0, 0, 100000),
    remainingMinutes: body.remainingMinutes === undefined ? undefined : intInRange(body.remainingMinutes, 0, 0, 100000),
    percentComplete: body.percentComplete === undefined ? undefined : intInRange(body.percentComplete, 0, 0, 100),
    effortPoints: body.effortPoints === undefined ? undefined : intInRange(body.effortPoints, 0, 0, 100),
    category: typeof body.category === "string" ? body.category.trim().slice(0, 100) : undefined,
    versionName: typeof body.versionName === "string" ? body.versionName.trim().slice(0, 100) : undefined,
    versionId: typeof body.versionId === "string" ? body.versionId.trim().slice(0, 128) : undefined,
    sprintId: typeof body.sprintId === "string" ? body.sprintId.trim().slice(0, 128) : undefined,
    schedulingMode: typeof body.schedulingMode === "string" ? enumValue(workSchedulingModes, body.schedulingMode) : undefined,
    periodId: typeof body.periodId === "string" && body.periodId ? body.periodId.trim() : undefined,
    periodName: typeof body.periodName === "string" ? body.periodName.trim() : undefined,
    periodGoal: typeof body.periodGoal === "string" ? body.periodGoal.trim() : undefined,
    intakeGroup: typeof body.intakeGroup === "string" ? (body.intakeGroup ? enumValue(intakeGroups, body.intakeGroup) : "") : undefined,
    milestoneName: typeof body.milestoneName === "string" ? body.milestoneName.trim() : undefined,
    parentId: typeof body.parentId === "string" ? body.parentId.trim() : undefined,
    blockedBy: body.blockedBy === undefined ? undefined : stringList(body.blockedBy),
    relatedIds: body.relatedIds === undefined ? undefined : stringList(body.relatedIds),
    relations: body.relations === undefined ? undefined : workRelations(body.relations),
    watcherIds: body.watcherIds === undefined ? undefined : stringList(body.watcherIds),
    acceptanceCriteria: typeof body.acceptanceCriteria === "string" ? body.acceptanceCriteria.trim() : undefined,
    customFields: body.customFields === undefined ? undefined : customFieldRecord(body.customFields),
    tags: body.tags === undefined ? undefined : stringList(body.tags),
    rank: body.rank === undefined ? undefined : intInRange(body.rank, 0, 0, 1000000000),
    version: body.version === undefined ? undefined : intInRange(body.version, 0, 0, 1000000),
    ...(body.coordination === undefined ? {} : {coordination: parseTaskCoordination(body.coordination)})
  };
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

/** @param {unknown} body */
export function parseWorkItemCopyInput(body) {
  if (!isObject(body)) throw new ContractValidationError("Task copy body is required");
  return {
    title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : undefined,
    targetProjectId: typeof body.targetProjectId === "string" && body.targetProjectId.trim() ? body.targetProjectId.trim() : undefined
  };
}

/** @param {unknown} body */
export function parseWorkItemMoveInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.targetProjectId) || body.version === undefined) {
    throw new ContractValidationError("targetProjectId and version are required");
  }
  return {
    targetProjectId: body.targetProjectId.trim(),
    version: intInRange(body.version, 0, 1, 1000000)
  };
}

/**
 * @param {unknown} body
 */
export function parseTimeEntryInput(body) {
  if (!isObject(body) || !isDateOnly(body.entryDate)) throw new ContractValidationError("entryDate must be YYYY-MM-DD");
  const startedAt = typeof body.startedAt === "string" && body.startedAt ? new Date(body.startedAt) : undefined;
  const endedAt = typeof body.endedAt === "string" && body.endedAt ? new Date(body.endedAt) : undefined;
  if (startedAt || endedAt) {
    if (!startedAt || !endedAt || Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime()) || endedAt <= startedAt) throw new ContractValidationError("startedAt and endedAt must be valid timestamps with endedAt after startedAt");
  }
  const exactDuration = startedAt && endedAt ? Math.max(1, Math.round((endedAt.getTime() - startedAt.getTime()) / 60000)) : undefined;
  const durationMinutes = intInRange(exactDuration ?? body.durationMinutes, 0, 1, 1440);
  if (!isNonEmptyString(body.projectId) && !isNonEmptyString(body.workItemId)) {
    throw new ContractValidationError("projectId or workItemId is required");
  }
  return {
    projectId: isNonEmptyString(body.projectId) ? body.projectId : undefined,
    workItemId: isNonEmptyString(body.workItemId) ? body.workItemId : undefined,
    entryDate: body.entryDate,
    durationMinutes,
    startedAt: startedAt?.toISOString(),
    endedAt: endedAt?.toISOString(),
    description: typeof body.description === "string" ? body.description.trim() : "",
    billable: Boolean(body.billable),
    activityId: typeof body.activityId === "string" && body.activityId.trim() ? body.activityId.trim().slice(0, 48) : "general",
    customFields: customFieldRecord(body.customFields)
  };
}

/** @param {unknown} body */
export function parseTimeEntryPatchInput(body) {
  if (!isObject(body) || body.version === undefined || !isDateOnly(body.originalEntryDate)) {
    throw new ContractValidationError("version and originalEntryDate are required");
  }
  const startedAt = typeof body.startedAt === "string" && body.startedAt ? new Date(body.startedAt) : undefined;
  const endedAt = typeof body.endedAt === "string" && body.endedAt ? new Date(body.endedAt) : undefined;
  if (startedAt || endedAt) {
    if (!startedAt || !endedAt || Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime()) || endedAt <= startedAt) throw new ContractValidationError("startedAt and endedAt must be valid timestamps with endedAt after startedAt");
  }
  const exactDuration = startedAt && endedAt ? Math.max(1, Math.round((endedAt.getTime() - startedAt.getTime()) / 60000)) : undefined;
  const patch = {
    originalEntryDate: body.originalEntryDate,
    version: intInRange(body.version, 0, 1, 1000000),
    entryDate: body.entryDate === undefined ? undefined : isDateOnly(body.entryDate) ? body.entryDate : undefined,
    durationMinutes: exactDuration ?? (body.durationMinutes === undefined ? undefined : intInRange(body.durationMinutes, 0, 1, 1440)),
    startedAt: startedAt?.toISOString(),
    endedAt: endedAt?.toISOString(),
    description: typeof body.description === "string" ? body.description.trim() : undefined,
    billable: body.billable === undefined ? undefined : Boolean(body.billable),
    activityId: typeof body.activityId === "string" && body.activityId.trim() ? body.activityId.trim().slice(0, 48) : undefined,
    customFields: body.customFields === undefined ? undefined : customFieldRecord(body.customFields)
  };
  if (body.entryDate !== undefined && patch.entryDate === undefined) throw new ContractValidationError("entryDate must be YYYY-MM-DD");
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

/** @param {unknown} body */
export function parseTimerStartInput(body) {
  if (!isObject(body) || (!isNonEmptyString(body.projectId) && !isNonEmptyString(body.workItemId))) {
    throw new ContractValidationError("projectId or workItemId is required");
  }
  return {
    projectId: isNonEmptyString(body.projectId) ? body.projectId.trim() : undefined,
    workItemId: isNonEmptyString(body.workItemId) ? body.workItemId.trim() : undefined,
    description: typeof body.description === "string" ? body.description.trim().slice(0, 1000) : "",
    billable: Boolean(body.billable),
    activityId: typeof body.activityId === "string" && body.activityId.trim() ? body.activityId.trim().slice(0, 48) : "general",
    customFields: customFieldRecord(body.customFields)
  };
}

/**
 * @param {unknown} body
 */
export function parseActivityInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.projectId) || !isNonEmptyString(body.summary)) {
    throw new ContractValidationError("projectId and summary are required");
  }
  const entityType = typeof body.entityType === "string" && body.entityType ? enumValue(["project", "work-item", "document", "time-entry", "meeting", "wiki-page", "news", "forum-topic"], body.entityType) : "project";
  const reminderAt = typeof body.reminderAt === "string" && body.reminderAt ? new Date(body.reminderAt) : undefined;
  if (reminderAt && Number.isNaN(reminderAt.getTime())) throw new ContractValidationError("reminderAt must be a valid timestamp");
  return {
    projectId: body.projectId.trim(),
    entityType,
    entityId: typeof body.entityId === "string" && body.entityId ? body.entityId.trim() : body.projectId.trim(),
    summary: body.summary.trim().slice(0, 10000),
    parentId: typeof body.parentId === "string" && body.parentId ? body.parentId.trim().slice(0, 128) : undefined,
    mentions: stringList(body.mentions),
    reactions: stringList(body.reactions),
    visibility: typeof body.visibility === "string" && body.visibility ? enumValue(["project", "internal"], body.visibility) : "project",
    format: typeof body.format === "string" && body.format ? enumValue(["plain", "markdown"], body.format) : "markdown",
    reminderAt: reminderAt?.toISOString()
  };
}

/**
 * @param {unknown} body
 */
export function parseSavedViewInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.name) || !isNonEmptyString(body.scope)) {
    throw new ContractValidationError("Saved view name and scope are required");
  }
  return {
    name: body.name.trim(),
    scope: body.scope.trim(),
    filters: isObject(body.filters) ? body.filters : {},
    visibility: typeof body.visibility === "string" ? enumValue(["private", "workspace"], body.visibility) : "private"
  };
}

/**
 * @param {unknown} body
 */
export function parseDocumentUploadIntentInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.projectId) || !isNonEmptyString(body.filename) || !isNonEmptyString(body.contentType)) {
    throw new ContractValidationError("projectId, filename, and contentType are required");
  }
  if (body.sizeBytes === undefined || body.sizeBytes === null || body.sizeBytes === "") {
    throw new ContractValidationError("sizeBytes is required");
  }
  const sizeBytes = intInRange(body.sizeBytes, 0, 1, maxAttachmentSizeBytes);
  const filename = body.filename.trim();
  const contentType = body.contentType.trim();
  if (filename.length > 255 || /[\u0000-\u001f\u007f]/.test(filename)) {
    throw new ContractValidationError("filename must be at most 255 characters and contain no control characters");
  }
  if (contentType.length > 255 || /[\u0000-\u001f\u007f]/.test(contentType) || !/^[^\s/;]+\/[^\s/;]+(?:\s*;\s*[^\r\n]+)?$/.test(contentType)) {
    throw new ContractValidationError("contentType must be a valid media type");
  }
  if (typeof body.checksumSha256 !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(body.checksumSha256)) {
    throw new ContractValidationError("checksumSha256 must be a base64-encoded SHA-256 digest");
  }
  return {
    projectId: body.projectId.trim(),
    workItemId: typeof body.workItemId === "string" && body.workItemId ? body.workItemId.trim() : undefined,
    name: typeof body.name === "string" && body.name ? body.name.trim() : filename,
    filename,
    contentType,
    checksumSha256: body.checksumSha256,
    sizeBytes,
    category: typeof body.category === "string" && body.category ? enumValue(documentCategories, body.category) : "other",
    description: typeof body.description === "string" ? body.description.trim() : "",
    tags: Array.isArray(body.tags) ? body.tags.filter(isNonEmptyString).map((tag) => tag.trim()) : []
  };
}

/**
 * @param {unknown} body
 */
export function parseDocumentFinalizeInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.documentId) || !isNonEmptyString(body.projectId)) {
    throw new ContractValidationError("documentId and projectId are required");
  }
  return {
    documentId: body.documentId.trim(),
    projectId: body.projectId.trim()
  };
}

/**
 * @param {unknown} body
 */
export function parseDocumentPatchInput(body) {
  if (!isObject(body)) throw new ContractValidationError("Document patch body is required");
  if (body.version === undefined) throw new ContractValidationError("Document version is required");
  return {
    name: typeof body.name === "string" && body.name ? body.name.trim() : undefined,
    category: typeof body.category === "string" && body.category ? enumValue(documentCategories, body.category) : undefined,
    description: typeof body.description === "string" ? body.description.trim() : undefined,
    status: typeof body.status === "string" && body.status ? enumValue(documentStatuses, body.status) : undefined,
    workItemId: typeof body.workItemId === "string" ? body.workItemId.trim() : undefined,
    tags: Array.isArray(body.tags) ? body.tags.filter(isNonEmptyString).map((tag) => tag.trim()) : undefined,
    version: body.version === undefined ? undefined : intInRange(body.version, 0, 0, 1000000)
  };
}

/**
 * Project content uses one versioned model for hierarchical wiki pages,
 * collaboratively edited documents, news posts, and forum topics. Every
 * mutation produces an immutable revision in the repository.
 * @param {unknown} body
 */
export function parseProjectContentInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.projectId) || !isNonEmptyString(body.title)) {
    throw new ContractValidationError("projectId and title are required");
  }
  const bodyText = typeof body.body === "string" ? body.body.trim() : "";
  if (bodyText.length > 100000) throw new ContractValidationError("body must be at most 100000 characters");
  return {
    projectId: body.projectId.trim(),
    kind: enumValue(projectContentKinds, body.kind ?? "wiki-page"),
    title: body.title.trim().slice(0, 240),
    body: bodyText,
    format: typeof body.format === "string" ? enumValue(["plain", "markdown"], body.format) : "markdown",
    status: typeof body.status === "string" ? enumValue(projectContentStatuses, body.status) : "draft",
    parentId: typeof body.parentId === "string" && body.parentId.trim() ? body.parentId.trim().slice(0, 128) : undefined,
    tags: stringList(body.tags),
    pinned: Boolean(body.pinned)
  };
}

/** @param {unknown} body */
export function parseProjectContentPatchInput(body) {
  if (!isObject(body) || body.version === undefined) throw new ContractValidationError("version is required");
  const patch = {
    version: intInRange(body.version, 0, 1, 1000000),
    title: typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 240) : undefined,
    body: typeof body.body === "string" ? body.body.trim() : undefined,
    format: typeof body.format === "string" ? enumValue(["plain", "markdown"], body.format) : undefined,
    status: typeof body.status === "string" ? enumValue(projectContentStatuses, body.status) : undefined,
    parentId: typeof body.parentId === "string" ? body.parentId.trim().slice(0, 128) : undefined,
    tags: body.tags === undefined ? undefined : stringList(body.tags),
    pinned: body.pinned === undefined ? undefined : Boolean(body.pinned)
  };
  if (typeof patch.body === "string" && patch.body.length > 100000) {
    throw new ContractValidationError("body must be at most 100000 characters");
  }
  if (!Object.entries(patch).some(([key, value]) => key !== "version" && value !== undefined)) {
    throw new ContractValidationError("Content patch must include a field to update");
  }
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

/** @param {unknown} value @param {string} name */
function dateList(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 366) throw new ContractValidationError(`${name} must be an array with at most 366 entries`);
  const values = value.map((item) => {
    if (!isDateOnly(item)) throw new ContractValidationError(`${name} must contain YYYY-MM-DD dates`);
    return item;
  });
  return [...new Set(values)].sort();
}

/** @param {unknown} value */
function weekdayList(value) {
  if (value === undefined) return [1, 2, 3, 4, 5];
  if (!Array.isArray(value) || value.length < 1 || value.length > 7) {
    throw new ContractValidationError("workingDays must contain from 1 to 7 weekdays");
  }
  const days = value.map((item) => intInRange(item, 0, 0, 6));
  if (new Set(days).size !== days.length) throw new ContractValidationError("workingDays must be unique");
  return days.sort();
}

/** @param {unknown} body */
export function parsePlanningResourceInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.projectId) || !isNonEmptyString(body.name)) {
    throw new ContractValidationError("projectId and name are required");
  }
  const startDate = body.startDate === undefined || body.startDate === "" ? undefined : body.startDate;
  const endDate = body.endDate === undefined || body.endDate === "" ? undefined : body.endDate;
  if (startDate && !isDateOnly(startDate)) throw new ContractValidationError("startDate must be YYYY-MM-DD");
  if (endDate && !isDateOnly(endDate)) throw new ContractValidationError("endDate must be YYYY-MM-DD");
  if (startDate && endDate && endDate < startDate) throw new ContractValidationError("endDate must not be before startDate");
  const kind = enumValue(planningResourceKinds, body.kind);
  return {
    projectId: body.projectId.trim(),
    kind,
    name: body.name.trim().slice(0, 160),
    description: typeof body.description === "string" ? body.description.trim().slice(0, 10000) : "",
    status: typeof body.status === "string" ? enumValue(planningResourceStatuses, body.status) : "planned",
    startDate,
    endDate,
    goal: typeof body.goal === "string" ? body.goal.trim().slice(0, 2000) : "",
    sharedProjectIds: stringList(body.sharedProjectIds),
    capacityPoints: intInRange(body.capacityPoints, 0, 0, 100000),
    workingDays: kind === "work-calendar" ? weekdayList(body.workingDays) : undefined,
    holidays: kind === "work-calendar" ? dateList(body.holidays, "holidays") : undefined,
    hoursPerDay: kind === "work-calendar" ? intInRange(body.hoursPerDay, 8, 1, 24) : undefined,
    boardDimension: kind === "board" ? enumValue(boardDimensions, body.boardDimension ?? "status") : undefined,
    boardEditorIds: kind === "board" ? stringList(body.boardEditorIds) : undefined,
    default: Boolean(body.default),
    customFields: customFieldRecord(body.customFields)
  };
}

/** @param {unknown} body */
export function parsePlanningResourcePatchInput(body) {
  if (!isObject(body) || body.version === undefined) throw new ContractValidationError("version is required");
  const patch = {
    version: intInRange(body.version, 0, 1, 1000000),
    name: typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 160) : undefined,
    description: typeof body.description === "string" ? body.description.trim().slice(0, 10000) : undefined,
    status: typeof body.status === "string" ? enumValue(planningResourceStatuses, body.status) : undefined,
    startDate: body.startDate === "" ? "" : body.startDate === undefined ? undefined : isDateOnly(body.startDate) ? body.startDate : undefined,
    endDate: body.endDate === "" ? "" : body.endDate === undefined ? undefined : isDateOnly(body.endDate) ? body.endDate : undefined,
    goal: typeof body.goal === "string" ? body.goal.trim().slice(0, 2000) : undefined,
    sharedProjectIds: body.sharedProjectIds === undefined ? undefined : stringList(body.sharedProjectIds),
    capacityPoints: body.capacityPoints === undefined ? undefined : intInRange(body.capacityPoints, 0, 0, 100000),
    workingDays: body.workingDays === undefined ? undefined : weekdayList(body.workingDays),
    holidays: body.holidays === undefined ? undefined : dateList(body.holidays, "holidays"),
    hoursPerDay: body.hoursPerDay === undefined ? undefined : intInRange(body.hoursPerDay, 8, 1, 24),
    boardDimension: body.boardDimension === undefined ? undefined : enumValue(boardDimensions, body.boardDimension),
    boardEditorIds: body.boardEditorIds === undefined ? undefined : stringList(body.boardEditorIds),
    default: body.default === undefined ? undefined : Boolean(body.default),
    customFields: body.customFields === undefined ? undefined : customFieldRecord(body.customFields)
  };
  if (body.startDate !== undefined && patch.startDate === undefined) throw new ContractValidationError("startDate must be YYYY-MM-DD");
  if (body.endDate !== undefined && patch.endDate === undefined) throw new ContractValidationError("endDate must be YYYY-MM-DD");
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

const capabilitySections = Object.freeze([
  "dashboard",
  "lifecycle",
  "priorities",
  "timeEntryActivities",
  "customFields",
  "forms",
  "customActions",
  "groups",
  "departments",
  "customRoles",
  "finance",
  "resources",
  "branding",
  "authentication",
  "notifications",
  "webhooks",
  "repositories",
  "connectors",
  "externalSharing",
  "outboundLinks",
  "security",
  "scim",
  "mcp",
  "work"
]);

const secretProperty = /^(password|secret|token|privateKey|clientSecret|bindPassword)$/i;

/** @param {unknown} value @param {string} path @param {number} depth @returns {any} */
function safeCapabilityValue(value, path, depth = 0) {
  if (depth > 8) throw new ContractValidationError(`${path} is nested too deeply`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ContractValidationError(`${path} must contain finite numbers`);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 20000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      throw new ContractValidationError(`${path} contains invalid text`);
    }
    return value.trim();
  }
  if (Array.isArray(value)) {
    if (value.length > 500) throw new ContractValidationError(`${path} must contain at most 500 entries`);
    return value.map((item, index) => safeCapabilityValue(item, `${path}[${index}]`, depth + 1));
  }
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (entries.length > 200) throw new ContractValidationError(`${path} must contain at most 200 properties`);
    return Object.fromEntries(entries.map(([key, item]) => {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) {
        throw new ContractValidationError(`${path} contains an invalid property name`);
      }
      if (secretProperty.test(key)) throw new ContractValidationError(`${path}.${key} must use a credential reference or one-way hash instead of a secret`);
      return [key, safeCapabilityValue(item, `${path}.${key}`, depth + 1)];
    }));
  }
  throw new ContractValidationError(`${path} contains an unsupported value`);
}

/** @param {unknown} value @param {string} name */
function assertCapabilityIds(value, name) {
  if (!Array.isArray(value)) throw new ContractValidationError(`${name} must be an array`);
  const ids = value.map((item, index) => {
    if (!isObject(item) || !isNonEmptyString(item.id)) throw new ContractValidationError(`${name}[${index}].id is required`);
    return item.id;
  });
  if (new Set(ids).size !== ids.length) throw new ContractValidationError(`${name} IDs must be unique`);
}

/** @param {unknown} body */
export function parseWorkspaceCapabilitiesInput(body) {
  if (!isObject(body) || body.version === undefined) throw new ContractValidationError("Capability version is required");
  if (body.schemaVersion !== undefined && Number(body.schemaVersion) !== workspaceCapabilitiesSchemaVersion) {
    throw new ContractValidationError(`Capability schemaVersion must be ${workspaceCapabilitiesSchemaVersion}`);
  }
  /** @type {any} */
  const parsed = {
    schemaVersion: workspaceCapabilitiesSchemaVersion,
    version: intInRange(body.version, 0, 1, 1000000),
    ...Object.fromEntries(capabilitySections.map((section) => [
      section,
      safeCapabilityValue(body[section] ?? /** @type {Record<string, any>} */ (defaultWorkspaceCapabilities)[section], section)
    ]))
  };
  const size = new TextEncoder().encode(JSON.stringify(parsed)).byteLength;
  if (size > 128 * 1024) throw new ContractValidationError("Workspace capabilities must be at most 128 KiB");
  for (const name of ["priorities", "timeEntryActivities", "customFields", "forms", "customActions", "groups", "departments", "customRoles", "webhooks", "repositories", "connectors"]) {
    assertCapabilityIds(parsed[name], name);
  }
  const capabilityIdPattern = /^[a-z][a-z0-9-]{0,47}$/;
  if (parsed.priorities.some((/** @type {any} */ priority) => !capabilityIdPattern.test(priority.id) || !isNonEmptyString(priority.name))) {
    throw new ContractValidationError("priorities require stable IDs and names");
  }
  if (parsed.timeEntryActivities.some((/** @type {any} */ activity) => !capabilityIdPattern.test(activity.id) || !isNonEmptyString(activity.name))) {
    throw new ContractValidationError("timeEntryActivities require stable IDs and names");
  }
  const fieldTypes = new Set(["string", "long-text", "link", "integer", "decimal", "boolean", "date", "select", "multi-select", "user", "version", "hierarchy", "weighted", "calculated"]);
  if ((/** @type {Array<any>} */ (parsed.customFields)).some((field) => !capabilityIdPattern.test(field.id) || !fieldTypes.has(field.type) || field.entityType !== undefined && !customFieldEntityTypes.includes(field.entityType))) throw new ContractValidationError("customFields contains an unsupported ID, type, or entityType");
  const knownFormFields = new Set([
    "projectId", "title", "description", "acceptanceCriteria", "type", "status", "priority", "assigneeId", "teamId", "accountableId", "reporterId",
    "startDate", "dueDate", "estimateMinutes", "remainingMinutes", "percentComplete", "effortPoints", "schedulingMode", "parentId", "versionId", "versionName",
    "sprintId", "category", "tags", "labels", "watcherIds", "blockedBy", "relatedIds", "relations", "periodId", "periodName", "periodGoal", "intakeGroup",
    "milestoneName", "workflowStep", "workstream"
  ]);
  const configuredFieldIds = new Set(parsed.customFields.map((/** @type {any} */ field) => field.id));
  for (const form of parsed.forms) {
    const fields = form.fields ?? form.fieldIds ?? [];
    if (!Array.isArray(fields)) throw new ContractValidationError("forms fields must be arrays");
    for (const entry of fields) {
      const fieldId = typeof entry === "string" ? entry : entry?.id ?? entry?.fieldId ?? entry?.name;
      if (!isNonEmptyString(fieldId) || !knownFormFields.has(fieldId) && !configuredFieldIds.has(fieldId)) {
        throw new ContractValidationError("forms contains an unknown field");
      }
    }
  }
  const knownPermissions = new Set(Object.values(permissions));
  if ((/** @type {Array<any>} */ (parsed.customRoles)).some((role) => !Array.isArray(role.permissions) || role.permissions.some((/** @type {any} */ permission) => !knownPermissions.has(permission)))) {
    throw new ContractValidationError("customRoles must contain known permissions");
  }
  if (!/^[A-Z]{3}$/.test(String(parsed.finance.currency ?? ""))) throw new ContractValidationError("finance.currency must be an ISO-style three-letter code");
  if (!["allow", "warn", "capture", "block"].includes(parsed.outboundLinks.policy)) throw new ContractValidationError("outboundLinks.policy is invalid");
  if (!["required", "optional", "disabled"].includes(parsed.security.malwareScanning)) throw new ContractValidationError("security.malwareScanning is invalid");
  if (parsed.security.malwareScanning === "required") {
    if (!/^[a-f0-9]{64}$/i.test(String(parsed.security.scannerCredentialHash ?? ""))) throw new ContractValidationError("Required malware scanning needs a SHA-256 scanner credential hash");
    const scannerWebhook = parsed.webhooks.find((/** @type {any} */ webhook) => webhook.id === parsed.security.scannerWebhookId);
    const scannerEvents = scannerWebhook?.eventTypes ?? scannerWebhook?.events ?? [];
    if (!scannerWebhook || scannerWebhook.enabled === false || !scannerEvents.includes("document.scan-requested") && !scannerEvents.includes("*")) throw new ContractValidationError("Required malware scanning needs an enabled document.scan-requested webhook");
  }
  for (const webhook of parsed.webhooks) {
    if (!isNonEmptyString(webhook.url) || !isPublicHttpsUrl(webhook.url)) throw new ContractValidationError("webhook URLs must use public HTTPS endpoints without embedded credentials");
    const eventTypes = webhook.eventTypes ?? webhook.events ?? [];
    if (!Array.isArray(eventTypes) || eventTypes.length > 100 || eventTypes.some((eventType) => !isNonEmptyString(eventType) || eventType.length > 128)) throw new ContractValidationError("webhook eventTypes must be a bounded string array");
  }
  assertCapabilityIds(parsed.lifecycle.phases, "lifecycle.phases");
  const gateIds = (/** @type {Array<any>} */ (parsed.lifecycle.phases)).flatMap((phase) => (phase.gates ?? []).map((/** @type {any} */ gate) => typeof gate === "string" ? gate : gate.id));
  if (gateIds.some((/** @type {any} */ id) => !isNonEmptyString(id)) || new Set(gateIds).size !== gateIds.length) throw new ContractValidationError("Lifecycle gate IDs must be present and unique");
  const connectorTypes = new Set(["github", "gitlab", "nextcloud", "onedrive", "sharepoint", "xwiki", "opendesk", "jira", "git", "svn", "generic"]);
  for (const connector of parsed.connectors) {
    if (!connectorTypes.has(connector.type)) throw new ContractValidationError("connectors contains an unsupported type");
    if (connector.type === "github") {
      if (connector.resourceKind !== undefined && !["projects", "pull-requests"].includes(connector.resourceKind)) throw new ContractValidationError("GitHub resourceKind must be projects or pull-requests");
      if (connector.githubProjectId !== undefined && (typeof connector.githubProjectId !== "string" || !/^[A-Za-z0-9_=-]{1,256}$/.test(connector.githubProjectId))) throw new ContractValidationError("githubProjectId must be an opaque GitHub project node identifier");
      if (connector.githubProjectVisibility !== undefined && !["public", "private"].includes(connector.githubProjectVisibility)) throw new ContractValidationError("githubProjectVisibility must be public or private");
      if (connector.includeProjectDrafts !== undefined && typeof connector.includeProjectDrafts !== "boolean") throw new ContractValidationError("includeProjectDrafts must be a boolean");
      if (connector.githubStatusField !== undefined && (typeof connector.githubStatusField !== "string" || !connector.githubStatusField.trim() || connector.githubStatusField.length > 160)) throw new ContractValidationError("githubStatusField must be a bounded nonempty field name");
      if (connector.sharedRepositories !== undefined) {
        const repositories = connector.sharedRepositories;
        if (!Array.isArray(repositories) || repositories.length > 10
          || repositories.length && (connector.resourceKind !== "projects" || connector.githubProjectVisibility !== "private")
          || repositories.some((/** @type {unknown} */ value) => typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) || value.split("/").some(part => [".", ".."].includes(part)))
          || new Set(repositories.map((/** @type {string} */ value) => value.toLowerCase())).size !== repositories.length) throw new ContractValidationError("sharedRepositories must be a distinct bounded repository allowlist on a private Projects board");
      }
      if (connector.resourceKind === "projects" && (!connector.githubProjectId || typeof connector.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(connector.repository) || String(connector.repository).split("/").some(part => [".", ".."].includes(part)))) throw new ContractValidationError("GitHub Projects requires githubProjectId and an exact owner/repository scope");
      if (connector.resourceKind === "projects" && !["public", "private"].includes(connector.githubProjectVisibility)) throw new ContractValidationError("GitHub Projects requires githubProjectVisibility");
      if (connector.resourceKind === "projects" && (typeof connector.projectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(connector.projectId))) throw new ContractValidationError("GitHub Projects requires a stable Teamspaces projectId");
    }
    if (connector.baseUrl && !isPublicHttpsUrl(connector.baseUrl)) throw new ContractValidationError("connector baseUrl values must use public HTTPS without embedded credentials");
    for (const urlField of ["apiBaseUrl", "tokenEndpoint"]) {
      if (connector[urlField] && !isPublicHttpsUrl(connector[urlField])) throw new ContractValidationError(`connector ${urlField} values must use public HTTPS without embedded credentials`);
    }
    if (connector.credentialReference !== undefined && (!isNonEmptyString(connector.credentialReference) || !/^[A-Za-z0-9._:/-]{1,240}$/.test(connector.credentialReference))) throw new ContractValidationError("connector credentialReference values must be stable external reference names");
    if (connector.authMode !== undefined && !["service", "oidc-token-exchange"].includes(connector.authMode)) throw new ContractValidationError("connector authMode is unsupported");
    if (connector.referencePattern !== undefined && (typeof connector.referencePattern !== "string" || connector.referencePattern.length > 500)) throw new ContractValidationError("connector referencePattern must be at most 500 characters");
    if (connector.managedPermissionDomains !== undefined && (!Array.isArray(connector.managedPermissionDomains) || connector.managedPermissionDomains.length > 100 || connector.managedPermissionDomains.some((/** @type {unknown} */ domain) => typeof domain !== "string" || !/^[a-z0-9.-]+$/i.test(domain)))) throw new ContractValidationError("connector managedPermissionDomains is invalid");
    if (connector.managedResources !== undefined && (!Array.isArray(connector.managedResources) || connector.managedResources.length > 50 || connector.managedResources.some((/** @type {any} */ resource) => !isObject(resource) || !isNonEmptyString(resource.projectId) || resource.projectId.length > 128 || !isNonEmptyString(resource.resourceId) || resource.resourceId.length > 1000))) throw new ContractValidationError("connector managedResources must contain bounded projectId/resourceId pairs");
  }
  for (const repository of parsed.repositories) {
    if (repository.baseUrl && !isPublicHttpsUrl(repository.baseUrl)) throw new ContractValidationError("repository baseUrl values must use public HTTPS without embedded credentials");
    if (repository.type && !["git", "svn"].includes(repository.type)) throw new ContractValidationError("repository type must be git or svn");
  }
  for (const name of ["logoUrl", "faviconUrl", "touchIconUrl"]) {
    if (parsed.branding[name] && !isPublicHttpsUrl(parsed.branding[name])) throw new ContractValidationError(`branding.${name} must use public HTTPS without embedded credentials`);
  }
  for (const providerType of ["oidcProviders", "samlProviders"]) {
    const providers = parsed.authentication[providerType];
    if (!Array.isArray(providers)) throw new ContractValidationError(`authentication.${providerType} must be an array`);
    assertCapabilityIds(providers, `authentication.${providerType}`);
    for (const provider of providers) {
      for (const name of ["issuerUrl", "metadataUrl", "discoveryUrl"]) {
        if (provider[name] && !isPublicHttpsUrl(provider[name])) throw new ContractValidationError(`authentication.${providerType}.${name} must use public HTTPS without embedded credentials`);
      }
    }
  }
  if (!isObject(parsed.authentication.ldap) || typeof parsed.authentication.ldap.enabled !== "boolean") throw new ContractValidationError("authentication.ldap is invalid");
  if (parsed.authentication.ldap.enabled) {
    const ldap = parsed.authentication.ldap;
    try {
      const host = new URL(String(ldap.host ?? ""));
      if (host.protocol !== "ldaps:" || host.username || host.password || host.pathname !== "" && host.pathname !== "/" || host.search || host.hash) throw new Error("invalid LDAPS URL");
    } catch {
      throw new ContractValidationError("LDAP must use an ldaps:// host without credentials or a path");
    }
    if (!isNonEmptyString(ldap.baseDn) || !isNonEmptyString(ldap.bindCredentialReference) || !/^[A-Za-z0-9._:/-]{1,240}$/.test(ldap.bindCredentialReference)) throw new ContractValidationError("Enabled LDAP requires baseDn and an external bindCredentialReference");
    for (const name of ["loginAttribute", "emailAttribute", "firstNameAttribute", "lastNameAttribute", "displayNameAttribute", "statusAttribute", "departmentAttribute", "memberOfAttribute", "groupNameAttribute", "groupMemberAttribute"]) {
      if (ldap[name] !== undefined && !/^[A-Za-z][A-Za-z0-9.-]{0,127}$/.test(String(ldap[name]))) throw new ContractValidationError(`LDAP ${name} is invalid`);
    }
    for (const name of ["userFilter", "groupFilter"]) {
      if (ldap[name] !== undefined && (typeof ldap[name] !== "string" || ldap[name].length > 1000 || !ldap[name].startsWith("(") || !ldap[name].endsWith(")"))) throw new ContractValidationError(`LDAP ${name} is invalid`);
    }
    if (ldap.syncGroups && !isNonEmptyString(ldap.groupBaseDn)) throw new ContractValidationError("LDAP group synchronization requires groupBaseDn");
    if (ldap.defaultRole !== undefined && !Object.values(roles).includes(ldap.defaultRole) && !String(ldap.defaultRole).startsWith("custom:")) throw new ContractValidationError("LDAP defaultRole is invalid");
    if (ldap.sessionLifetimeSeconds !== undefined) intInRange(ldap.sessionLifetimeSeconds, 300, 8 * 3600);
  }
  if (!isObject(parsed.scim) || typeof parsed.scim.enabled !== "boolean" || parsed.scim.enabled && !/^[a-f0-9]{64}$/i.test(String(parsed.scim.bearerCredentialHash ?? ""))) throw new ContractValidationError("Enabled SCIM requires a SHA-256 bearer credential hash");
  if (!isObject(parsed.mcp) || typeof parsed.mcp.enabled !== "boolean" || typeof parsed.mcp.readOnly !== "boolean") throw new ContractValidationError("mcp configuration is invalid");
  if (!["none", "daily", "weekly"].includes(parsed.notifications.emailDigest)) throw new ContractValidationError("notifications.emailDigest is invalid");
  const tableColumns = parsed.work.tableColumns ?? [];
  const coreColumns = new Set(["task", "type", "status", "priority", "period", "effort", "relations", "assignee", "accountable", "start", "due", "remaining", "progress", "category", "version", "project"]);
  if (!Array.isArray(tableColumns) || tableColumns.some((column) => !coreColumns.has(column) && !/^custom:[a-z][a-z0-9-]{0,47}$/.test(column))) throw new ContractValidationError("work.tableColumns contains an unsupported column");
  if (!Array.isArray(parsed.work.highlightRules ?? []) || (parsed.work.highlightRules ?? []).some((/** @type {any} */ rule) => !["equals", "contains", "before", "after"].includes(rule.operator ?? "equals"))) throw new ContractValidationError("work.highlightRules contains an unsupported operator");
  return parsed;
}

/** @param {unknown} body */
export function parseIntegrationLinkInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.projectId) || !isNonEmptyString(body.connectorId) || !isNonEmptyString(body.externalId) || !isNonEmptyString(body.title)) {
    throw new ContractValidationError("projectId, connectorId, externalId, and title are required");
  }
  let externalUrl;
  if (isNonEmptyString(body.externalUrl)) {
    try {
      externalUrl = new URL(body.externalUrl);
      if (externalUrl.protocol !== "https:" || externalUrl.username || externalUrl.password) throw new Error("unsafe URL");
    } catch {
      throw new ContractValidationError("externalUrl must use HTTPS without embedded credentials");
    }
  }
  return {
    projectId: body.projectId.trim(),
    connectorId: body.connectorId.trim().slice(0, 128),
    workItemId: typeof body.workItemId === "string" && body.workItemId.trim() ? body.workItemId.trim().slice(0, 128) : undefined,
    externalId: body.externalId.trim().slice(0, 240),
    externalUrl: externalUrl?.toString(),
    title: body.title.trim().slice(0, 240),
    linkType: typeof body.linkType === "string" ? enumValue(["development", "file", "folder", "repository", "issue", "wiki", "collaboration"], body.linkType) : "development",
    metadata: safeCapabilityValue(body.metadata ?? {}, "metadata")
  };
}

/** @param {unknown} body */
export function parseIntegrationEventInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.eventType)) throw new ContractValidationError("eventType is required");
  return {
    projectId: typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : undefined,
    workItemId: typeof body.workItemId === "string" && body.workItemId.trim() ? body.workItemId.trim() : undefined,
    linkId: typeof body.linkId === "string" && body.linkId.trim() ? body.linkId.trim() : undefined,
    eventType: body.eventType.trim().slice(0, 128),
    externalId: typeof body.externalId === "string" ? body.externalId.trim().slice(0, 240) : undefined,
    summary: typeof body.summary === "string" ? body.summary.trim().slice(0, 2000) : body.eventType.trim(),
    payload: safeCapabilityValue(body.payload ?? {}, "payload")
  };
}

/** @param {unknown} body */
export function parseIntegrationResourceInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.projectId) || !isNonEmptyString(body.title)) throw new ContractValidationError("projectId and title are required");
  return {
    projectId: body.projectId.trim().slice(0, 128),
    workItemId: typeof body.workItemId === "string" && body.workItemId.trim() ? body.workItemId.trim().slice(0, 128) : undefined,
    title: body.title.trim().slice(0, 240),
    content: typeof body.content === "string" ? body.content.slice(0, 100000) : "",
    space: typeof body.space === "string" && body.space.trim() ? body.space.trim().slice(0, 240) : undefined,
    page: typeof body.page === "string" && body.page.trim() ? body.page.trim().slice(0, 240) : undefined,
    syntax: typeof body.syntax === "string" && body.syntax.trim() ? body.syntax.trim().slice(0, 64) : undefined
  };
}

/** @param {unknown} body */
export function parseIntegrationPermissionSyncInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.projectId) || !isNonEmptyString(body.resourceId)) throw new ContractValidationError("projectId and resourceId are required");
  return {projectId: body.projectId.trim().slice(0, 128), resourceId: body.resourceId.trim().slice(0, 1000)};
}

/** @param {unknown} body */
export function parseExternalShareInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.projectId) || !isNonEmptyString(body.workItemId) || !isNonEmptyString(body.targetType) || !isNonEmptyString(body.target)) {
    throw new ContractValidationError("projectId, workItemId, targetType, and target are required");
  }
  const expiresAt = typeof body.expiresAt === "string" && body.expiresAt ? new Date(body.expiresAt) : undefined;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new ContractValidationError("expiresAt must be a timestamp");
  return {
    projectId: body.projectId.trim(),
    workItemId: body.workItemId.trim(),
    targetType: enumValue(["email", "user", "group"], body.targetType),
    target: body.target.trim().toLowerCase().slice(0, 320),
    permissions: stringList(body.permissions).filter((permission) => ["read", "comment"].includes(permission)),
    expiresAt: expiresAt?.toISOString()
  };
}

/** @param {unknown} body */
export function parseOutboundLinkInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.url)) throw new ContractValidationError("url is required");
  let url;
  try {
    url = new URL(body.url);
    if (url.protocol !== "https:") throw new Error("not HTTPS");
  } catch {
    throw new ContractValidationError("url must use HTTPS");
  }
  return {url: url.toString(), sourceType: typeof body.sourceType === "string" ? body.sourceType.trim().slice(0, 64) : "unknown", sourceId: typeof body.sourceId === "string" ? body.sourceId.trim().slice(0, 128) : undefined, confirmed: Boolean(body.confirmed)};
}

/** @param {unknown} body */
export function parseDirectorySyncInput(body) {
  if (!isObject(body) || !Array.isArray(body.users) || body.users.length > 500) throw new ContractValidationError("users must be an array with at most 500 entries");
  return {
    source: typeof body.source === "string" ? enumValue(["ldap", "scim"], body.source) : "ldap",
    users: body.users.map((user, index) => {
      if (!isObject(user) || !isNonEmptyString(user.email)) throw new ContractValidationError(`users[${index}].email is required`);
      return {externalId: typeof user.externalId === "string" ? user.externalId.trim().slice(0, 1000) : undefined, email: user.email.trim().toLowerCase(), name: typeof user.name === "string" && user.name.trim() ? user.name.trim() : user.email.trim(), role: typeof user.role === "string" ? user.role : roles.viewer, status: typeof user.status === "string" ? enumValue(["active", "disabled"], user.status) : "active", groupIds: stringList(user.groupIds), department: typeof user.department === "string" && user.department.trim() ? user.department.trim().slice(0, 160) : undefined, customFields: user.customFields === undefined ? undefined : customFieldRecord(user.customFields)};
    })
  };
}

/** @param {unknown} body */
export function parseJiraImportInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.projectId) || !Array.isArray(body.issues) || body.issues.length < 1 || body.issues.length > 100) {
    throw new ContractValidationError("projectId and from 1 to 100 issues are required");
  }
  return {
    projectId: body.projectId.trim(),
    connectorId: typeof body.connectorId === "string" && body.connectorId.trim() ? body.connectorId.trim() : "jira",
    issues: body.issues.map((issue, index) => {
      if (!isObject(issue) || !isNonEmptyString(issue.key) || !isNonEmptyString(issue.summary)) throw new ContractValidationError(`issues[${index}] requires key and summary`);
      let externalUrl;
      if (typeof issue.externalUrl === "string" && issue.externalUrl) {
        try {
          const parsed = new URL(issue.externalUrl);
          if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("unsafe URL");
          externalUrl = parsed.toString();
        } catch {
          throw new ContractValidationError(`issues[${index}].externalUrl must use HTTPS without embedded credentials`);
        }
      }
      return {key: issue.key.trim().slice(0, 64), summary: issue.summary.trim().slice(0, 240), description: typeof issue.description === "string" ? issue.description.trim().slice(0, 20000) : "", type: typeof issue.type === "string" ? issue.type.trim().toLowerCase() : undefined, status: typeof issue.status === "string" ? issue.status.trim().toLowerCase().replaceAll(" ", "-") : undefined, assigneeId: typeof issue.assigneeId === "string" ? issue.assigneeId.trim() : undefined, priority: typeof issue.priority === "string" && priorities.includes(issue.priority) ? issue.priority : "medium", labels: stringList(issue.labels), externalUrl};
    })
  };
}

/** @param {unknown} body */
export function parseProjectInitiationInput(body) {
  if (!isObject(body) || body.version === undefined) throw new ContractValidationError("version is required");
  return {
    version: intInRange(body.version, 0, 1, 1000000),
    requestData: safeCapabilityValue(body.requestData ?? {}, "requestData"),
    templateProjectId: typeof body.templateProjectId === "string" && body.templateProjectId.trim() ? body.templateProjectId.trim() : undefined,
    note: typeof body.note === "string" ? body.note.trim().slice(0, 10000) : ""
  };
}

/** @param {unknown} body */
export function parseProjectInitiationReviewInput(body) {
  if (!isObject(body) || body.version === undefined || !isNonEmptyString(body.decision)) throw new ContractValidationError("version and decision are required");
  return {
    version: intInRange(body.version, 0, 1, 1000000),
    decision: enumValue(["approved", "rejected", "changes-requested"], body.decision),
    comment: typeof body.comment === "string" ? body.comment.trim().slice(0, 10000) : ""
  };
}

/** @param {unknown} body */
export function parseLifecycleGateApprovalInput(body) {
  if (!isObject(body) || body.version === undefined) throw new ContractValidationError("version is required");
  return {version: intInRange(body.version, 0, 1, 1000000), comment: typeof body.comment === "string" ? body.comment.trim().slice(0, 10000) : ""};
}

/** @param {unknown} body */
export function parseRepositorySnapshotInput(body) {
  if (!isObject(body) || !Array.isArray(body.entries) || body.entries.length > 500) throw new ContractValidationError("entries must be an array with at most 500 repository records");
  return {
    ref: typeof body.ref === "string" && body.ref.trim() ? body.ref.trim().slice(0, 240) : "main",
    revision: typeof body.revision === "string" ? body.revision.trim().slice(0, 240) : "",
    entries: body.entries.map((entry, index) => {
      if (!isObject(entry) || !isNonEmptyString(entry.path) || !isNonEmptyString(entry.type)) throw new ContractValidationError(`entries[${index}] requires path and type`);
      const path = entry.path.trim().replace(/^\/+/, "");
      if (!path || path.length > 1000 || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) throw new ContractValidationError(`entries[${index}].path is invalid`);
      let externalUrl;
      if (typeof entry.externalUrl === "string" && entry.externalUrl) {
        try {
          const parsed = new URL(entry.externalUrl);
          if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("unsafe URL");
          externalUrl = parsed.toString();
        } catch {
          throw new ContractValidationError(`entries[${index}].externalUrl must use HTTPS without embedded credentials`);
        }
      }
      return {path, type: enumValue(["file", "directory", "symlink", "submodule"], entry.type), sizeBytes: entry.sizeBytes === undefined ? undefined : intInRange(entry.sizeBytes, 0, 0, 1000000000000), contentType: typeof entry.contentType === "string" ? entry.contentType.trim().slice(0, 255) : undefined, revision: typeof entry.revision === "string" ? entry.revision.trim().slice(0, 240) : undefined, externalUrl};
    })
  };
}

/** @param {unknown} body */
export function parsePlaceholderInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.name)) throw new ContractValidationError("Placeholder name is required");
  return {
    name: body.name.trim().slice(0, 160),
    weeklyMinutes: intInRange(body.weeklyMinutes, 2400, 0, 10080),
    skills: stringList(body.skills),
    status: typeof body.status === "string" ? enumValue(["active", "disabled"], body.status) : "active",
    projectIds: stringList(body.projectIds),
    customFields: body.customFields === undefined ? undefined : customFieldRecord(body.customFields)
  };
}

/** @param {unknown} body */
export function parseContentOperationsInput(body) {
  if (!isObject(body) || body.version === undefined || !Array.isArray(body.operations) || body.operations.length < 1 || body.operations.length > 100) throw new ContractValidationError("version and from 1 to 100 operations are required");
  return {
    version: intInRange(body.version, 0, 1, 1000000),
    clientId: typeof body.clientId === "string" && body.clientId.trim() ? body.clientId.trim().slice(0, 128) : "unknown-client",
    changeId: typeof body.changeId === "string" && body.changeId.trim() ? body.changeId.trim().slice(0, 128) : `${typeof body.clientId === "string" && body.clientId.trim() ? body.clientId.trim().slice(0, 128) : "unknown-client"}:${Number(body.version)}`,
    operations: body.operations.map((operation, index) => {
      if (!isObject(operation) || !isNonEmptyString(operation.type)) throw new ContractValidationError(`operations[${index}].type is required`);
      const type = enumValue(["insert", "delete"], operation.type);
      return {type, index: intInRange(operation.index, 0, 0, 1000000), text: type === "insert" && typeof operation.text === "string" ? operation.text.slice(0, 20000) : undefined, count: type === "delete" ? intInRange(operation.count, 0, 1, 20000) : undefined};
    })
  };
}

/** @param {unknown} body */
export function parseContentPresenceInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.clientId)) throw new ContractValidationError("clientId is required");
  return {clientId: body.clientId.trim().slice(0, 128), cursor: body.cursor === undefined ? undefined : intInRange(body.cursor, 0, 0, 1000000), selectionEnd: body.selectionEnd === undefined ? undefined : intInRange(body.selectionEnd, 0, 0, 1000000)};
}
