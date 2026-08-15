// @ts-check

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
 * @returns {Record<string, string>}
 */
export function stringRecord(value) {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => isNonEmptyString(key) && (typeof item === "string" || typeof item === "number" || typeof item === "boolean"))
    .slice(0, 20)
    .map(([key, item]) => [key.trim().slice(0, 64), String(item).trim().slice(0, 512)]));
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
  "minutes"
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
  if (!projectIdValue) throw new ContractValidationError("projectId is required");
  return {
    version: meetingQueryVersion,
    projectId: parseMeetingIdentifier(projectIdValue, "projectId"),
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
    minutes: meetingText(body.minutes ?? "", "minutes", 50000)
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
    minutes: body.minutes === undefined ? undefined : meetingText(body.minutes, "minutes", 50000)
  };
  const parsed = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  if (!meetingMutableFields.some((field) => parsed[field] !== undefined)) {
    throw new ContractValidationError("Meeting patch must include a field to update");
  }
  assertMeetingPayloadSize(parsed);
  return parsed;
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
  return {
    userId: typeof body.userId === "string" && body.userId ? body.userId.trim() : undefined,
    email: body.email.trim().toLowerCase(),
    name: typeof body.name === "string" && body.name ? body.name.trim() : body.email.trim().toLowerCase(),
    role: enumValue(Object.values(roles), body.role ?? roles.viewer),
    status: typeof body.status === "string" && body.status ? enumValue(["active", "invited", "disabled"], body.status) : "active",
    projectIds: body.projectIds === undefined ? undefined : stringList(body.projectIds)
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
    locale: typeof body.locale === "string" && body.locale ? body.locale.trim() : undefined
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
    ownerId: typeof body.ownerId === "string" && body.ownerId ? body.ownerId : undefined,
    status: enumValue(projectStatuses, body.status ?? "active"),
    health: enumValue(healthStates, body.health ?? "on-track"),
    priority: enumValue(priorities, body.priority ?? "medium"),
    phase: enumValue(lifecyclePhases, body.phase ?? "Proposed"),
    startDate,
    targetDate,
    percentComplete: intInRange(body.percentComplete, 0, 0, 100),
    tags: stringList(body.tags)
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
    portfolioId: typeof body.portfolioId === "string" && body.portfolioId ? body.portfolioId.trim() : undefined,
    ownerId: typeof body.ownerId === "string" && body.ownerId ? body.ownerId.trim() : undefined,
    status: typeof body.status === "string" && body.status ? enumValue(projectStatuses, body.status) : undefined,
    health: typeof body.health === "string" && body.health ? enumValue(healthStates, body.health) : undefined,
    priority: typeof body.priority === "string" && body.priority ? enumValue(priorities, body.priority) : undefined,
    phase: typeof body.phase === "string" && body.phase ? enumValue(lifecyclePhases, body.phase) : undefined,
    startDate: body.startDate === "" ? "" : isDateOnly(body.startDate) ? body.startDate : undefined,
    targetDate: body.targetDate === "" ? "" : isDateOnly(body.targetDate) ? body.targetDate : undefined,
    percentComplete: body.percentComplete === undefined ? undefined : intInRange(body.percentComplete, 0, 0, 100),
    favorite: body.favorite === undefined ? undefined : Boolean(body.favorite),
    archived: body.archived === undefined ? undefined : Boolean(body.archived),
    tags: body.tags === undefined ? undefined : stringList(body.tags),
    version: body.version === undefined ? undefined : intInRange(body.version, 0, 0, 1000000)
  };
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

/**
 * @param {unknown} body
 */
export function parseWorkItemInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.title)) throw new ContractValidationError("Task title is required");
  return {
    title: body.title.trim(),
    description: typeof body.description === "string" ? body.description.trim() : "",
    type: isNonEmptyString(body.type) ? parseWorkConfigurationId(body.type, "type") : undefined,
    status: isNonEmptyString(body.status) ? parseWorkConfigurationId(body.status, "status") : undefined,
    priority: enumValue(priorities, body.priority ?? "medium"),
    assigneeId: typeof body.assigneeId === "string" && body.assigneeId ? body.assigneeId : undefined,
    reporterId: typeof body.reporterId === "string" && body.reporterId ? body.reporterId : undefined,
    startDate: isDateOnly(body.startDate) ? body.startDate : undefined,
    dueDate: isDateOnly(body.dueDate) ? body.dueDate : undefined,
    estimateMinutes: intInRange(body.estimateMinutes, 0, 0, 100000),
    effortPoints: intInRange(body.effortPoints, 0, 0, 100),
    periodId: typeof body.periodId === "string" && body.periodId ? body.periodId.trim() : undefined,
    periodName: typeof body.periodName === "string" && body.periodName ? body.periodName.trim() : undefined,
    periodGoal: typeof body.periodGoal === "string" && body.periodGoal ? body.periodGoal.trim() : undefined,
    intakeGroup: typeof body.intakeGroup === "string" && body.intakeGroup ? enumValue(intakeGroups, body.intakeGroup) : undefined,
    milestoneName: typeof body.milestoneName === "string" && body.milestoneName ? body.milestoneName.trim() : undefined,
    parentId: typeof body.parentId === "string" && body.parentId ? body.parentId.trim() : undefined,
    blockedBy: stringList(body.blockedBy),
    relatedIds: stringList(body.relatedIds),
    watcherIds: stringList(body.watcherIds),
    acceptanceCriteria: typeof body.acceptanceCriteria === "string" ? body.acceptanceCriteria.trim() : "",
    customFields: stringRecord(body.customFields),
    tags: stringList(body.tags)
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
    priority: typeof body.priority === "string" && body.priority ? enumValue(priorities, body.priority) : undefined,
    assigneeId: typeof body.assigneeId === "string" && body.assigneeId ? body.assigneeId : undefined,
    startDate: isDateOnly(body.startDate) ? body.startDate : undefined,
    dueDate: isDateOnly(body.dueDate) ? body.dueDate : undefined,
    estimateMinutes: body.estimateMinutes === undefined ? undefined : intInRange(body.estimateMinutes, 0, 0, 100000),
    effortPoints: body.effortPoints === undefined ? undefined : intInRange(body.effortPoints, 0, 0, 100),
    periodId: typeof body.periodId === "string" && body.periodId ? body.periodId.trim() : undefined,
    periodName: typeof body.periodName === "string" ? body.periodName.trim() : undefined,
    periodGoal: typeof body.periodGoal === "string" ? body.periodGoal.trim() : undefined,
    intakeGroup: typeof body.intakeGroup === "string" ? (body.intakeGroup ? enumValue(intakeGroups, body.intakeGroup) : "") : undefined,
    milestoneName: typeof body.milestoneName === "string" ? body.milestoneName.trim() : undefined,
    parentId: typeof body.parentId === "string" && body.parentId ? body.parentId.trim() : undefined,
    blockedBy: body.blockedBy === undefined ? undefined : stringList(body.blockedBy),
    relatedIds: body.relatedIds === undefined ? undefined : stringList(body.relatedIds),
    watcherIds: body.watcherIds === undefined ? undefined : stringList(body.watcherIds),
    acceptanceCriteria: typeof body.acceptanceCriteria === "string" ? body.acceptanceCriteria.trim() : undefined,
    customFields: body.customFields === undefined ? undefined : stringRecord(body.customFields),
    tags: body.tags === undefined ? undefined : stringList(body.tags),
    rank: body.rank === undefined ? undefined : intInRange(body.rank, 0, 0, 1000000000),
    version: body.version === undefined ? undefined : intInRange(body.version, 0, 0, 1000000)
  };
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

/**
 * @param {unknown} body
 */
export function parseTimeEntryInput(body) {
  if (!isObject(body) || !isDateOnly(body.entryDate)) throw new ContractValidationError("entryDate must be YYYY-MM-DD");
  const durationMinutes = intInRange(body.durationMinutes, 0, 1, 1440);
  if (!isNonEmptyString(body.projectId) && !isNonEmptyString(body.workItemId)) {
    throw new ContractValidationError("projectId or workItemId is required");
  }
  return {
    projectId: isNonEmptyString(body.projectId) ? body.projectId : undefined,
    workItemId: isNonEmptyString(body.workItemId) ? body.workItemId : undefined,
    entryDate: body.entryDate,
    durationMinutes,
    description: typeof body.description === "string" ? body.description.trim() : "",
    billable: Boolean(body.billable)
  };
}

/**
 * @param {unknown} body
 */
export function parseActivityInput(body) {
  if (!isObject(body) || !isNonEmptyString(body.projectId) || !isNonEmptyString(body.summary)) {
    throw new ContractValidationError("projectId and summary are required");
  }
  const entityType = typeof body.entityType === "string" && body.entityType ? enumValue(["project", "work-item", "document", "time-entry"], body.entityType) : "project";
  return {
    projectId: body.projectId.trim(),
    entityType,
    entityId: typeof body.entityId === "string" && body.entityId ? body.entityId.trim() : body.projectId.trim(),
    summary: body.summary.trim().slice(0, 1000)
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
    filters: isObject(body.filters) ? body.filters : {}
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
