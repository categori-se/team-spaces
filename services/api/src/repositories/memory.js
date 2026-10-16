// @ts-nocheck

import {createHash} from "node:crypto";
import {buildPlanningSummary, buildPortfolioSummary, newId, reverseTimestamp} from "@teamspaces/domain";
import {demoMembership, demoUser, demoWorkspace, seedData} from "@teamspaces/test-fixtures";
import {
  assertWorkConfigurationUpdate,
  assertWorkItemConfiguration,
  assertWorkQueryConfiguration,
  assertMeetingPayloadSize,
  assertMeetingUpdate,
  defaultWorkConfiguration,
  defaultWorkspaceCapabilities,
  maxMeetingParticipants,
  parseWorkConfigurationInput,
  parseWorkspaceCapabilitiesInput,
  roles
} from "@teamspaces/contracts";
import {ConflictError, ForbiddenError, NotFoundError, ValidationError} from "../errors.js";
import {
  compareWorkItems,
  decodeWorkCursor,
  encodeWorkCursor,
  isAfterMemoryWorkCursor,
  matchesWorkQuery,
  memoryWorkCursorKey,
  selectWorkQuerySource,
  workPageInfo
} from "./work-query.js";
import {
  compareMeetings,
  decodeMeetingCursor,
  encodeMeetingCursor,
  isAfterMemoryMeetingCursor,
  meetingPageInfo,
  memoryMeetingCursorKey
} from "./meeting-query.js";
import {meetingCreateKeyHash, meetingCreateRequestHash} from "./meeting-integrity.js";
import {calculateProjectSchedule, compareProjectBaseline, compareProjectHistory, workBaselineSnapshot} from "./scheduling.js";
import {automaticWorkSubject, buildCostReport, buildResourcePlan, configuredCustomAction, securityBadge, validateAndCalculateCustomFields, validateCapabilityCustomFieldValues} from "./capability-engine.js";
import {publicDocument} from "./document-security.js";
import {meetingICalendar, meetingPdfBase64} from "./meeting-exports.js";
import {effectiveNotificationPreferences, workNotificationRecipients} from "./notifications.js";
import {mergeContentOperations} from "./content-collaboration.js";
import {createProviderIntegrationRuntime} from "../integrations/provider-adapters.js";
import {assertCoordinationProjectUpdate, assertCoordinationReferences, assertCoordinationUpdate, coordinationDigest, coordinationProjectId, coordinationTaskId, replayCoordinationCreate, resetCopiedCoordination} from "./coordination-integrity.js";
import {prepareCoordinationRegistration} from "./coordination-registration.js";
import {assertPublicCoordinationRegistration, assertRegisteredCommunityProject, publicCoordinationTaskLimit, publicDirectoryInitiativeLimit} from "../public-coordination.js";

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * @param {string | undefined} value
 */
function includesFolded(value, needle) {
  return String(value ?? "").toLowerCase().includes(String(needle ?? "").toLowerCase());
}

function sortWorkItems(a, b) {
  return Number(a.rank ?? 0) - Number(b.rank ?? 0) || String(a.dueDate ?? "9999-12-31").localeCompare(String(b.dueDate ?? "9999-12-31"));
}

function userIdFromEmail(email) {
  return `user-${String(email).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function personalWorkspaceId(userId) {
  return `workspace-personal-${String(userId).replace(/^user-/, "").replace(/[^a-z0-9-]+/g, "-")}`;
}

function ldapGroupId(group) {
  const slug = String(group.name ?? "group").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28) || "group";
  return `ldap-${slug}-${createHash("sha256").update(String(group.externalId)).digest("hex").slice(0, 8)}`;
}

function ldapDepartmentId(name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "department";
  return `ldap-${slug}-${createHash("sha256").update(String(name)).digest("hex").slice(0, 8)}`;
}

function connectorAllowsProject(connector, projectId) {
  const allowed = [...new Set([connector.projectId, ...(connector.projectIds ?? [])].filter(Boolean))];
  return allowed.includes(projectId);
}

const collaborationConnectorTypes = new Set(["xwiki", "nextcloud", "opendesk"]);

function hasProjectAccess(projectId, allowedProjectIds = []) {
  return !Array.isArray(allowedProjectIds) || allowedProjectIds.length === 0 || allowedProjectIds.includes(projectId);
}

function isActiveMembership(membership) {
  return membership?.status === undefined || membership.status === "active";
}

function meetingWorkItemIds(meeting) {
  return [...new Set((meeting.agendaItems ?? []).flatMap((item) => item.workItemIds ?? []))];
}

function assertMeetingPresenters(meeting) {
  const participants = new Set(meeting.participantIds ?? []);
  if ((meeting.agendaItems ?? []).some((item) => item.presenterId && !participants.has(item.presenterId))) {
    throw new ValidationError("Agenda presenters must also be meeting participants");
  }
  if ((meeting.attendance ?? []).some((item) => !participants.has(item.userId))) throw new ValidationError("Attendance records must reference meeting participants");
}

function meetingParticipantIdsToValidate(current, next, patch) {
  const ids = new Set();
  if (patch.participantIds !== undefined) {
    const previousParticipants = new Set(current.participantIds ?? []);
    for (const participantId of next.participantIds ?? []) {
      if (!previousParticipants.has(participantId)) ids.add(participantId);
    }
  }
  if (patch.agendaItems !== undefined) {
    const previousPresenters = new Map((current.agendaItems ?? []).map((item) => [item.id, item.presenterId ?? ""]));
    for (const item of next.agendaItems ?? []) {
      if (item.presenterId && previousPresenters.get(item.id) !== item.presenterId) ids.add(item.presenterId);
    }
  }
  return [...ids];
}

export class MemoryRepository {
  /**
   * @param {any} [seed]
   */
  constructor(seed = seedData, {integrationRuntime = createProviderIntegrationRuntime()} = {}) {
    this.workspace = clone(seed.workspace);
    this.workspaces = new Map([clone(seed.workspace), ...(seed.workspaces ?? []).map(clone)].map((workspace) => [workspace.id, workspace]));
    this.users = new Map(seed.users.map((user) => [user.id, clone(user)]));
    this.memberships = new Map(seed.memberships.map((membership) => [`${membership.workspaceId}:${membership.userId}`, clone(membership)]));
    this.portfolios = new Map(seed.portfolios.map((item) => [item.id, clone(item)]));
    this.projects = new Map(seed.projects.map((item) => [item.id, clone(item)]));
    this.workItems = new Map(seed.workItems.map((item) => [item.id, clone(item)]));
    this.meetings = new Map((seed.meetings ?? []).map((item) => [`${item.projectId}:${item.id}`, clone(item)]));
    this.meetingIdempotencyClaims = new Map();
    this.timeEntries = new Map(seed.timeEntries.map((item) => [item.id, clone(item)]));
    this.timers = new Map();
    this.documents = new Map((seed.documents ?? []).map((item) => [item.id, clone(item)]));
    this.projectContent = new Map((seed.projectContent ?? []).map((item) => [`${item.projectId}:${item.id}`, clone(item)]));
    this.contentRevisions = new Map();
    this.planningResources = new Map((seed.planningResources ?? []).map((item) => [`${item.projectId}:${item.id}`, clone(item)]));
    this.workConfigurations = new Map((seed.workConfigurations ?? []).map((item) => [item.workspaceId, clone(item)]));
    this.workspaceCapabilities = new Map((seed.workspaceCapabilities ?? []).map((item) => [item.workspaceId, clone(item)]));
    this.savedViews = new Map((seed.savedViews ?? []).map((item) => [item.id, clone(item)]));
    this.attachments = new Map();
    this.uploadIntents = new Map();
    this.activities = (seed.activities ?? []).map(clone);
    this.notificationReads = new Map((seed.notificationReads ?? []).map((item) => [`${item.workspaceId}:${item.userId}:${item.activityId}`, clone(item)]));
    this.notificationPreferences = new Map((seed.notificationPreferences ?? []).map((item) => [`${item.workspaceId}:${item.userId}`, clone(item)]));
    this.notificationDigestClaims = new Map();
    this.integrationLinks = new Map((seed.integrationLinks ?? []).map((item) => [item.id, clone(item)]));
    this.providerWebhookDeliveries = new Map();
    this.externalShares = new Map((seed.externalShares ?? []).map((item) => [item.token, clone(item)]));
    this.outboundNavigations = new Map((seed.outboundNavigations ?? []).map((item) => [item.id, clone(item)]));
    this.webhookDeliveries = new Map((seed.webhookDeliveries ?? []).map((item) => [item.id, clone(item)]));
    this.repositorySnapshots = new Map((seed.repositorySnapshots ?? []).map((item) => [`${item.workspaceId}:${item.repositoryId}`, clone(item)]));
    this.contentPresence = new Map();
    this.integrationRuntime = integrationRuntime;
    this.publicCoordinationRegistrations = new Map((seed.publicCoordinationRegistrations ?? []).map((registration) => [registration.initiativeId, clone(registration)]));
  }

  now() {
    return new Date().toISOString();
  }

  async getPublicCoordinationRegistration(initiativeId) {
    const registration = this.publicCoordinationRegistrations.get(initiativeId);
    return registration ? clone(registration) : undefined;
  }

  async listPublicCoordinationInitiatives() {
    const ids = [...this.publicCoordinationRegistrations.values()].filter(record => record.enabled === true).map(record => record.initiativeId).sort();
    return {initiativeIds: ids.slice(0, publicDirectoryInitiativeLimit), truncated: ids.length > publicDirectoryInitiativeLimit};
  }

  async readPublicCoordinationProjects(registration) {
    assertPublicCoordinationRegistration(registration);
    return registration.projectIds.map(id => clone(assertRegisteredCommunityProject(this.projects.get(id), registration)));
  }

  async setPublicCoordinationRegistration(context, input) {
    const next = await prepareCoordinationRegistration(this, context, input);
    if ((this.publicCoordinationRegistrations.get(input.initiativeId)?.version ?? 0) !== input.version) throw new ConflictError();
    this.publicCoordinationRegistrations.set(input.initiativeId, next);
    return clone(next);
  }

  async readPublicCoordinationState(registration) {
    assertPublicCoordinationRegistration(registration);
    const projects = registration.projectIds.map((id) => clone(assertRegisteredCommunityProject(this.projects.get(id), registration)));
    const selected = new Set(registration.projectIds);
    const tasks = [...this.workItems.values()].filter((task) => task.workspaceId === registration.workspaceId && selected.has(task.projectId) && !task.deletedAt).map(clone);
    if (tasks.length > publicCoordinationTaskLimit) throw new ValidationError("Public tracker exceeds its task limit");
    return {projects, tasks, workConfiguration: await this.getWorkConfiguration({workspaceId: registration.workspaceId})};
  }

  /**
   * @param {{id: string, email?: string, name?: string}} user
   */
  async getOrBootstrap(user, requestedWorkspaceId = "") {
    const id = user.id || demoUser.id;
    if (!this.users.has(id)) {
      this.users.set(id, {id, email: user.email ?? `${id}@example.test`, name: user.name ?? user.email ?? id});
    }
    let workspaceId = requestedWorkspaceId;
    if (workspaceId) {
      const requestedMembership = this.memberships.get(`${workspaceId}:${id}`);
      if (!isActiveMembership(requestedMembership)) throw new ForbiddenError("You are not an active member of this account");
    } else {
      const memberships = [...this.memberships.values()].filter((membership) => membership.userId === id && isActiveMembership(membership));
      const defaultMembership = memberships.find((membership) => membership.defaultAccount) ?? memberships[0];
      workspaceId = defaultMembership?.workspaceId ?? personalWorkspaceId(id);
    }
    if (!this.workspaces.has(workspaceId)) {
      const now = this.now();
      this.workspaces.set(workspaceId, {
        id: workspaceId,
        name: user.name ? `${user.name}'s workspace` : "Personal workspace",
        accountType: "personal",
        createdBy: id,
        version: 1,
        createdAt: now,
        updatedAt: now
      });
    }
    const key = `${workspaceId}:${id}`;
    if (this.memberships.has(key) && !isActiveMembership(this.memberships.get(key))) {
      throw new ForbiddenError("You are not an active member of this account");
    }
    if (!this.memberships.has(key)) {
      const role = this.memberships.size === 0 || workspaceId.startsWith("workspace-personal-") ? roles.admin : roles.viewer;
      this.memberships.set(key, {
        workspaceId,
        userId: id,
        role,
        email: user.email ?? `${id}@example.test`,
        name: user.name ?? user.email ?? id
      });
    }
    const currentUser = this.users.get(id) ?? demoUser;
    const membership = this.memberships.get(key) ?? demoMembership;
    return {workspace: clone(this.workspaces.get(workspaceId) ?? this.workspace), user: clone(currentUser), membership: clone(membership)};
  }

  async listAccounts(userId) {
    return [...this.memberships.values()]
      .filter((membership) => membership.userId === userId && isActiveMembership(membership))
      .map((membership) => ({
        ...clone(membership),
        workspace: clone(this.workspaces.get(membership.workspaceId) ?? {id: membership.workspaceId, name: membership.workspaceId})
      }))
      .sort((a, b) => Number(Boolean(b.defaultAccount)) - Number(Boolean(a.defaultAccount)) || String(a.workspace?.name).localeCompare(String(b.workspace?.name)));
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string, user?: {email?: string, name?: string}}} context
   * @param {{name: string, accountType: string, defaultProjectPrefix?: string}} input
   */
  async createAccount(context, input) {
    const now = this.now();
    const workspace = {
      id: newId(),
      name: input.name,
      accountType: input.accountType,
      defaultProjectPrefix: input.defaultProjectPrefix ?? "",
      createdBy: context.actorId,
      version: 1,
      createdAt: now,
      updatedAt: now
    };
    this.workspaces.set(workspace.id, workspace);
    const user = this.users.get(context.actorId) ?? {id: context.actorId, email: context.user?.email, name: context.user?.name};
    const membership = {
      workspaceId: workspace.id,
      userId: context.actorId,
      email: user.email ?? "",
      name: user.name ?? user.email ?? context.actorId,
      role: roles.admin,
      status: "active",
      defaultAccount: false,
      version: 1,
      createdAt: now,
      updatedAt: now
    };
    this.memberships.set(`${workspace.id}:${context.actorId}`, membership);
    this.recordActivity({...context, workspaceId: workspace.id}, undefined, "workspace", workspace.id, "workspace.created", ["name", "accountType"], `Created account ${workspace.name}`);
    return clone({...workspace, membership});
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string}} context
   * @param {string | undefined} projectId
   * @param {string} entityType
   * @param {string} entityId
   * @param {string} eventType
   * @param {string[]} fields
   * @param {string} summary
   */
  recordActivity(context, projectId, entityType, entityId, eventType, fields, summary, details = {}) {
    const timestamp = this.now();
    const activity = {
      id: newId(),
      workspaceId: context.workspaceId,
      projectId,
      actorId: context.actorId,
      timestamp,
      reverseTimestamp: reverseTimestamp(timestamp),
      entityType,
      entityId,
      eventType,
      changedFields: fields,
      summary,
      correlationId: context.correlationId,
      ...clone(details)
    };
    this.activities.push(activity);
    return clone(activity);
  }

  async getWorkspace(context = {}) {
    return clone(this.workspaces.get(context.workspaceId) ?? this.workspace);
  }

  async getWorkspaceCapabilities(context = {}) {
    const stored = this.workspaceCapabilities.get(context.workspaceId);
    return clone(stored
      ? {...defaultWorkspaceCapabilities, ...stored, timeEntryActivities: stored.timeEntryActivities ?? defaultWorkspaceCapabilities.timeEntryActivities}
      : {...defaultWorkspaceCapabilities, workspaceId: context.workspaceId});
  }

  async patchWorkspaceCapabilities(context, input) {
    const current = await this.getWorkspaceCapabilities(context);
    if (Number(input.version) !== Number(current.version)) throw new ConflictError();
    const parsed = validateCapabilityCustomFieldValues(parseWorkspaceCapabilitiesInput(input));
    const now = this.now();
    const item = {
      ...parsed,
      workspaceId: context.workspaceId,
      version: current.version + 1,
      createdAt: current.createdAt ?? now,
      updatedAt: now,
      updatedBy: context.actorId
    };
    this.workspaceCapabilities.set(context.workspaceId, item);
    this.recordActivity(context, undefined, "workspace-capabilities", context.workspaceId, "workspace-capabilities.updated", Object.keys(parsed).filter((key) => !["schemaVersion", "version"].includes(key)), "Updated workspace capabilities");
    return clone(item);
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string}} context
   * @param {{name: string, defaultProjectPrefix?: string, dataRetentionDays?: number}} input
   */
  async patchWorkspace(context, input) {
    const workspace = this.workspaces.get(context.workspaceId);
    if (!workspace) throw new NotFoundError("Workspace not found");
    const changed = [];
    for (const field of ["name", "accountType", "defaultProjectPrefix", "dataRetentionDays"]) {
      if (input[field] !== undefined && input[field] !== workspace[field]) {
        workspace[field] = input[field];
        changed.push(field);
      }
    }
    workspace.version = Number(workspace.version ?? 1) + 1;
    workspace.updatedAt = this.now();
    this.recordActivity(context, undefined, "workspace", workspace.id, "workspace.updated", changed, `Updated workspace ${workspace.name}`);
    return clone(workspace);
  }

  /**
   * Return a virtual default when a workspace has not persisted configuration
   * yet. This keeps existing data and installations migration-free.
   */
  async getWorkConfiguration(context = {}) {
    const workspaceId = context.workspaceId ?? this.workspace.id;
    const persisted = this.workConfigurations.get(workspaceId);
    return clone(persisted ?? {...defaultWorkConfiguration, workspaceId});
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string}} context
   * @param {unknown} input
   */
  async patchWorkConfiguration(context, input) {
    const next = parseWorkConfigurationInput(input);
    const current = await this.getWorkConfiguration(context);
    if (next.version !== current.version) throw new ConflictError();
    assertWorkConfigurationUpdate(current, next);
    const now = this.now();
    const updated = {
      ...next,
      workspaceId: context.workspaceId,
      version: current.version + 1,
      createdAt: current.createdAt ?? now,
      updatedAt: now
    };
    const latestVersion = this.workConfigurations.get(context.workspaceId)?.version ?? defaultWorkConfiguration.version;
    if (next.version !== latestVersion) throw new ConflictError();
    this.workConfigurations.set(context.workspaceId, updated);
    this.recordActivity(
      context,
      undefined,
      "work-configuration",
      context.workspaceId,
      "work-configuration.updated",
      ["types", "statuses", "transitions", "defaultTypeId", "defaultStatusId"],
      "Updated work configuration"
    );
    return clone(updated);
  }

  async listMemberships(context = {}) {
    return [...this.memberships.values()].map((membership) => ({
      ...clone(membership),
      user: clone(this.users.get(membership.userId) ?? {id: membership.userId, email: membership.email, name: membership.name})
    })).filter((membership) => !context.workspaceId || membership.workspaceId === context.workspaceId)
      .sort((a, b) => String(a.email).localeCompare(String(b.email)));
  }

  async assertMembershipRole(context, role) {
    if (Object.values(roles).includes(role)) return;
    if (!String(role).startsWith("custom:")) throw new ValidationError("Membership role is not supported");
    const roleId = String(role).slice("custom:".length);
    const capabilities = await this.getWorkspaceCapabilities(context);
    if (!capabilities.customRoles?.some((item) => item.id === roleId)) throw new ValidationError("Custom role is not configured");
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string}} context
   * @param {{userId?: string, email: string, name: string, role: string, status: string}} input
   */
  async upsertMembership(context, input) {
    await this.assertMembershipRole(context, input.role);
    const userId = input.userId ?? userIdFromEmail(input.email);
    const now = this.now();
    const existingMembership = this.memberships.get(`${context.workspaceId}:${userId}`);
    const capabilities = await this.getWorkspaceCapabilities(context);
    const customFields = input.customFields === undefined && existingMembership
      ? existingMembership.customFields ?? {}
      : validateAndCalculateCustomFields(capabilities, "user", input.customFields ?? {}, existingMembership?.customFields ?? {});
    const user = {
      id: userId,
      email: input.email,
      name: input.name,
      updatedAt: now,
      createdAt: this.users.get(userId)?.createdAt ?? now
    };
    const membership = {
      workspaceId: context.workspaceId,
      userId,
      email: input.email,
      name: input.name,
      role: input.role,
      status: input.status,
      projectIds: input.projectIds ?? [],
      groupIds: input.groupIds ?? [],
      placeholder: Boolean(input.placeholder),
      weeklyMinutes: input.weeklyMinutes,
      skills: input.skills ?? [],
      department: input.department ?? existingMembership?.department,
      directorySource: input.directorySource ?? existingMembership?.directorySource,
      directoryExternalId: input.directoryExternalId ?? existingMembership?.directoryExternalId,
      customFields,
      version: Number(existingMembership?.version ?? 0) + 1,
      createdAt: existingMembership?.createdAt ?? now,
      updatedAt: now
    };
    this.users.set(userId, user);
    this.memberships.set(`${context.workspaceId}:${userId}`, membership);
    this.recordActivity(context, undefined, "membership", userId, "membership.upserted", ["email", "name", "role", "status"], `Saved member ${input.email}`);
    return clone({...membership, user});
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string}} context
   * @param {string} userId
   * @param {Record<string, unknown>} patch
   */
  async patchMembership(context, userId, patch) {
    const key = `${context.workspaceId}:${userId}`;
    const membership = this.memberships.get(key);
    if (!membership) throw new NotFoundError("Membership not found");
    if (patch.role) await this.assertMembershipRole(context, patch.role);
    if (patch.customFields !== undefined) {
      const capabilities = await this.getWorkspaceCapabilities(context);
      patch.customFields = validateAndCalculateCustomFields(capabilities, "user", patch.customFields, membership.customFields ?? {});
    }
    const changed = [];
    for (const field of ["name", "email", "role", "status", "projectIds", "groupIds", "weeklyMinutes", "skills", "customFields"]) {
      if (patch[field] !== undefined && JSON.stringify(patch[field]) !== JSON.stringify(membership[field])) {
        membership[field] = patch[field];
        changed.push(field);
      }
    }
    membership.version = Number(membership.version ?? 1) + 1;
    membership.updatedAt = this.now();
    const user = this.users.get(userId) ?? {id: userId};
    if (membership.name) user.name = membership.name;
    if (membership.email) user.email = membership.email;
    user.updatedAt = membership.updatedAt;
    this.users.set(userId, user);
    this.recordActivity(context, undefined, "membership", userId, "membership.updated", changed, `Updated member ${membership.email}`);
    return clone({...membership, user});
  }

  async saveScimGroup(context, input) {
    const [capabilities, memberships] = await Promise.all([this.getWorkspaceCapabilities(context), this.listMemberships(context)]);
    const knownUserIds = new Set(memberships.map((member) => member.userId));
    if (input.memberIds.some((userId) => !knownUserIds.has(userId))) throw new ValidationError("Every SCIM group member must be a workspace user");
    const now = this.now();
    const existing = capabilities.groups?.find((group) => group.id === input.id);
    const group = {
      ...existing,
      id: input.id,
      name: input.name,
      scimExternalId: input.externalId,
      customFields: input.customFields ?? existing?.customFields ?? {},
      managedBy: "scim",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    const groups = [...(capabilities.groups ?? []).filter((item) => item.id !== input.id), group];
    await this.patchWorkspaceCapabilities(context, {...capabilities, groups, version: capabilities.version});
    const desired = new Set(input.memberIds);
    for (const membership of memberships) {
      const current = new Set(membership.groupIds ?? []);
      if (desired.has(membership.userId)) current.add(input.id);
      else current.delete(input.id);
      const next = [...current];
      if (JSON.stringify(next) !== JSON.stringify(membership.groupIds ?? [])) {
        const stored = this.memberships.get(`${context.workspaceId}:${membership.userId}`);
        stored.groupIds = next;
        stored.version = Number(stored.version ?? 1) + 1;
        stored.updatedAt = now;
      }
    }
    this.recordActivity(context, undefined, "scim-group", input.id, existing ? "scim-group.updated" : "scim-group.created", ["name", "members"], `${existing ? "Updated" : "Created"} SCIM group ${input.name}`);
    return {group: clone(group), memberships: await this.listMemberships(context)};
  }

  async deleteScimGroup(context, groupId) {
    const [capabilities, memberships] = await Promise.all([this.getWorkspaceCapabilities(context), this.listMemberships(context)]);
    const group = capabilities.groups?.find((item) => item.id === groupId);
    if (!group) throw new NotFoundError("SCIM group not found");
    await this.patchWorkspaceCapabilities(context, {...capabilities, groups: capabilities.groups.filter((item) => item.id !== groupId), version: capabilities.version});
    const now = this.now();
    for (const membership of memberships.filter((item) => item.groupIds?.includes(groupId))) {
      const stored = this.memberships.get(`${context.workspaceId}:${membership.userId}`);
      stored.groupIds = stored.groupIds.filter((id) => id !== groupId);
      stored.version = Number(stored.version ?? 1) + 1;
      stored.updatedAt = now;
    }
    this.recordActivity(context, undefined, "scim-group", groupId, "scim-group.deleted", ["id", "members"], `Deleted SCIM group ${group.name ?? groupId}`);
    return {id: groupId, deleted: true};
  }

  async listPlaceholders(context) {
    return (await this.listMemberships(context)).filter((membership) => membership.placeholder);
  }

  async createPlaceholder(context, input) {
    const userId = `placeholder-${newId()}`;
    const placeholder = await this.upsertMembership(context, {...input, userId, email: `${userId}@placeholder.invalid`, role: roles.viewer, placeholder: true});
    this.recordActivity(context, undefined, "placeholder", userId, "placeholder.created", ["name", "weeklyMinutes", "skills"], `Created placeholder ${input.name}`);
    return placeholder;
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string}} context
   * @param {{name?: string, title?: string, department?: string, timezone?: string, locale?: string}} input
   */
  async updateCurrentUserProfile(context, input) {
    const user = this.users.get(context.actorId) ?? {id: context.actorId, email: context.user.email, name: context.user.name};
    const key = `${context.workspaceId}:${context.actorId}`;
    const membership = this.memberships.get(key) ?? {
      workspaceId: context.workspaceId,
      userId: context.actorId,
      email: context.user.email,
      name: context.user.name,
      role: roles.viewer,
      status: "active"
    };
    if (input.customFields !== undefined) {
      const capabilities = await this.getWorkspaceCapabilities(context);
      input.customFields = validateAndCalculateCustomFields(capabilities, "user", input.customFields, membership.customFields ?? {});
    }
    const changed = [];
    for (const field of ["name", "title", "department", "timezone", "locale", "customFields"]) {
      if (input[field] !== undefined && input[field] !== user[field]) {
        user[field] = input[field];
        membership[field] = input[field];
        changed.push(field);
      }
    }
    user.updatedAt = this.now();
    membership.name = user.name ?? membership.name;
    membership.version = Number(membership.version ?? 1) + 1;
    membership.updatedAt = user.updatedAt;
    this.users.set(context.actorId, user);
    this.memberships.set(key, membership);
    this.recordActivity(context, undefined, "user", context.actorId, "user.profile.updated", changed, `Updated profile ${user.name ?? user.email}`);
    return {user: clone(user), membership: clone(membership)};
  }

  async listPortfolios(context = {}) {
    const portfolios = [...this.portfolios.values()]
      .filter((portfolio) => !context.workspaceId || portfolio.workspaceId === context.workspaceId)
      .map(clone)
      .sort((a, b) => a.name.localeCompare(b.name));
    return context.publicDemo?.pageLimit ? portfolios.slice(0, context.publicDemo.pageLimit) : portfolios;
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string}} context
   * @param {{name: string, description?: string}} input
   */
  async createPortfolio(context, input) {
    const now = this.now();
    const portfolio = {
      id: newId(),
      workspaceId: context.workspaceId,
      name: input.name,
      description: input.description ?? "",
      archived: false,
      version: 1,
      createdAt: now,
      updatedAt: now
    };
    this.portfolios.set(portfolio.id, portfolio);
    this.recordActivity(context, undefined, "portfolio", portfolio.id, "portfolio.created", ["name"], `Created portfolio ${portfolio.name}`);
    return clone(portfolio);
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string}} context
   * @param {string} portfolioId
   * @param {Record<string, unknown>} patch
   */
  async patchPortfolio(context, portfolioId, patch) {
    const portfolio = this.portfolios.get(portfolioId);
    if (!portfolio) throw new NotFoundError("Portfolio not found");
    if (portfolio.workspaceId !== context.workspaceId) throw new NotFoundError("Portfolio not found");
    const expected = Number(patch.version ?? portfolio.version);
    if (expected !== portfolio.version) throw new ConflictError();
    const changed = [];
    for (const field of ["name", "description", "archived"]) {
      if (patch[field] !== undefined && patch[field] !== portfolio[field]) {
        portfolio[field] = patch[field];
        changed.push(field);
      }
    }
    portfolio.version += 1;
    portfolio.updatedAt = this.now();
    this.recordActivity(context, undefined, "portfolio", portfolio.id, "portfolio.updated", changed, `Updated portfolio ${portfolio.name}`);
    return clone(portfolio);
  }

  /**
   * @param {Record<string, unknown>} [filters]
   */
  async listProjects(filters = {}) {
    let projects = [...this.projects.values()].filter((project) => !project.deletedAt).map(clone);
    if (filters.workspaceId) projects = projects.filter((project) => project.workspaceId === filters.workspaceId);
    if (Array.isArray(filters.allowedProjectIds) && filters.allowedProjectIds.length) projects = projects.filter((project) => filters.allowedProjectIds.includes(project.id));
    if (filters.search) projects = projects.filter((project) => includesFolded(project.name, filters.search) || includesFolded(project.description, filters.search));
    for (const field of ["status", "health", "ownerId", "portfolioId", "priority", "phase"]) {
      if (filters[field]) projects = projects.filter((project) => project[field] === filters[field]);
    }
    if (filters.archived === "true" || filters.archived === true) projects = projects.filter((project) => project.archived);
    if (filters.archived === "false" || filters.archived === false) projects = projects.filter((project) => !project.archived);
    if (filters.template === "true" || filters.template === true) projects = projects.filter((project) => project.template);
    if (filters.template === "false" || filters.template === false) projects = projects.filter((project) => !project.template);
    if (filters.favorite === "true" || filters.favorite === true) projects = projects.filter((project) => project.favorite);
    projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return filters.limit ? projects.slice(0, Number(filters.limit)) : projects;
  }

  /**
   * @param {string} id
   */
  async getProject(id, workspaceId = "", allowedProjectIds = []) {
    const project = this.projects.get(id);
    if (!project || project.deletedAt) throw new NotFoundError("Project not found");
    if (workspaceId && project.workspaceId !== workspaceId) throw new NotFoundError("Project not found");
    if (!hasProjectAccess(id, allowedProjectIds)) throw new NotFoundError("Project not found");
    return clone(project);
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string}} context
   * @param {ReturnType<import("@teamspaces/contracts").parseProjectInput>} input
   */
  async createProject(context, input) {
    const stableId = coordinationProjectId(context.workspaceId, input);
    const id = context.publicDemo?.projectIdPrefix ? `${context.publicDemo.projectIdPrefix}${stableId ?? newId()}` : stableId ?? newId();
    const createDigest = stableId ? coordinationDigest(input) : undefined;
    if (stableId && this.projects.has(id)) return clone(replayCoordinationCreate(await this.getProject(id, context.workspaceId, context.membership?.projectIds), createDigest));
    if (input.portfolioId && this.portfolios.get(input.portfolioId)?.workspaceId !== context.workspaceId) throw new ValidationError("portfolioId does not exist");
    if (input.parentProjectId) await this.getProject(input.parentProjectId, context.workspaceId, context.membership?.projectIds);
    const capabilities = await this.getWorkspaceCapabilities(context);
    const configuredPhases = capabilities.lifecycle?.phases ?? [];
    const requestedPhase = input.phase ?? configuredPhases[0]?.label ?? configuredPhases[0]?.id;
    const phase = configuredPhases.find((item) => item.id === requestedPhase || item.label === requestedPhase);
    if (!phase) throw new ValidationError("Project phase is not configured");
    input.customFields = validateAndCalculateCustomFields(capabilities, "project", input.customFields, {});
    const now = this.now();
    const project = {
      id,
      ...(createDigest ? {coordinationCreateDigest: createDigest} : {}),
      workspaceId: context.workspaceId,
      ownerId: input.ownerId ?? context.actorId,
      status: "active",
      health: "on-track",
      priority: "medium",
      archived: false,
      favorite: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
      initiationStatus: capabilities.lifecycle?.initiation?.enabled ? "draft" : undefined,
      initiationApprovals: [],
      lifecycleGateApprovals: [],
      ...input,
      phase: phase.label ?? phase.id
    };
    if (stableId && this.projects.has(id)) return clone(replayCoordinationCreate(this.projects.get(id), createDigest));
    this.projects.set(project.id, project);
    this.recordActivity(context, project.id, "project", project.id, "project.created", ["name"], `Created project ${project.name}`);
    return clone(project);
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string}} context
   * @param {string} projectId
   * @param {Record<string, unknown>} patch
   */
  async patchProject(context, projectId, patch) {
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const project = this.projects.get(projectId);
    if (!project || project.deletedAt) throw new NotFoundError("Project not found");
    if (project.workspaceId !== context.workspaceId) throw new NotFoundError("Project not found");
    assertCoordinationProjectUpdate(project, patch);
    const expected = Number(patch.version ?? project.version);
    if (expected !== project.version) throw new ConflictError();
    if (patch.parentProjectId === projectId) throw new ValidationError("A project cannot be its own parent");
    if (patch.parentProjectId) {
      let ancestorId = patch.parentProjectId;
      const visited = new Set([projectId]);
      while (ancestorId) {
        if (visited.has(ancestorId)) throw new ValidationError("Project hierarchy cannot contain a cycle");
        visited.add(ancestorId);
        const ancestor = await this.getProject(ancestorId, context.workspaceId, context.membership?.projectIds);
        ancestorId = ancestor.parentProjectId;
      }
    }
    let capabilities;
    if (patch.phase && patch.phase !== project.phase) {
      capabilities = await this.getWorkspaceCapabilities(context);
      const phase = (capabilities.lifecycle?.phases ?? []).find((item) => item.id === patch.phase || item.label === patch.phase);
      if (!phase) throw new ValidationError("Project phase is not configured");
      const approvals = new Set((project.lifecycleGateApprovals ?? []).filter((approval) => approval.status === "approved").map((approval) => approval.gateId));
      const missing = (phase.gates ?? []).map((gate) => typeof gate === "string" ? gate : gate.id).filter((gateId) => !approvals.has(gateId));
      if (missing.length) throw new ConflictError(`Approve lifecycle gates before entering ${phase.label ?? phase.id}: ${missing.join(", ")}`);
    }
    if (patch.customFields !== undefined) {
      capabilities ??= await this.getWorkspaceCapabilities(context);
      patch.customFields = validateAndCalculateCustomFields(capabilities, "project", patch.customFields, project.customFields ?? {});
    }
    const mutable = ["name", "description", "portfolioId", "parentProjectId", "ownerId", "status", "health", "priority", "phase", "startDate", "targetDate", "percentComplete", "favorite", "tags", "archived", "modules", "template", "customFields", "coordination"];
    const changed = [];
    for (const field of mutable) {
      if (patch[field] !== undefined && JSON.stringify(patch[field]) !== JSON.stringify(project[field])) {
        project[field] = patch[field];
        changed.push(field);
      }
    }
    project.version += 1;
    project.updatedAt = this.now();
    this.recordActivity(context, project.id, "project", project.id, "project.updated", changed, `Updated project ${project.name}`);
    return clone(project);
  }

  async submitProjectInitiation(context, projectId, input) {
    const project = this.projects.get(projectId);
    if (!project || project.workspaceId !== context.workspaceId || project.deletedAt) throw new NotFoundError("Project not found");
    if (Number(input.version) !== Number(project.version)) throw new ConflictError();
    const capabilities = await this.getWorkspaceCapabilities(context);
    const configuration = capabilities.lifecycle?.initiation;
    if (!configuration?.enabled) throw new ForbiddenError("Project initiation is not enabled");
    const missing = (configuration.requestFields ?? []).filter((field) => field.required && (input.requestData?.[field.id] === undefined || input.requestData?.[field.id] === "")).map((field) => field.name ?? field.id);
    if (missing.length) throw new ValidationError(`Required initiation fields are missing: ${missing.join(", ")}`);
    const templateProjectId = input.templateProjectId ?? configuration.templateProjectId;
    if (templateProjectId) {
      const template = await this.getProject(templateProjectId, context.workspaceId, context.membership?.projectIds);
      if (!template.template) throw new ValidationError("Initiation template must reference a template project");
      project.modules = clone(template.modules ?? project.modules);
      project.tags = [...new Set([...(template.tags ?? []), ...(project.tags ?? [])])];
      project.templateSourceProjectId = template.id;
    }
    const now = this.now();
    project.initiationStatus = "submitted";
    project.initiationRequest = {requestData: clone(input.requestData), note: input.note, submittedAt: now, submittedBy: context.actorId, templateProjectId};
    project.initiationApprovals = [];
    project.initiationAuditArtifact = {id: newId(), projectId, schemaVersion: 1, submittedAt: now, submittedBy: context.actorId, requestData: clone(input.requestData), templateProjectId, decisions: []};
    project.version += 1;
    project.updatedAt = now;
    this.recordActivity(context, projectId, "project-initiation", project.initiationAuditArtifact.id, "project-initiation.submitted", ["requestData", "templateProjectId"], `Submitted initiation request for ${project.name}`);
    return clone(project);
  }

  async reviewProjectInitiation(context, projectId, input) {
    const project = this.projects.get(projectId);
    if (!project || project.workspaceId !== context.workspaceId || project.deletedAt) throw new NotFoundError("Project not found");
    if (Number(input.version) !== Number(project.version)) throw new ConflictError();
    if (project.initiationStatus !== "submitted" && project.initiationStatus !== "changes-requested") throw new ConflictError("Only a submitted initiation request can be reviewed");
    const capabilities = await this.getWorkspaceCapabilities(context);
    const reviewers = capabilities.lifecycle?.initiation?.reviewerIds ?? [];
    if (reviewers.length && !reviewers.includes(context.actorId)) throw new ForbiddenError("You are not an initiation reviewer");
    const now = this.now();
    const decision = {id: newId(), decision: input.decision, comment: input.comment, reviewerId: context.actorId, reviewedAt: now};
    project.initiationApprovals = [...(project.initiationApprovals ?? []), decision];
    project.initiationStatus = input.decision;
    project.initiationAuditArtifact = {...project.initiationAuditArtifact, decisions: [...(project.initiationAuditArtifact?.decisions ?? []), clone(decision)], finalizedAt: input.decision === "approved" || input.decision === "rejected" ? now : undefined};
    project.version += 1;
    project.updatedAt = now;
    this.recordActivity(context, projectId, "project-initiation", project.initiationAuditArtifact?.id ?? projectId, `project-initiation.${input.decision}`, ["decision", "comment"], `${input.decision.replaceAll("-", " ")} initiation request for ${project.name}`);
    return clone(project);
  }

  async approveLifecycleGate(context, projectId, gateId, input) {
    const project = this.projects.get(projectId);
    if (!project || project.workspaceId !== context.workspaceId || project.deletedAt) throw new NotFoundError("Project not found");
    if (Number(input.version) !== Number(project.version)) throw new ConflictError();
    const capabilities = await this.getWorkspaceCapabilities(context);
    const gates = (capabilities.lifecycle?.phases ?? []).flatMap((phase) => (phase.gates ?? []).map((gate) => typeof gate === "string" ? {id: gate} : gate));
    const gate = gates.find((item) => item.id === gateId);
    if (!gate) throw new NotFoundError("Lifecycle gate not found");
    if (gate.reviewerIds?.length && !gate.reviewerIds.includes(context.actorId)) throw new ForbiddenError("You are not a reviewer for this lifecycle gate");
    const now = this.now();
    const approval = {gateId, status: "approved", comment: input.comment, reviewerId: context.actorId, approvedAt: now};
    project.lifecycleGateApprovals = [...(project.lifecycleGateApprovals ?? []).filter((item) => item.gateId !== gateId), approval];
    project.version += 1;
    project.updatedAt = now;
    this.recordActivity(context, projectId, "lifecycle-gate", gateId, "lifecycle-gate.approved", ["status", "comment"], `Approved lifecycle gate ${gate.name ?? gateId}`);
    return clone(project);
  }

  /** Copy a project and, when requested, its bounded task setup. */
  async copyProject(context, projectId, input) {
    const source = await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const sourceItems = input.includeTasks ? [...this.workItems.values()].filter((item) => item.projectId === projectId) : [];
    if (sourceItems.length > 100) throw new ValidationError("Projects with more than 100 tasks must be copied without tasks");
    const copy = await this.createProject(context, {
      name: input.name ?? `${source.name} copy`,
      description: source.description ?? "",
      portfolioId: source.portfolioId,
      parentProjectId: input.parentProjectId ?? source.parentProjectId,
      ownerId: context.actorId,
      status: input.asTemplate ? "proposed" : "active",
      health: "on-track",
      priority: source.priority ?? "medium",
      phase: source.phase,
      startDate: source.startDate,
      targetDate: source.targetDate,
      percentComplete: 0,
      modules: source.modules,
      template: input.asTemplate,
      customFields: source.customFields ?? {},
      tags: source.tags ?? []
    });
    if (input.includeTasks) {
      const ids = new Map(sourceItems.map((item) => [item.id, newId()]));
      for (const sourceItem of sourceItems) {
        const now = this.now();
        const item = {
          ...clone(sourceItem),
          id: ids.get(sourceItem.id),
          projectId: copy.id,
          workspaceId: context.workspaceId,
          parentId: ids.get(sourceItem.parentId),
          blockedBy: (sourceItem.blockedBy ?? []).map((id) => ids.get(id)).filter(Boolean),
          relatedIds: (sourceItem.relatedIds ?? []).map((id) => ids.get(id)).filter(Boolean),
          relations: (sourceItem.relations ?? []).map((relation) => ({...relation, targetId: ids.get(relation.targetId)})).filter((relation) => relation.targetId),
          recordedMinutes: 0,
          percentComplete: 0,
          version: 1,
          createdAt: now,
          updatedAt: now
        };
        resetCopiedCoordination(item);
        this.workItems.set(item.id, item);
      }
    }
    this.recordActivity(context, copy.id, "project", copy.id, "project.copied", ["sourceProjectId"], `Copied project ${source.name}`);
    return clone(copy);
  }

  async deleteProject(context, projectId, input) {
    const project = this.projects.get(projectId);
    if (!project || project.deletedAt || project.workspaceId !== context.workspaceId) throw new NotFoundError("Project not found");
    if (Number(input.version) !== Number(project.version)) throw new ConflictError();
    if ([...this.projects.values()].some((item) => !item.deletedAt && item.parentProjectId === projectId)) {
      throw new ConflictError("Move or delete subprojects before deleting this project");
    }
    project.deletedAt = this.now();
    project.deletedBy = context.actorId;
    project.archived = true;
    project.status = "archived";
    project.version += 1;
    project.updatedAt = project.deletedAt;
    this.recordActivity(context, projectId, "project", projectId, "project.deleted", ["deletedAt"], `Deleted project ${project.name}`);
    return {id: projectId, deleted: true};
  }

  /**
   * @param {string} projectId
   */
  async listWorkItems(projectId, workspaceId = "", allowedProjectIds = []) {
    const project = this.projects.get(projectId);
    if (!project || (workspaceId && project.workspaceId !== workspaceId)) throw new NotFoundError("Project not found");
    if (!hasProjectAccess(projectId, allowedProjectIds)) throw new NotFoundError("Project not found");
    return [...this.workItems.values()]
      .filter((item) => item.projectId === projectId)
      .map((item) => ({
        ...clone(item),
        assigneeName: this.users.get(item.assigneeId)?.name ?? item.assigneeId ?? "Unassigned"
      }))
      .sort(sortWorkItems);
  }

  /**
   * @param {Record<string, unknown>} [filters]
   */
  async listPlanningWorkItems(filters = {}) {
    let items = [...this.workItems.values()];
    if (filters.workspaceId) {
      const projectIds = new Set([...this.projects.values()].filter((project) => project.workspaceId === filters.workspaceId).map((project) => project.id));
      items = items.filter((item) => projectIds.has(item.projectId));
    }
    if (Array.isArray(filters.allowedProjectIds) && filters.allowedProjectIds.length) items = items.filter((item) => filters.allowedProjectIds.includes(item.projectId));
    for (const field of ["projectId", "status", "assigneeId", "periodId", "intakeGroup", "milestoneName"]) {
      if (filters[field]) items = items.filter((item) => item[field] === filters[field]);
    }
    if (filters.search) {
      items = items.filter((item) => includesFolded(item.title, filters.search) || includesFolded(item.description, filters.search));
    }
    return items.map((item) => ({
      ...clone(item),
      projectName: this.projects.get(item.projectId)?.name ?? item.projectId,
      assigneeName: this.users.get(item.assigneeId)?.name ?? item.assigneeId ?? "Unassigned"
    })).sort(sortWorkItems);
  }

  /**
   * Work Query v1 page over the in-memory adapter. This deliberately uses the
   * same source selection and opaque cursor scope as DynamoDB so API behavior
   * remains adapter-independent.
   * @param {Record<string, any>} [filters]
   */
  async listWorkItemsPage(filters = {}) {
    const workspaceId = filters.workspaceId ?? this.workspace.id;
    assertWorkQueryConfiguration(filters.workConfiguration ?? await this.getWorkConfiguration({workspaceId}), filters);
    if (filters.projectId) await this.getProject(filters.projectId, workspaceId, filters.allowedProjectIds);
    const source = selectWorkQuerySource(filters);
    const cursorKey = decodeWorkCursor(filters.cursor, {source, workspaceId, query: filters});
    if (cursorKey && (
      typeof cursorKey.id !== "string"
      || typeof cursorKey.value !== "string"
      || (filters.sort === "updated-desc" && typeof cursorKey.projectId !== "string")
    )) {
      throw new ValidationError("Cursor key is invalid for this work query");
    }
    let items = [...this.workItems.values()]
      .filter((item) => this.projects.get(item.projectId)?.workspaceId === workspaceId)
      .filter((item) => hasProjectAccess(item.projectId, filters.allowedProjectIds))
      .map((item) => ({
        ...clone(item),
        projectName: this.projects.get(item.projectId)?.name ?? item.projectId,
        assigneeName: this.users.get(item.assigneeId)?.name ?? item.assigneeId ?? "Unassigned"
      }))
      .filter((item) => matchesWorkQuery(item, filters))
      .sort((a, b) => compareWorkItems(a, b, filters.sort));
    if (cursorKey) items = items.filter((item) => isAfterMemoryWorkCursor(item, cursorKey, filters.sort));
    const pageItems = items.slice(0, filters.limit);
    const hasNextPage = items.length > pageItems.length;
    const endCursor = hasNextPage && pageItems.length
      ? encodeWorkCursor({
        source,
        workspaceId,
        query: filters,
        key: memoryWorkCursorKey(pageItems.at(-1), filters.sort)
      })
      : undefined;
    return {items: pageItems, pageInfo: workPageInfo(hasNextPage, endCursor)};
  }

  /** @param {Record<string, any>} [filters] */
  async listPlanningWorkItemsPage(filters = {}) {
    return this.listWorkItemsPage(filters);
  }

  /**
   * @param {string} assigneeId
   */
  async listAssignedWork(assigneeId, filters = {}) {
    const items = [...this.workItems.values()]
      .filter((item) => item.assigneeId === assigneeId)
      .filter((item) => !filters.workspaceId || this.projects.get(item.projectId)?.workspaceId === filters.workspaceId)
      .filter((item) => hasProjectAccess(item.projectId, filters.allowedProjectIds))
      .map(clone)
      .sort((a, b) => String(a.dueDate ?? "9999-12-31").localeCompare(String(b.dueDate ?? "9999-12-31")));
    return filters.limit ? items.slice(0, Number(filters.limit)) : items;
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string}} context
   * @param {string} projectId
   * @param {ReturnType<import("@teamspaces/contracts").parseWorkItemInput>} input
   */
  async createWorkItem(context, projectId, input) {
    if (this.projects.get(projectId)?.workspaceId !== context.workspaceId) throw new NotFoundError("Project not found");
    if (!hasProjectAccess(projectId, context.membership?.projectIds)) throw new NotFoundError("Project not found");
    const stableId = coordinationTaskId(context.workspaceId, projectId, input);
    const createDigest = stableId ? coordinationDigest(input) : undefined;
    if (stableId && this.workItems.has(stableId)) return clone(replayCoordinationCreate(this.workItems.get(stableId), createDigest));
    const [configuration, capabilities] = await Promise.all([this.getWorkConfiguration(context), this.getWorkspaceCapabilities(context)]);
    const type = input.type ?? configuration.defaultTypeId;
    const status = input.status ?? configuration.defaultStatusId;
    const {autoSubject, ...submitted} = input;
    submitted.priority ??= (capabilities.priorities ?? []).find((priority) => priority.active !== false)?.id ?? "medium";
    if (!(capabilities.priorities ?? []).some((priority) => priority.id === submitted.priority && priority.active !== false)) throw new ValidationError("Task priority is not configured");
    if (submitted.teamId && !(capabilities.groups ?? []).some((group) => group.id === submitted.teamId)) throw new ValidationError("Task team is not configured");
    const project = this.projects.get(projectId);
    submitted.title = submitted.title || automaticWorkSubject(capabilities, {projectId, projectName: project?.name, type, category: submitted.category, versionName: submitted.versionName, sequence: this.workItems.size + 1});
    submitted.customFields = validateAndCalculateCustomFields(capabilities, "work-item", submitted.customFields, {});
    assertWorkItemConfiguration(configuration, {
      type,
      status,
      role: context.membership?.role,
      creating: true
    });
    this.assertWorkItemReferences(projectId, stableId, submitted);
    await assertCoordinationReferences(this, context, projectId, submitted, {id: stableId});
    assertCoordinationUpdate({}, {...submitted, status}, configuration);
    const now = this.now();
    const item = {
      id: stableId ?? newId(),
      ...(createDigest ? {coordinationCreateDigest: createDigest} : {}),
      workspaceId: context.workspaceId,
      projectId,
      recordedMinutes: 0,
      rank: new Date(this.now()).getTime(),
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...submitted,
      type,
      status,
      reporterId: input.reporterId ?? context.actorId,
      assigneeId: input.assigneeId ?? context.actorId
    };
    if (stableId && this.workItems.has(stableId)) return clone(replayCoordinationCreate(this.workItems.get(stableId), createDigest));
    this.workItems.set(item.id, item);
    this.recordActivity(context, projectId, "work-item", item.id, "work.created", ["title"], `Created task ${item.title}`, {currentSnapshot: workBaselineSnapshot(item), notificationRecipients: workNotificationRecipients(item)});
    return clone(item);
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string}} context
   * @param {string} workItemId
   * @param {Record<string, unknown>} patch
   */
  async patchWorkItem(context, projectId, workItemId, patch) {
    const item = this.workItems.get(workItemId);
    if (!item) throw new NotFoundError("Task not found");
    if (item.projectId !== projectId) throw new NotFoundError("Task not found");
    if (this.projects.get(item.projectId)?.workspaceId !== context.workspaceId) throw new NotFoundError("Task not found");
    if (!hasProjectAccess(item.projectId, context.membership?.projectIds)) throw new NotFoundError("Task not found");
    const expected = Number(patch.version ?? item.version);
    if (expected !== item.version) throw new ConflictError();
    const [configuration, capabilities] = await Promise.all([this.getWorkConfiguration(context), this.getWorkspaceCapabilities(context)]);
    if (capabilities.work?.readOnlyStatusIds?.includes(item.status) && Object.keys(patch).some((field) => !["version", "status"].includes(field))) {
      throw new ConflictError("This task state is read-only");
    }
    if (patch.customFields !== undefined) patch.customFields = validateAndCalculateCustomFields(capabilities, "work-item", patch.customFields, item.customFields ?? {});
    if (patch.priority !== undefined && !(capabilities.priorities ?? []).some((priority) => priority.id === patch.priority && priority.active !== false)) throw new ValidationError("Task priority is not configured");
    if (patch.teamId && !(capabilities.groups ?? []).some((group) => group.id === patch.teamId)) throw new ValidationError("Task team is not configured");
    const type = patch.type ?? item.type;
    const status = patch.status ?? item.status;
    assertCoordinationUpdate(item, patch, configuration);
    assertWorkItemConfiguration(configuration, {
      type,
      status,
      previousType: item.type,
      previousStatus: item.status,
      role: context.membership?.role
    });
    this.assertWorkItemReferences(projectId, workItemId, patch);
    await assertCoordinationReferences(this, context, projectId, patch, item);
    const previousSnapshot = workBaselineSnapshot(item);
    const changed = [];
    for (const field of ["title", "description", "type", "status", "priority", "assigneeId", "teamId", "accountableId", "startDate", "dueDate", "estimateMinutes", "remainingMinutes", "percentComplete", "effortPoints", "category", "versionName", "versionId", "sprintId", "schedulingMode", "periodId", "periodName", "periodGoal", "intakeGroup", "milestoneName", "parentId", "blockedBy", "relatedIds", "relations", "watcherIds", "acceptanceCriteria", "customFields", "rank", "tags", "coordination"]) {
      if (patch[field] !== undefined && JSON.stringify(patch[field]) !== JSON.stringify(item[field])) {
        item[field] = patch[field];
        changed.push(field);
      }
    }
    item.version += 1;
    item.updatedAt = this.now();
    this.recordActivity(context, item.projectId, "work-item", item.id, "work.updated", changed, `Updated task ${item.title}`, {previousSnapshot, currentSnapshot: workBaselineSnapshot(item), notificationRecipients: workNotificationRecipients(item)});
    return clone(item);
  }

  assertWorkItemReferences(projectId, workItemId, input) {
    const ids = new Set([
      input.parentId,
      ...(input.blockedBy ?? []),
      ...(input.relatedIds ?? []),
      ...(input.relations ?? []).map((relation) => relation.targetId)
    ].filter(Boolean));
    if (workItemId && ids.has(workItemId)) throw new ValidationError("A task cannot relate to itself");
    for (const id of ids) {
      const target = this.workItems.get(id);
      if (!target || target.projectId !== projectId) throw new ValidationError(`Related task does not exist in this project: ${id}`);
    }
  }

  async getCoordinationTask(context, projectId, taskId) {
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const task = this.workItems.get(taskId);
    if (!task || task.projectId !== projectId || task.workspaceId !== context.workspaceId) throw new NotFoundError("Task not found");
    return clone(task);
  }

  async copyWorkItem(context, projectId, workItemId, input) {
    const source = this.workItems.get(workItemId);
    if (!source || source.projectId !== projectId) throw new NotFoundError("Task not found");
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const targetProjectId = input.targetProjectId ?? projectId;
    await this.getProject(targetProjectId, context.workspaceId, context.membership?.projectIds);
    const now = this.now();
    const item = {
      ...clone(source),
      id: newId(),
      projectId: targetProjectId,
      title: input.title ?? `${source.title} copy`,
      parentId: targetProjectId === projectId ? source.parentId : undefined,
      blockedBy: targetProjectId === projectId ? source.blockedBy ?? [] : [],
      relatedIds: targetProjectId === projectId ? source.relatedIds ?? [] : [],
      relations: targetProjectId === projectId ? source.relations ?? [] : [],
      recordedMinutes: 0,
      version: 1,
      createdAt: now,
      updatedAt: now
    };
    resetCopiedCoordination(item);
    this.workItems.set(item.id, item);
    this.recordActivity(context, targetProjectId, "work-item", item.id, "work.copied", ["sourceWorkItemId"], `Copied task ${source.title}`, {currentSnapshot: workBaselineSnapshot(item), notificationRecipients: workNotificationRecipients(item)});
    return clone(item);
  }

  async applyWorkItemCustomAction(context, projectId, workItemId, actionId, input) {
    const [item, capabilities] = await Promise.all([
      this.workItems.get(workItemId),
      this.getWorkspaceCapabilities(context)
    ]);
    if (!item || item.projectId !== projectId) throw new NotFoundError("Task not found");
    const action = configuredCustomAction(capabilities, actionId);
    const allowedRoles = action.roleIds ?? action.roles ?? [];
    if (allowedRoles.length && !allowedRoles.includes(context.membership?.role)) throw new ForbiddenError("Custom action is not available for this role");
    return this.patchWorkItem(context, projectId, workItemId, {version: input.version, ...clone(action.changes)});
  }

  async moveWorkItem(context, projectId, workItemId, input) {
    const item = this.workItems.get(workItemId);
    if (!item || item.projectId !== projectId) throw new NotFoundError("Task not found");
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    await this.getProject(input.targetProjectId, context.workspaceId, context.membership?.projectIds);
    if (item.coordination?.sourceId && input.targetProjectId !== projectId) throw new ConflictError("Synchronized tasks keep their project identity; create a new source task in the destination instead");
    if (Number(input.version) !== Number(item.version)) throw new ConflictError();
    const previousSnapshot = workBaselineSnapshot(item);
    item.projectId = input.targetProjectId;
    item.parentId = undefined;
    item.blockedBy = [];
    item.relatedIds = [];
    item.relations = [];
    item.version += 1;
    item.updatedAt = this.now();
    if (projectId !== input.targetProjectId) this.recordActivity(context, projectId, "work-item", item.id, "work.moved-out", ["projectId"], `Moved task ${item.title} out of project`, {previousSnapshot});
    this.recordActivity(context, input.targetProjectId, "work-item", item.id, "work.moved", ["projectId"], `Moved task ${item.title}`, {previousSnapshot, currentSnapshot: workBaselineSnapshot(item), notificationRecipients: workNotificationRecipients(item)});
    return clone(item);
  }

  async deleteWorkItem(context, projectId, workItemId, input) {
    const item = this.workItems.get(workItemId);
    if (!item || item.projectId !== projectId) throw new NotFoundError("Task not found");
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    if (Number(input.version) !== Number(item.version)) throw new ConflictError();
    if ([...this.workItems.values()].some((candidate) => candidate.parentId === workItemId
      || candidate.blockedBy?.includes(workItemId)
      || candidate.relatedIds?.includes(workItemId)
      || candidate.relations?.some((relation) => relation.targetId === workItemId))) {
      throw new ConflictError("Remove task hierarchy and relation references before deleting this task");
    }
    this.workItems.delete(workItemId);
    this.recordActivity(context, projectId, "work-item", workItemId, "work.deleted", ["id"], `Deleted task ${item.title}`, {previousSnapshot: workBaselineSnapshot(item), notificationRecipients: workNotificationRecipients(item)});
    return {id: workItemId, deleted: true};
  }

  /**
   * @param {{workspaceId: string, membership?: {projectIds?: string[]}}} context
   * @param {{version: number, projectId: string, limit: number, cursor?: string}} query
   */
  async listMeetingsPage(context, query) {
    if (!query.projectId) {
      const items = [...this.meetings.values()]
        .filter((meeting) => meeting.workspaceId === context.workspaceId && hasProjectAccess(meeting.projectId, context.membership?.projectIds))
        .map(clone)
        .sort(compareMeetings)
        .slice(0, query.limit);
      return {items, pageInfo: meetingPageInfo(false)};
    }
    await this.getProject(query.projectId, context.workspaceId, context.membership?.projectIds);
    const cursorKey = decodeMeetingCursor(query.cursor, {
      adapter: "memory",
      workspaceId: context.workspaceId,
      query
    });
    if (cursorKey && (typeof cursorKey.startsAt !== "string" || typeof cursorKey.id !== "string")) {
      throw new ValidationError("Cursor key is invalid for this meeting query");
    }
    let meetings = [...this.meetings.values()]
      .filter((meeting) => meeting.projectId === query.projectId && meeting.workspaceId === context.workspaceId)
      .map(clone)
      .sort(compareMeetings);
    if (cursorKey) meetings = meetings.filter((meeting) => isAfterMemoryMeetingCursor(meeting, cursorKey));
    const items = meetings.slice(0, query.limit);
    const hasNextPage = meetings.length > items.length;
    const endCursor = hasNextPage && items.length
      ? encodeMeetingCursor({
        adapter: "memory",
        workspaceId: context.workspaceId,
        query,
        key: memoryMeetingCursorKey(items.at(-1))
      })
      : undefined;
    return {items, pageInfo: meetingPageInfo(hasNextPage, endCursor)};
  }

  /**
   * @param {{workspaceId: string, membership?: {projectIds?: string[]}}} context
   * @param {string} projectId
   * @param {string} meetingId
   */
  async getMeeting(context, projectId, meetingId) {
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const meeting = this.meetings.get(`${projectId}:${meetingId}`);
    if (!meeting || meeting.workspaceId !== context.workspaceId) throw new NotFoundError("Meeting not found");
    return clone(meeting);
  }

  /**
   * @param {{workspaceId: string}} context
   * @param {string} projectId
   * @param {string[]} participantIds
   */
  assertMeetingParticipants(context, projectId, participantIds) {
    for (const participantId of participantIds) {
      const membership = this.memberships.get(`${context.workspaceId}:${participantId}`);
      const active = membership && (membership.status === undefined || membership.status === "active");
      if (!active || !hasProjectAccess(projectId, membership.projectIds)) {
        throw new ValidationError("participantIds must reference active project members");
      }
    }
  }

  /** @param {string} projectId @param {Record<string, any>} meeting */
  assertMeetingWorkItems(projectId, meeting) {
    const projectWorkItemIds = new Set([...this.workItems.values()]
      .filter((item) => item.projectId === projectId)
      .map((item) => item.id));
    if (meetingWorkItemIds(meeting).some((workItemId) => !projectWorkItemIds.has(workItemId))) {
      throw new ValidationError("Meeting work item links must belong to the meeting project");
    }
  }

  assertMeetingAttachments(projectId, meeting) {
    if ((meeting.attachmentIds ?? []).some((id) => this.documents.get(id)?.projectId !== projectId)) throw new ValidationError("Meeting attachments must belong to the meeting project");
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string, membership?: {projectIds?: string[]}}} context
   * @param {Record<string, any>} input
   */
  async createMeeting(context, input) {
    await this.getProject(input.projectId, context.workspaceId, context.membership?.projectIds);
    const participantIds = [context.actorId, ...input.participantIds.filter((id) => id !== context.actorId)];
    if (participantIds.length > maxMeetingParticipants) {
      throw new ValidationError(`participantIds must contain at most ${maxMeetingParticipants} entries including the creator`);
    }
    const canonicalInput = {...input, participantIds};
    const requestHash = meetingCreateRequestHash(canonicalInput);
    const claimKey = context.idempotencyKey
      ? meetingCreateKeyHash(context, context.idempotencyKey)
      : undefined;
    if (claimKey) {
      const claim = this.meetingIdempotencyClaims.get(claimKey);
      if (claim?.requestHash !== undefined && claim.requestHash !== requestHash) {
        throw new ConflictError("Idempotency key was already used with a different meeting request");
      }
      if (claim?.result) return clone(claim.result);
    }
    const now = this.now();
    const meeting = {
      id: newId(),
      workspaceId: context.workspaceId,
      version: 1,
      createdBy: context.actorId,
      updatedBy: context.actorId,
      createdAt: now,
      updatedAt: now,
      ...canonicalInput
    };
    if (meeting.recurrence) meeting.seriesId = meeting.id;
    assertMeetingPayloadSize(meeting);
    this.assertMeetingParticipants(context, input.projectId, participantIds);
    assertMeetingPresenters(meeting);
    this.assertMeetingWorkItems(input.projectId, meeting);
    this.assertMeetingAttachments(input.projectId, meeting);
    this.meetings.set(`${input.projectId}:${meeting.id}`, meeting);
    this.recordActivity(context, input.projectId, "meeting", meeting.id, "meeting.created", ["title", "startsAt"], `Created meeting ${meeting.title}`);
    if (claimKey) this.meetingIdempotencyClaims.set(claimKey, {requestHash, result: clone(meeting)});
    return clone(meeting);
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string, membership?: {projectIds?: string[]}}} context
   * @param {string} projectId
   * @param {string} meetingId
   * @param {Record<string, any>} patch
   */
  async patchMeeting(context, projectId, meetingId, patch) {
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const key = `${projectId}:${meetingId}`;
    const current = this.meetings.get(key);
    if (!current || current.workspaceId !== context.workspaceId) throw new NotFoundError("Meeting not found");
    if (Number(patch.version) !== Number(current.version)) throw new ConflictError();
    const {projectId: _projectId, version: _version, ...updates} = patch;
    const next = {...current, ...updates};
    assertMeetingUpdate(current, next, patch);
    if (!next.participantIds.includes(current.createdBy)) {
      throw new ValidationError("The meeting creator must remain a participant");
    }
    const participantIdsToValidate = meetingParticipantIdsToValidate(current, next, patch);
    if (participantIdsToValidate.length) this.assertMeetingParticipants(context, projectId, participantIdsToValidate);
    if (patch.participantIds !== undefined || patch.agendaItems !== undefined || patch.attendance !== undefined) assertMeetingPresenters(next);
    if (patch.agendaItems !== undefined) this.assertMeetingWorkItems(projectId, next);
    if (patch.attachmentIds !== undefined) this.assertMeetingAttachments(projectId, next);
    const changed = Object.keys(updates).filter((field) => JSON.stringify(current[field]) !== JSON.stringify(next[field]));
    next.version = Number(current.version) + 1;
    next.updatedAt = this.now();
    next.updatedBy = context.actorId;
    this.meetings.set(key, next);
    this.recordActivity(context, projectId, "meeting", meetingId, "meeting.updated", changed, `Updated meeting ${next.title}`);
    return clone(next);
  }

  async copyMeeting(context, projectId, meetingId, input) {
    const source = await this.getMeeting(context, projectId, meetingId);
    const agendaItems = (source.agendaItems ?? []).map((item) => ({...clone(item), outcome: ""}));
    return this.createMeeting(context, {
      projectId,
      title: input.title ?? `${source.title} copy`,
      description: source.description ?? "",
      startsAt: input.startsAt ?? source.startsAt,
      endsAt: input.endsAt ?? source.endsAt,
      status: "draft",
      location: source.location ?? "",
      participantIds: source.participantIds ?? [],
      agendaItems,
      minutes: "",
      recurrence: source.recurrence,
      template: input.asTemplate,
      attachmentIds: source.attachmentIds ?? [],
      attendance: (source.participantIds ?? []).map((userId) => ({userId, status: "invited", note: ""})),
      invitationMessage: source.invitationMessage ?? ""
    });
  }

  async deleteMeeting(context, projectId, meetingId, input) {
    const meeting = await this.getMeeting(context, projectId, meetingId);
    if (Number(input.version) !== Number(meeting.version)) throw new ConflictError();
    this.meetings.delete(`${projectId}:${meetingId}`);
    this.recordActivity(context, projectId, "meeting", meetingId, "meeting.deleted", ["id"], `Deleted meeting ${meeting.title}`);
    return {id: meetingId, deleted: true};
  }

  async respondMeetingAttendance(context, projectId, meetingId, input) {
    const meeting = await this.getMeeting(context, projectId, meetingId);
    if (!meeting.participantIds?.includes(context.actorId)) throw new ForbiddenError("Only participants can respond to an invitation");
    const attendance = [...(meeting.attendance ?? []).filter((item) => item.userId !== context.actorId), {userId: context.actorId, status: input.status, note: input.note}];
    return this.patchMeeting(context, projectId, meetingId, {projectId, version: input.version, attendance});
  }

  async exportMeetingCalendar(context, projectId, meetingId) {
    const meeting = await this.getMeeting(context, projectId, meetingId);
    return {contentType: "text/calendar; charset=utf-8", filename: `${meeting.id}.ics`, content: meetingICalendar(meeting)};
  }

  async exportMeetingPdf(context, projectId, meetingId) {
    const meeting = await this.getMeeting(context, projectId, meetingId);
    const branding = (await this.getWorkspaceCapabilities(context)).branding ?? {};
    return {contentType: "application/pdf", filename: `${meeting.id}.pdf`, base64: meetingPdfBase64(meeting, branding)};
  }

  async listProjectContent(context, filters = {}) {
    await this.getProject(filters.projectId, context.workspaceId, context.membership?.projectIds);
    let items = [...this.projectContent.values()].filter((item) => (
      item.workspaceId === context.workspaceId && item.projectId === filters.projectId
    ));
    if (filters.kind) items = items.filter((item) => item.kind === filters.kind);
    if (filters.status) items = items.filter((item) => item.status === filters.status);
    if (filters.search) items = items.filter((item) => includesFolded(`${item.title} ${item.body} ${(item.tags ?? []).join(" ")}`, filters.search));
    return items.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
      || String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, filters.limit ?? 100).map(clone);
  }

  async getProjectContent(context, projectId, contentId) {
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const item = this.projectContent.get(`${projectId}:${contentId}`);
    if (!item || item.workspaceId !== context.workspaceId) throw new NotFoundError("Project content not found");
    return clone(item);
  }

  assertProjectContentParent(projectId, contentId, parentId) {
    if (!parentId) return;
    if (parentId === contentId) throw new ValidationError("Content cannot be its own parent");
    const parent = this.projectContent.get(`${projectId}:${parentId}`);
    if (!parent) throw new ValidationError("Content parent must exist in the same project");
    const visited = new Set([contentId]);
    let current = parent;
    while (current?.parentId) {
      if (visited.has(current.parentId)) throw new ValidationError("Content hierarchy cannot contain a cycle");
      visited.add(current.parentId);
      current = this.projectContent.get(`${projectId}:${current.parentId}`);
    }
  }

  saveContentRevision(item, actorId, collaboration = {}) {
    const revisions = this.contentRevisions.get(item.id) ?? [];
    revisions.push({
      contentId: item.id,
      projectId: item.projectId,
      version: item.version,
      title: item.title,
      body: item.body,
      format: item.format,
      status: item.status,
      parentId: item.parentId,
      tags: clone(item.tags ?? []),
      actorId,
      createdAt: item.updatedAt,
      ...clone(collaboration)
    });
    this.contentRevisions.set(item.id, revisions);
  }

  async createProjectContent(context, input) {
    await this.getProject(input.projectId, context.workspaceId, context.membership?.projectIds);
    this.assertProjectContentParent(input.projectId, undefined, input.parentId);
    const now = this.now();
    const item = {
      id: newId(),
      workspaceId: context.workspaceId,
      version: 1,
      createdBy: context.actorId,
      updatedBy: context.actorId,
      createdAt: now,
      updatedAt: now,
      ...input
    };
    this.projectContent.set(`${input.projectId}:${item.id}`, item);
    this.saveContentRevision(item, context.actorId);
    this.recordActivity(context, input.projectId, input.kind, item.id, "content.created", ["title", "body"], `Created ${input.kind} ${item.title}`);
    return clone(item);
  }

  async patchProjectContent(context, projectId, contentId, patch) {
    const current = await this.getProjectContent(context, projectId, contentId);
    if (Number(patch.version) !== Number(current.version)) throw new ConflictError();
    const {version: _version, ...updates} = patch;
    if (current.status === "locked" && !(Object.keys(updates).length === 1 && updates.status !== undefined)) {
      throw new ConflictError("Locked content must be unlocked before editing");
    }
    this.assertProjectContentParent(projectId, contentId, updates.parentId ?? current.parentId);
    const changed = Object.keys(updates).filter((field) => JSON.stringify(current[field]) !== JSON.stringify(updates[field]));
    const item = {...current, ...updates, version: current.version + 1, updatedBy: context.actorId, updatedAt: this.now()};
    this.projectContent.set(`${projectId}:${contentId}`, item);
    this.saveContentRevision(item, context.actorId);
    this.recordActivity(context, projectId, item.kind, item.id, "content.updated", changed, `Updated ${item.kind} ${item.title}`);
    return clone(item);
  }

  async applyProjectContentOperations(context, projectId, contentId, input) {
    const current = await this.getProjectContent(context, projectId, contentId);
    if (current.status === "locked") throw new ConflictError("Locked content must be unlocked before editing");
    const merged = mergeContentOperations(current, this.contentRevisions.get(contentId) ?? [], input);
    if (merged.duplicate) return clone({...current, collaboration: {duplicate: true, merged: false, baseVersion: input.version}});
    const updated = {...current, body: merged.body, version: Number(current.version) + 1, updatedBy: context.actorId, updatedAt: this.now()};
    this.projectContent.set(`${projectId}:${contentId}`, updated);
    this.saveContentRevision(updated, context.actorId, {collaborationOperation: merged.operation, collaborationKey: merged.collaborationKey, collaborationBaseVersion: merged.baseVersion});
    this.recordActivity(context, projectId, current.kind, contentId, "content.operations.applied", ["body"], `Applied ${input.operations.length} collaborative operations`, {clientId: input.clientId});
    return clone({...updated, collaboration: {duplicate: false, merged: merged.merged, baseVersion: merged.baseVersion}});
  }

  async updateProjectContentPresence(context, projectId, contentId, input) {
    await this.getProjectContent(context, projectId, contentId);
    const now = this.now();
    const item = {workspaceId: context.workspaceId, projectId, contentId, userId: context.actorId, userName: context.user?.name ?? context.actorId, ...input, seenAt: now, expiresAt: Math.floor(new Date(now).getTime() / 1000) + 120};
    this.contentPresence.set(`${projectId}:${contentId}:${context.actorId}:${input.clientId}`, item);
    return clone(item);
  }

  async listProjectContentPresence(context, projectId, contentId) {
    await this.getProjectContent(context, projectId, contentId);
    const now = Math.floor(new Date(this.now()).getTime() / 1000);
    return [...this.contentPresence.values()].filter((item) => item.projectId === projectId && item.contentId === contentId && item.expiresAt > now).map(clone);
  }

  async deleteProjectContent(context, projectId, contentId, input) {
    const item = await this.getProjectContent(context, projectId, contentId);
    if (Number(input.version) !== Number(item.version)) throw new ConflictError();
    if ([...this.projectContent.values()].some((candidate) => candidate.projectId === projectId && candidate.parentId === contentId)) {
      throw new ConflictError("Move or delete child content first");
    }
    this.projectContent.delete(`${projectId}:${contentId}`);
    this.recordActivity(context, projectId, item.kind, item.id, "content.deleted", ["id"], `Deleted ${item.kind} ${item.title}`);
    return {id: contentId, deleted: true};
  }

  async listProjectContentRevisions(context, projectId, contentId) {
    await this.getProjectContent(context, projectId, contentId);
    return clone((this.contentRevisions.get(contentId) ?? []).sort((a, b) => b.version - a.version));
  }

  async listPlanningResources(context, filters = {}) {
    await this.getProject(filters.projectId, context.workspaceId, context.membership?.projectIds);
    let items = [...this.planningResources.values()].filter((item) => item.projectId === filters.projectId && item.workspaceId === context.workspaceId);
    const canManageBoards = [roles.admin, roles.portfolioManager, roles.projectManager].includes(context.membership?.role);
    if (!canManageBoards) items = items.filter((item) => item.kind !== "board" || !item.boardEditorIds?.length || item.boardEditorIds.includes(context.actorId));
    if (filters.kind) items = items.filter((item) => item.kind === filters.kind);
    if (filters.status) items = items.filter((item) => item.status === filters.status);
    const projectWork = [...this.workItems.values()].filter((item) => item.projectId === filters.projectId);
    return items.sort((a, b) => String(a.startDate ?? "9999-12-31").localeCompare(String(b.startDate ?? "9999-12-31")))
      .slice(0, filters.limit ?? 100)
      .map((item) => {
        const linked = item.kind === "version"
          ? projectWork.filter((work) => work.versionId === item.id || !work.versionId && work.versionName === item.name)
          : item.kind === "sprint" ? projectWork.filter((work) => work.sprintId === item.id) : [];
        return clone({...item, workItemCount: linked.length, completedPoints: linked.reduce((sum, work) => sum + Number(work.percentComplete >= 100 ? work.effortPoints ?? 0 : 0), 0), totalPoints: linked.reduce((sum, work) => sum + Number(work.effortPoints ?? 0), 0)});
      });
  }

  async getPlanningResource(context, projectId, resourceId) {
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const item = this.planningResources.get(`${projectId}:${resourceId}`);
    if (!item || item.workspaceId !== context.workspaceId) throw new NotFoundError("Planning resource not found");
    const canManageBoard = [roles.admin, roles.portfolioManager, roles.projectManager].includes(context.membership?.role);
    if (item.kind === "board" && item.boardEditorIds?.length && !item.boardEditorIds.includes(context.actorId) && !canManageBoard) throw new NotFoundError("Planning resource not found");
    return clone(item);
  }

  async createPlanningResource(context, input) {
    await this.getProject(input.projectId, context.workspaceId, context.membership?.projectIds);
    for (const sharedProjectId of input.sharedProjectIds ?? []) await this.getProject(sharedProjectId, context.workspaceId, context.membership?.projectIds);
    if (input.kind === "version") {
      const capabilities = await this.getWorkspaceCapabilities(context);
      input.customFields = validateAndCalculateCustomFields(capabilities, "version", input.customFields ?? {}, {});
    }
    const now = this.now();
    const snapshot = input.kind === "baseline" ? [...this.workItems.values()]
      .filter((item) => item.projectId === input.projectId)
      .slice(0, 100)
      .map((item) => Object.fromEntries(["id", "title", "startDate", "dueDate", "status", "percentComplete", "estimateMinutes", "remainingMinutes"].map((field) => [field, item[field]]).filter(([, value]) => value !== undefined))) : undefined;
    const item = {
      id: newId(),
      workspaceId: context.workspaceId,
      version: 1,
      createdBy: context.actorId,
      updatedBy: context.actorId,
      createdAt: now,
      updatedAt: now,
      ...input,
      ...(snapshot ? {snapshot, capturedAt: now} : {})
    };
    this.planningResources.set(`${input.projectId}:${item.id}`, item);
    this.recordActivity(context, input.projectId, "planning-resource", item.id, "planning-resource.created", ["kind", "name"], `Created ${item.kind} ${item.name}`);
    return clone(item);
  }

  async patchPlanningResource(context, projectId, resourceId, patch) {
    const current = await this.getPlanningResource(context, projectId, resourceId);
    if (Number(patch.version) !== Number(current.version)) throw new ConflictError();
    if (current.kind === "version" && patch.customFields !== undefined) {
      const capabilities = await this.getWorkspaceCapabilities(context);
      patch.customFields = validateAndCalculateCustomFields(capabilities, "version", patch.customFields, current.customFields ?? {});
    }
    const {version: _version, ...updates} = patch;
    const startDate = updates.startDate === "" ? undefined : updates.startDate ?? current.startDate;
    const endDate = updates.endDate === "" ? undefined : updates.endDate ?? current.endDate;
    if (startDate && endDate && endDate < startDate) throw new ValidationError("endDate must not be before startDate");
    for (const sharedProjectId of updates.sharedProjectIds ?? []) await this.getProject(sharedProjectId, context.workspaceId, context.membership?.projectIds);
    const changed = Object.keys(updates).filter((field) => JSON.stringify(current[field]) !== JSON.stringify(updates[field]));
    const item = {...current, ...updates, startDate, endDate, version: current.version + 1, updatedBy: context.actorId, updatedAt: this.now()};
    this.planningResources.set(`${projectId}:${resourceId}`, item);
    this.recordActivity(context, projectId, "planning-resource", resourceId, "planning-resource.updated", changed, `Updated ${item.kind} ${item.name}`);
    return clone(item);
  }

  async deletePlanningResource(context, projectId, resourceId, input) {
    const item = await this.getPlanningResource(context, projectId, resourceId);
    if (Number(input.version) !== Number(item.version)) throw new ConflictError();
    if ([...this.workItems.values()].some((work) => work.projectId === projectId && (work.versionId === resourceId || work.sprintId === resourceId))) {
      throw new ConflictError("Remove task links before deleting this planning resource");
    }
    this.planningResources.delete(`${projectId}:${resourceId}`);
    this.recordActivity(context, projectId, "planning-resource", resourceId, "planning-resource.deleted", ["id"], `Deleted ${item.kind} ${item.name}`);
    return {id: resourceId, deleted: true};
  }

  async comparePlanningBaseline(context, projectId, baselineId) {
    const baseline = await this.getPlanningResource(context, projectId, baselineId);
    if (baseline.kind !== "baseline") throw new ValidationError("Planning resource is not a baseline");
    const workItems = [...this.workItems.values()].filter((item) => item.projectId === projectId).map(clone);
    return compareProjectBaseline(workItems, baseline);
  }

  async compareHistoricalBaseline(context, projectId, from, to) {
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const workItems = [...this.workItems.values()].filter((item) => item.projectId === projectId).map(clone);
    return compareProjectHistory(workItems, await this.listActivity(projectId, context.workspaceId), from, to);
  }

  async getSprintBurndown(context, projectId, sprintId) {
    const sprint = await this.getPlanningResource(context, projectId, sprintId);
    if (sprint.kind !== "sprint" || !sprint.startDate || !sprint.endDate) throw new ValidationError("Sprint must have start and end dates");
    const items = [...this.workItems.values()].filter((item) => item.projectId === projectId && item.sprintId === sprintId);
    const totalPoints = items.reduce((sum, item) => sum + Number(item.effortPoints ?? 0), 0);
    const remainingPoints = items.reduce((sum, item) => sum + Number(item.percentComplete >= 100 ? 0 : item.effortPoints ?? 0), 0);
    const dates = [];
    for (let value = new Date(`${sprint.startDate}T00:00:00Z`), end = new Date(`${sprint.endDate}T00:00:00Z`); value <= end && dates.length < 370; value.setUTCDate(value.getUTCDate() + 1)) dates.push(value.toISOString().slice(0, 10));
    return {
      sprint,
      totalPoints,
      remainingPoints,
      completedPoints: totalPoints - remainingPoints,
      series: dates.map((date, index) => ({date, idealRemaining: Math.round(totalPoints * (1 - index / Math.max(1, dates.length - 1)) * 10) / 10, ...(date === this.now().slice(0, 10) || index === dates.length - 1 ? {actualRemaining: remainingPoints} : {})}))
    };
  }

  async scheduleProject(context, projectId) {
    const project = await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const resources = await this.listPlanningResources(context, {projectId, kind: "work-calendar"});
    const calendar = resources.find((item) => item.default) ?? resources.find((item) => item.status === "active") ?? resources[0] ?? {};
    const workItems = [...this.workItems.values()].filter((item) => item.projectId === projectId).map(clone);
    const result = calculateProjectSchedule(workItems, calendar, {projectStartDate: project.startDate, today: this.now().slice(0, 10)});
    for (const update of result.updates) {
      const current = this.workItems.get(update.id);
      if (!current) continue;
      for (const field of ["startDate", "dueDate", "estimateMinutes", "remainingMinutes", "recordedMinutes", "percentComplete"]) {
        if (update[field] !== undefined) current[field] = update[field];
      }
      current.version += 1;
      current.updatedAt = this.now();
    }
    this.recordActivity(context, projectId, "project", projectId, "schedule.calculated", ["startDate", "dueDate"], `Scheduled ${result.updates.length} tasks`);
    return {...result, items: result.items.map(clone)};
  }

  /**
   * @param {{userId?: string, projectId?: string}} filters
   */
  async listTimeEntries(filters = {}) {
    let entries = [...this.timeEntries.values()];
    if (filters.workspaceId) entries = entries.filter((entry) => entry.workspaceId === filters.workspaceId);
    if (Array.isArray(filters.allowedProjectIds) && filters.allowedProjectIds.length) entries = entries.filter((entry) => !entry.projectId || filters.allowedProjectIds.includes(entry.projectId));
    if (filters.userId) entries = entries.filter((entry) => entry.userId === filters.userId);
    if (filters.projectId) entries = entries.filter((entry) => entry.projectId === filters.projectId);
    entries = entries.map(clone).sort((a, b) => String(b.entryDate).localeCompare(String(a.entryDate)));
    return filters.limit ? entries.slice(0, Number(filters.limit)) : entries;
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string}} context
   * @param {ReturnType<import("@teamspaces/contracts").parseTimeEntryInput>} input
   */
  async createTimeEntry(context, input) {
    const capabilities = await this.getWorkspaceCapabilities(context);
    if (capabilities.work?.exactTimeRequired && (!input.startedAt || !input.endedAt)) throw new ValidationError("Exact start and end times are required");
    const activity = (capabilities.timeEntryActivities ?? []).find((item) => item.id === input.activityId && item.active !== false);
    if (!activity) throw new ValidationError("Time entry activity is not active");
    input.customFields = validateAndCalculateCustomFields(capabilities, "time-entry", input.customFields ?? {}, {});
    if (input.projectId && this.projects.get(input.projectId)?.workspaceId !== context.workspaceId) throw new NotFoundError("Project not found");
    if (input.projectId && !hasProjectAccess(input.projectId, context.membership?.projectIds)) throw new NotFoundError("Project not found");
    let workItem;
    if (input.workItemId) {
      const item = this.workItems.get(input.workItemId);
      if (!item || this.projects.get(item.projectId)?.workspaceId !== context.workspaceId) throw new NotFoundError("Task not found");
      if (!hasProjectAccess(item.projectId, context.membership?.projectIds)) throw new NotFoundError("Task not found");
      workItem = item;
    }
    const now = this.now();
    const entry = {
      id: newId(),
      workspaceId: context.workspaceId,
      userId: context.actorId,
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...input,
      projectId: input.projectId ?? workItem?.projectId
    };
    this.timeEntries.set(entry.id, entry);
    if (entry.workItemId && this.workItems.has(entry.workItemId)) {
      const item = this.workItems.get(entry.workItemId);
      item.recordedMinutes = Number(item.recordedMinutes ?? 0) + entry.durationMinutes;
    }
    const projectId = entry.projectId ?? this.workItems.get(entry.workItemId ?? "")?.projectId;
    this.recordActivity(context, projectId, "time-entry", entry.id, "time.created", ["durationMinutes"], `Recorded ${entry.durationMinutes} minutes`);
    return clone(entry);
  }

  async patchTimeEntry(context, timeEntryId, patch) {
    const entry = this.timeEntries.get(timeEntryId);
    if (!entry || entry.workspaceId !== context.workspaceId || entry.userId !== context.actorId) throw new NotFoundError("Time entry not found");
    if (Number(entry.version) !== Number(patch.version)) throw new ConflictError();
    const previousDuration = Number(entry.durationMinutes);
    const capabilities = await this.getWorkspaceCapabilities(context);
    if (capabilities.work?.exactTimeRequired && (!(patch.startedAt ?? entry.startedAt) || !(patch.endedAt ?? entry.endedAt))) throw new ValidationError("Exact start and end times are required");
    const activityId = patch.activityId ?? entry.activityId ?? "general";
    if (!(capabilities.timeEntryActivities ?? []).some((item) => item.id === activityId && item.active !== false)) throw new ValidationError("Time entry activity is not active");
    if (patch.customFields !== undefined) patch.customFields = validateAndCalculateCustomFields(capabilities, "time-entry", patch.customFields, entry.customFields ?? {});
    for (const field of ["entryDate", "durationMinutes", "startedAt", "endedAt", "description", "billable", "activityId", "customFields"]) {
      if (patch[field] !== undefined) entry[field] = patch[field];
    }
    entry.version += 1;
    entry.updatedAt = this.now();
    const item = entry.workItemId ? this.workItems.get(entry.workItemId) : undefined;
    if (item) item.recordedMinutes = Math.max(0, Number(item.recordedMinutes ?? 0) + Number(entry.durationMinutes) - previousDuration);
    this.recordActivity(context, entry.projectId, "time-entry", entry.id, "time.updated", ["entryDate", "durationMinutes", "description", "billable"], `Updated ${entry.durationMinutes} minutes`);
    return clone(entry);
  }

  async deleteTimeEntry(context, timeEntryId, input) {
    const entry = this.timeEntries.get(timeEntryId);
    if (!entry || entry.workspaceId !== context.workspaceId || entry.userId !== context.actorId) throw new NotFoundError("Time entry not found");
    if (Number(entry.version) !== Number(input.version)) throw new ConflictError();
    this.timeEntries.delete(timeEntryId);
    const item = entry.workItemId ? this.workItems.get(entry.workItemId) : undefined;
    if (item) item.recordedMinutes = Math.max(0, Number(item.recordedMinutes ?? 0) - Number(entry.durationMinutes));
    this.recordActivity(context, entry.projectId, "time-entry", entry.id, "time.deleted", ["id"], `Deleted ${entry.durationMinutes} minutes`);
    return {id: timeEntryId, deleted: true};
  }

  timerKey(context) {
    return `${context.workspaceId}:${context.actorId}`;
  }

  async getTimer(context) {
    return clone(this.timers.get(this.timerKey(context)) ?? {active: false});
  }

  async startTimer(context, input) {
    if (this.timers.has(this.timerKey(context))) throw new ConflictError("A timer is already running");
    if (input.projectId) await this.getProject(input.projectId, context.workspaceId, context.membership?.projectIds);
    const workItem = input.workItemId ? this.workItems.get(input.workItemId) : undefined;
    if (input.workItemId && (!workItem || this.projects.get(workItem.projectId)?.workspaceId !== context.workspaceId || !hasProjectAccess(workItem.projectId, context.membership?.projectIds))) {
      throw new NotFoundError("Task not found");
    }
    const timer = {
      active: true,
      workspaceId: context.workspaceId,
      userId: context.actorId,
      startedAt: this.now(),
      projectId: input.projectId ?? workItem?.projectId,
      workItemId: input.workItemId,
      description: input.description,
      billable: input.billable,
      activityId: input.activityId,
      customFields: input.customFields,
      version: 1
    };
    this.timers.set(this.timerKey(context), timer);
    return clone(timer);
  }

  async stopTimer(context) {
    const key = this.timerKey(context);
    const timer = this.timers.get(key);
    if (!timer) throw new ConflictError("No timer is running");
    const durationMinutes = Math.max(1, Math.min(1440, Math.ceil((new Date(this.now()).getTime() - new Date(timer.startedAt).getTime()) / 60000)));
    const entry = await this.createTimeEntry(context, {
      projectId: timer.projectId,
      workItemId: timer.workItemId,
      entryDate: this.now().slice(0, 10),
      durationMinutes,
      startedAt: timer.startedAt,
      endedAt: this.now(),
      description: timer.description,
      billable: timer.billable,
      activityId: timer.activityId,
      customFields: timer.customFields
    });
    this.timers.delete(key);
    return {timer: {active: false}, entry};
  }

  /**
   * @param {string | undefined} projectId
   */
  async listActivity(projectId, workspaceId = "", limit) {
    const activities = this.activities
      .filter((activity) => !projectId || activity.projectId === projectId)
      .filter((activity) => !workspaceId || activity.workspaceId === workspaceId)
      .map((activity) => ({
        ...clone(activity),
        actorName: this.users.get(activity.actorId)?.name ?? activity.actorId,
        actorEmail: this.users.get(activity.actorId)?.email
      }))
      .sort((a, b) => String(a.reverseTimestamp).localeCompare(String(b.reverseTimestamp)));
    return limit ? activities.slice(0, Number(limit)) : activities;
  }

  async getNotificationReadStates(context, activityIds = []) {
    return Object.fromEntries(activityIds.flatMap((activityId) => {
      const marker = this.notificationReads.get(`${context.workspaceId}:${context.actorId}:${activityId}`);
      return marker?.readAt ? [[activityId, marker.readAt]] : [];
    }));
  }

  async setNotificationReadStates(context, activityIds = [], read = true) {
    const ids = [...new Set(activityIds)].slice(0, 100);
    const readAt = this.now();
    for (const activityId of ids) {
      const key = `${context.workspaceId}:${context.actorId}:${activityId}`;
      if (read) this.notificationReads.set(key, {workspaceId: context.workspaceId, userId: context.actorId, activityId, readAt});
      else this.notificationReads.delete(key);
    }
    return {ids, count: ids.length, read: Boolean(read), ...(read ? {readAt} : {})};
  }

  async getNotificationPreferences(context, capabilities) {
    const stored = this.notificationPreferences.get(`${context.workspaceId}:${context.actorId}`);
    return effectiveNotificationPreferences(capabilities ?? await this.getWorkspaceCapabilities(context), stored);
  }

  async saveNotificationPreferences(context, input) {
    const current = await this.getNotificationPreferences(context);
    if (Number(input.version) !== Number(current.version)) throw new ConflictError("Notification preferences changed; reload and try again");
    const now = this.now();
    const item = {...clone(input), workspaceId: context.workspaceId, userId: context.actorId, version: Number(current.version) + 1, createdAt: current.createdAt ?? now, updatedAt: now};
    this.notificationPreferences.set(`${context.workspaceId}:${context.actorId}`, item);
    this.recordActivity(context, undefined, "notification-preferences", context.actorId, "notification-preferences.updated", ["participationRules", "projectOverrides", "dateAlertsEnabled", "emailDigest", "deliveryWebhookId", "digestHourUtc", "weeklyDay"], "Updated notification preferences");
    return clone(item);
  }

  async listScheduledNotificationPreferences(now = new Date()) {
    return [...this.notificationPreferences.values()]
      .filter((item) => item.emailDigest !== "none" && Number(item.digestHourUtc) === now.getUTCHours())
      .map(clone);
  }

  async claimScheduledNotificationDigest(preferences, periodKey) {
    const key = `${preferences.workspaceId}:${preferences.userId}:${periodKey}`;
    if (this.notificationDigestClaims.has(key)) return false;
    this.notificationDigestClaims.set(key, {workspaceId: preferences.workspaceId, userId: preferences.userId, periodKey, status: "processing", createdAt: this.now()});
    return true;
  }

  async getNotificationDeliveryContext(preferences) {
    const membership = this.memberships.get(`${preferences.workspaceId}:${preferences.userId}`);
    const workspace = this.workspaces.get(preferences.workspaceId);
    const user = this.users.get(preferences.userId);
    if (!workspace || !user || !isActiveMembership(membership) || membership.placeholder) return undefined;
    return {workspaceId: preferences.workspaceId, actorId: preferences.userId, correlationId: `notification-digest-${newId()}`, workspace: clone(workspace), user: clone(user), membership: clone(membership)};
  }

  async completeScheduledNotificationDigest(preferences, periodKey, result) {
    const key = `${preferences.workspaceId}:${preferences.userId}:${periodKey}`;
    this.notificationDigestClaims.set(key, {...(this.notificationDigestClaims.get(key) ?? {}), ...clone(result), status: result.status});
    const stored = this.notificationPreferences.get(`${preferences.workspaceId}:${preferences.userId}`);
    if (stored) {
      stored.lastDeliveryStatus = result.status;
      stored.lastDeliveredAt = result.completedAt;
      stored.lastDeliveryId = result.deliveryId;
    }
  }

  async releaseScheduledNotificationDigest(preferences, periodKey) {
    this.notificationDigestClaims.delete(`${preferences.workspaceId}:${preferences.userId}:${periodKey}`);
  }

  async globalSearch(context, search, limit = 50) {
    const term = String(search).trim();
    if (!term) return {items: [], query: term};
    const allowedProjectIds = context.membership?.projectIds;
    const projects = [...this.projects.values()]
      .filter((project) => project.workspaceId === context.workspaceId && !project.deletedAt && hasProjectAccess(project.id, allowedProjectIds));
    const projectIds = new Set(projects.map((project) => project.id));
    const results = [
      ...projects.filter((item) => includesFolded(`${item.name} ${item.description ?? ""} ${(item.tags ?? []).join(" ")}`, term)).map((item) => ({type: "project", id: item.id, projectId: item.id, title: item.name, summary: item.description ?? "", updatedAt: item.updatedAt})),
      ...[...this.workItems.values()].filter((item) => projectIds.has(item.projectId) && includesFolded(`${item.title} ${item.description ?? ""} ${(item.tags ?? []).join(" ")} ${Object.values(item.customFields ?? {}).join(" ")}`, term)).map((item) => ({type: "work-item", id: item.id, projectId: item.projectId, title: item.title, summary: item.description ?? "", updatedAt: item.updatedAt})),
      ...[...this.documents.values()].filter((item) => projectIds.has(item.projectId) && includesFolded(`${item.name} ${item.filename ?? ""} ${item.description ?? ""} ${(item.tags ?? []).join(" ")} ${item.extractedText ?? ""}`, term)).map((item) => ({type: "document", id: item.id, projectId: item.projectId, title: item.name, summary: item.description ?? item.filename ?? "", updatedAt: item.updatedAt, matchedAttachmentContent: includesFolded(item.extractedText, term)})),
      ...[...this.projectContent.values()].filter((item) => projectIds.has(item.projectId) && includesFolded(`${item.title} ${item.body ?? ""} ${(item.tags ?? []).join(" ")}`, term)).map((item) => ({type: item.kind === "document" ? "collaborative-document" : item.kind, id: item.id, projectId: item.projectId, title: item.title, summary: item.body ?? "", updatedAt: item.updatedAt})),
      ...[...this.meetings.values()].filter((item) => projectIds.has(item.projectId) && includesFolded(`${item.title} ${item.description ?? ""} ${item.minutes ?? ""}`, term)).map((item) => ({type: "meeting", id: item.id, projectId: item.projectId, title: item.title, summary: item.description ?? "", updatedAt: item.updatedAt}))
    ].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);
    return {items: results, query: term};
  }

  async getApplicationDataSummary(context = {}) {
    const activities = await this.listActivity(undefined, context.workspaceId);
    const documents = await this.listDocuments({workspaceId: context.workspaceId});
    const timeEntries = [...this.timeEntries.values()].filter((entry) => !context.workspaceId || entry.workspaceId === context.workspaceId);
    const savedViews = [...this.savedViews.values()].filter((view) => !context.workspaceId || view.workspaceId === context.workspaceId);
    const portfolios = [...this.portfolios.values()].filter((item) => !context.workspaceId || item.workspaceId === context.workspaceId);
    const projects = [...this.projects.values()].filter((item) => !context.workspaceId || item.workspaceId === context.workspaceId);
    const projectIds = new Set(projects.map((project) => project.id));
    const workItems = [...this.workItems.values()].filter((item) => projectIds.has(item.projectId));
    const meetings = [...this.meetings.values()].filter((item) => projectIds.has(item.projectId));
    const memberships = [...this.memberships.values()].filter((membership) => !context.workspaceId || membership.workspaceId === context.workspaceId);
    return {
      workspaceId: context.workspaceId ?? this.workspace.id,
      generatedAt: this.now(),
      records: {
        users: this.users.size,
        memberships: memberships.length,
        portfolios: portfolios.length,
        projects: projects.length,
        workItems: workItems.length,
        meetings: meetings.length,
        timeEntries: timeEntries.length,
        documents: documents.length,
        projectContent: this.projectContent.size,
        savedViews: savedViews.length,
        activities: activities.length
      },
      documentBytes: documents.reduce((sum, document) => sum + Number(document.sizeBytes ?? 0), 0),
      lastActivityAt: activities[0]?.timestamp,
      activityByEntity: Object.fromEntries([...new Set(activities.map((activity) => activity.entityType))]
        .sort()
        .map((entityType) => [entityType, activities.filter((activity) => activity.entityType === entityType).length]))
    };
  }

  /**
   * @param {Record<string, unknown>} [filters]
   */
  async listDocuments(filters = {}) {
    let documents = [...this.documents.values()].map(clone);
    if (filters.workspaceId) documents = documents.filter((document) => document.workspaceId === filters.workspaceId);
    if (Array.isArray(filters.allowedProjectIds) && filters.allowedProjectIds.length) documents = documents.filter((document) => filters.allowedProjectIds.includes(document.projectId));
    if (filters.projectId) documents = documents.filter((document) => document.projectId === filters.projectId);
    if (filters.workItemId) documents = documents.filter((document) => document.workItemId === filters.workItemId);
    if (filters.status) documents = documents.filter((document) => document.status === filters.status);
    if (filters.category) documents = documents.filter((document) => document.category === filters.category);
    if (filters.search) documents = documents.filter((document) => includesFolded(document.name, filters.search) || includesFolded(document.filename, filters.search) || includesFolded(document.description, filters.search));
    documents = documents.map((document) => ({
      ...document,
      projectName: this.projects.get(document.projectId)?.name ?? document.projectId,
      workItemName: document.workItemId ? this.workItems.get(document.workItemId)?.title ?? document.workItemId : undefined
    })).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    documents = documents.map(publicDocument);
    return filters.limit ? documents.slice(0, Number(filters.limit)) : documents;
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string}} context
   * @param {{projectId: string, workItemId?: string, name: string, filename: string, contentType: string, sizeBytes: number, category: string, description?: string, tags?: string[]}} input
   */
  async createDocumentUploadIntent(context, input) {
    if (this.projects.get(input.projectId)?.workspaceId !== context.workspaceId) throw new NotFoundError("Project not found");
    if (!hasProjectAccess(input.projectId, context.membership?.projectIds)) throw new NotFoundError("Project not found");
    if (input.workItemId) {
      const workItem = this.workItems.get(input.workItemId);
      if (!workItem || workItem.projectId !== input.projectId) throw new ValidationError("Document task must belong to the selected project");
    }
    const now = this.now();
    const document = {
      id: newId(),
      workspaceId: context.workspaceId,
      projectId: input.projectId,
      workItemId: input.workItemId,
      name: input.name,
      filename: input.filename,
      contentType: input.contentType,
      checksumSha256: input.checksumSha256,
      sizeBytes: input.sizeBytes,
      category: input.category,
      description: input.description ?? "",
      tags: input.tags ?? [],
      objectKey: `documents/${context.workspaceId}/${input.projectId}/${newId()}/object`,
      status: "pending",
      expiresAt: Math.floor(new Date(now).getTime() / 1000) + 24 * 60 * 60,
      uploadedBy: context.actorId,
      version: 1,
      createdAt: now,
      updatedAt: now
    };
    this.documents.set(document.id, document);
    const intent = {
      id: newId(),
      documentId: document.id,
      workspaceId: context.workspaceId,
      projectId: input.projectId,
      objectKey: document.objectKey,
      expiresAt: Math.floor(new Date(this.now()).getTime() / 1000) + 600,
      uploadUrl: `memory://documents/${document.id}`,
      uploadHeaders: {
        "content-type": input.contentType,
        "if-none-match": "*",
        "x-amz-server-side-encryption": "AES256"
      },
      document: publicDocument(document)
    };
    this.uploadIntents.set(intent.id, intent);
    this.recordActivity(context, input.projectId, "document", document.id, "document.upload-intent.created", ["name", "filename"], `Prepared document ${document.name}`);
    return clone(intent);
  }

  async createDocumentScanRequest(context, projectId, documentId) {
    const document = this.documents.get(documentId);
    if (!document || document.workspaceId !== context.workspaceId || document.projectId !== projectId || !hasProjectAccess(projectId, context.membership?.projectIds)) throw new NotFoundError("Document not found");
    if (document.status !== "pending") throw new ConflictError("Only pending documents can be scanned");
    const capabilities = await this.getWorkspaceCapabilities(context);
    const webhook = capabilities.webhooks?.find((item) => item.id === capabilities.security?.scannerWebhookId && item.enabled !== false);
    if (capabilities.security?.malwareScanning === "disabled" || !webhook) return {scanRequested: false, required: false, document: publicDocument(document)};
    document.scanStatus = "queued";
    document.scanRequestedAt = this.now();
    document.version = Number(document.version ?? 1) + 1;
    document.updatedAt = document.scanRequestedAt;
    this.recordActivity(context, projectId, "document", documentId, "document.scan.requested", ["scanStatus"], `Requested malware scan for ${document.name}`);
    return {
      scanRequested: true,
      required: capabilities.security?.malwareScanning === "required",
      document: publicDocument(document),
      job: {
        workspaceId: context.workspaceId,
        projectId,
        documentId,
        objectUrl: `memory://documents/${documentId}/scanner-download`,
        callbackPath: `/api/v1/documents/${encodeURIComponent(documentId)}/scan?projectId=${encodeURIComponent(projectId)}`,
        checksumSha256: document.checksumSha256,
        sizeBytes: document.sizeBytes,
        contentType: document.contentType
      }
    };
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string}} context
   * @param {{documentId: string, projectId?: string}} input
   */
  async finalizeDocument(context, input) {
    const document = this.documents.get(input.documentId);
    if (!document) throw new NotFoundError("Document not found");
    if (document.workspaceId !== context.workspaceId) throw new NotFoundError("Document not found");
    if (!hasProjectAccess(document.projectId, context.membership?.projectIds)) throw new NotFoundError("Document not found");
    if (input.projectId && document.projectId !== input.projectId) throw new ValidationError("Document project mismatch");
    if (document.status === "ready") return publicDocument(document);
    if (document.status !== "pending") throw new ConflictError("Only pending documents can be finalized");
    if (Number(document.expiresAt ?? 0) <= Math.floor(new Date(this.now()).getTime() / 1000)) throw new ValidationError("Upload intent has expired");
    const capabilities = await this.getWorkspaceCapabilities(context);
    if (capabilities.security?.malwareScanning === "required" && document.scanStatus !== "clean") {
      throw new ConflictError("A clean malware scan is required before finalization");
    }
    if (document.scanStatus === "infected") throw new ConflictError("An infected document cannot be finalized");
    document.status = "ready";
    document.objectVersionId = "memory-version-1";
    document.version = Number(document.version ?? 1) + 1;
    document.updatedAt = this.now();
    delete document.expiresAt;
    this.recordActivity(context, document.projectId, "document", document.id, "document.finalized", ["status"], `Finalized document ${document.name}`);
    return publicDocument(document);
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string}} context
   * @param {string} projectId
   * @param {string} documentId
   * @param {Record<string, unknown>} patch
   */
  async patchDocument(context, projectId, documentId, patch) {
    const document = this.documents.get(documentId);
    if (!document) throw new NotFoundError("Document not found");
    if (document.projectId !== projectId) throw new NotFoundError("Document not found");
    if (document.workspaceId !== context.workspaceId) throw new NotFoundError("Document not found");
    if (!hasProjectAccess(document.projectId, context.membership?.projectIds)) throw new NotFoundError("Document not found");
    const expected = Number(patch.version ?? document.version);
    if (expected !== Number(document.version ?? 1)) throw new ConflictError();
    if (patch.status === "pending" || (document.status === "pending" && patch.status)) {
      throw new ValidationError("Pending documents must be promoted through the finalize endpoint");
    }
    if (patch.workItemId) {
      const workItem = this.workItems.get(String(patch.workItemId));
      if (!workItem || workItem.projectId !== document.projectId) throw new ValidationError("Document task must belong to the document project");
    }
    const changed = [];
    for (const field of ["name", "category", "description", "status", "workItemId", "tags"]) {
      if (patch[field] !== undefined && JSON.stringify(patch[field]) !== JSON.stringify(document[field])) {
        document[field] = patch[field];
        changed.push(field);
      }
    }
    document.version = Number(document.version ?? 1) + 1;
    document.updatedAt = this.now();
    this.recordActivity(context, document.projectId, "document", document.id, "document.updated", changed, `Updated document ${document.name}`);
    return publicDocument({
      ...document,
      projectName: this.projects.get(document.projectId)?.name ?? document.projectId,
      workItemName: document.workItemId ? this.workItems.get(document.workItemId)?.title ?? document.workItemId : undefined
    });
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string}} context
   * @param {string} projectId
   * @param {string} documentId
   */
  async createDocumentDownloadIntent(context, projectId, documentId) {
    const document = this.documents.get(documentId);
    if (!document) throw new NotFoundError("Document not found");
    if (document.projectId !== projectId) throw new NotFoundError("Document not found");
    if (document.workspaceId !== context.workspaceId) throw new NotFoundError("Document not found");
    if (!hasProjectAccess(document.projectId, context.membership?.projectIds)) throw new NotFoundError("Document not found");
    if (document.status === "pending") throw new ConflictError("Document upload is not finalized");
    this.recordActivity(context, document.projectId, "document", document.id, "document.download-intent.created", [], `Created download link for ${document.name}`);
    return {
      document: publicDocument(document),
      downloadUrl: `memory://documents/${document.id}/download`,
      expiresAt: Math.floor(new Date(this.now()).getTime() / 1000) + 600
    };
  }

  /**
   * @param {string} userId
   */
  async listSavedViews(userId, workspaceId = "", limit) {
    const views = [...this.savedViews.values()]
      .filter((view) => (view.userId === userId || view.visibility === "workspace") && (!workspaceId || view.workspaceId === workspaceId))
      .map(clone);
    return limit ? views.slice(0, Number(limit)) : views;
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string}} context
   * @param {{name: string, scope: string, filters: Record<string, unknown>}} input
   */
  async createSavedView(context, input) {
    const now = this.now();
    const view = {id: newId(), userId: context.actorId, workspaceId: context.workspaceId, version: 1, createdAt: now, updatedAt: now, ...input};
    this.savedViews.set(view.id, view);
    this.recordActivity(context, undefined, "saved-view", view.id, "saved-view.created", ["name", "scope"], `Saved view ${view.name}`);
    return clone(view);
  }

  async getPortfolioSummary(context = {}) {
    const projects = await this.listProjects({workspaceId: context.workspaceId});
    const projectIds = new Set(projects.map((project) => project.id));
    const workItems = [...this.workItems.values()].filter((item) => projectIds.has(item.projectId)).map(clone);
    return buildPortfolioSummary(projects, workItems, await this.getWorkConfiguration(context));
  }

  async getPlanningSummary(context = {}) {
    const workItems = await this.listPlanningWorkItems({workspaceId: context.workspaceId});
    return buildPlanningSummary(workItems, await this.getWorkConfiguration(context));
  }

  async getProjectTimeline(context = {}) {
    const projects = [...this.projects.values()].filter((project) => !context.workspaceId || project.workspaceId === context.workspaceId);
    const visible = context.publicDemo?.pageLimit ? projects.slice(0, context.publicDemo.pageLimit) : projects;
    return visible.map((project) => ({
      id: project.id,
      name: project.name,
      phase: project.phase,
      health: project.health,
      startDate: project.startDate,
      targetDate: project.targetDate,
      percentComplete: project.percentComplete
    }));
  }

  async getCostReport(context = {}, options = {}) {
    const capabilities = await this.getWorkspaceCapabilities(context);
    const projects = await this.listProjects({workspaceId: context.workspaceId, allowedProjectIds: context.membership?.projectIds, limit: 100});
    const projectIds = new Set(projects.map((project) => project.id));
    const workItems = [...this.workItems.values()].filter((item) => projectIds.has(item.projectId)).map(clone);
    const timeEntries = [...this.timeEntries.values()].filter((entry) => entry.workspaceId === context.workspaceId && projectIds.has(entry.projectId)).map(clone);
    return buildCostReport(capabilities, projects, workItems, timeEntries, options);
  }

  async getResourcePlan(context = {}, options = {}) {
    const capabilities = await this.getWorkspaceCapabilities(context);
    const memberships = await this.listMemberships(context);
    const projects = await this.listProjects({workspaceId: context.workspaceId, allowedProjectIds: context.membership?.projectIds, limit: 100});
    const projectIds = new Set(projects.map((project) => project.id));
    const workItems = [...this.workItems.values()].filter((item) => projectIds.has(item.projectId)).map(clone);
    const items = buildResourcePlan(capabilities, memberships, workItems, options);
    return {
      filters: options,
      weekStart: items[0]?.weekStart,
      weekEnd: items[0]?.weekEnd,
      version: capabilities.version,
      items,
      projects: projects.map((project) => ({id: project.id, name: project.name})),
      memberships: memberships.map((membership) => ({userId: membership.userId, name: membership.name ?? membership.email, placeholder: Boolean(membership.placeholder)})),
      summary: {
        capacityMinutes: items.reduce((sum, item) => sum + item.capacityMinutes, 0),
        allocatedMinutes: items.reduce((sum, item) => sum + item.allocatedMinutes, 0),
        availableMinutes: items.reduce((sum, item) => sum + item.availableMinutes, 0),
        overallocatedMinutes: items.reduce((sum, item) => sum + item.overallocatedMinutes, 0)
      }
    };
  }

  async getSecurityBadge(context = {}) {
    return securityBadge(await this.getWorkspaceCapabilities(context));
  }

  async listIntegrationCatalog(context = {}) {
    const capabilities = await this.getWorkspaceCapabilities(context);
    const visibleConnectors = [];
    for (const connector of capabilities.connectors ?? []) {
      if (connector.type === "github" && connector.resourceKind === "projects") {
        try { await this.getProject(connector.projectId, context.workspaceId, context.membership?.projectIds); }
        catch (error) { if (error?.status === 404) continue; throw error; }
      }
      visibleConnectors.push(connector);
    }
    const links = [...this.integrationLinks.values()].filter((item) => item.workspaceId === context.workspaceId);
    return {
      connectors: visibleConnectors.map((connector) => ({
        ...clone(connector),
        adapter: this.integrationRuntime.describe(connector),
        linkedItemCount: links.filter((item) => item.connectorId === connector.id).length
      })),
      repositories: clone(capabilities.repositories ?? []),
      webhooks: clone(capabilities.webhooks ?? [])
    };
  }

  async listRepositories(context) {
    const capabilities = await this.getWorkspaceCapabilities(context);
    const items = [];
    for (const repository of capabilities.repositories ?? []) {
      if (repository.projectId && !hasProjectAccess(repository.projectId, context.membership?.projectIds)) continue;
      if (repository.projectId) await this.getProject(repository.projectId, context.workspaceId, context.membership?.projectIds);
      const snapshot = this.repositorySnapshots.get(`${context.workspaceId}:${repository.id}`);
      items.push({...clone(repository), entryCount: snapshot?.entries?.length ?? 0, syncedAt: snapshot?.syncedAt, revision: snapshot?.revision});
    }
    return items;
  }

  async syncRepositorySnapshot(context, repositoryId, input) {
    const capabilities = await this.getWorkspaceCapabilities(context);
    const repository = capabilities.repositories?.find((item) => item.id === repositoryId && item.enabled !== false);
    if (!repository) throw new NotFoundError("Repository not found");
    if (repository.projectId) await this.getProject(repository.projectId, context.workspaceId, context.membership?.projectIds);
    const snapshot = {workspaceId: context.workspaceId, repositoryId, type: repository.type ?? "git", ...clone(input), syncedAt: this.now(), syncedBy: context.actorId, version: Number(this.repositorySnapshots.get(`${context.workspaceId}:${repositoryId}`)?.version ?? 0) + 1};
    this.repositorySnapshots.set(`${context.workspaceId}:${repositoryId}`, snapshot);
    this.recordActivity(context, repository.projectId, "repository", repositoryId, "repository.synchronized", ["ref", "revision", "entries"], `Synchronized ${snapshot.entries.length} repository entries`);
    return clone({...snapshot, entries: undefined, entryCount: snapshot.entries.length});
  }

  async browseRepository(context, repositoryId, filters = {}) {
    const repositories = await this.listRepositories(context);
    const repository = repositories.find((item) => item.id === repositoryId);
    if (!repository) throw new NotFoundError("Repository not found");
    const snapshot = this.repositorySnapshots.get(`${context.workspaceId}:${repositoryId}`);
    if (!snapshot) return {repository, ref: filters.ref ?? "main", path: filters.path ?? "", entries: []};
    if (filters.ref && filters.ref !== snapshot.ref) throw new NotFoundError("Repository ref not found in the synchronized snapshot");
    const prefix = String(filters.path ?? "").replace(/^\/+|\/+$/g, "");
    const entries = snapshot.entries.filter((entry) => !prefix || entry.path === prefix || entry.path.startsWith(`${prefix}/`)).filter((entry) => {
      const relative = prefix ? entry.path.slice(prefix.length).replace(/^\//, "") : entry.path;
      return relative && !relative.includes("/");
    });
    return {repository, ref: snapshot.ref, revision: snapshot.revision, path: prefix, syncedAt: snapshot.syncedAt, entries: clone(entries)};
  }

  async configuredConnector(context, connectorId, type) {
    const capabilities = await this.getWorkspaceCapabilities(context);
    const connector = capabilities.connectors?.find((item) => item.id === connectorId);
    if (!connector || connector.enabled === false) throw new ValidationError("Connector is not enabled");
    if (type && connector.type !== type) throw new ValidationError(`Connector must have type ${type}`);
    return connector;
  }

  async checkIntegrationHealth(context, connectorId, options = {}) {
    const connector = await this.configuredConnector(context, connectorId);
    if (connector.type === "github" && connector.resourceKind === "projects") await this.getProject(connector.projectId, context.workspaceId, context.membership?.projectIds);
    return this.integrationRuntime.health(connector, options);
  }

  async browseIntegrationResources(context, connectorId, options = {}) {
    const connector = await this.configuredConnector(context, connectorId);
    if (connector.type === "github" && connector.resourceKind === "projects") await this.getProject(connector.projectId, context.workspaceId, context.membership?.projectIds);
    return ["github", "gitlab"].includes(connector.type)
      ? this.integrationRuntime.developmentItems(connector, options)
      : this.integrationRuntime.browse(connector, options);
  }

  async createIntegrationResource(context, connectorId, input, options = {}) {
    const connector = await this.configuredConnector(context, connectorId, "xwiki");
    await this.getProject(input.projectId, context.workspaceId, context.membership?.projectIds);
    const resource = await this.integrationRuntime.createWikiPage(connector, input, options);
    const link = await this.createIntegrationLink(context, {
      projectId: input.projectId,
      connectorId,
      workItemId: input.workItemId,
      externalId: resource.id,
      externalUrl: resource.externalUrl,
      title: resource.title,
      linkType: "wiki",
      metadata: resource.metadata
    });
    return {resource, link};
  }

  async synchronizeIntegrationPermissions(context, connectorId, input, options = {}) {
    const connector = await this.configuredConnector(context, connectorId);
    await this.getProject(input.projectId, context.workspaceId, context.membership?.projectIds);
    const memberships = (await this.listMemberships(context)).filter((member) => member.status !== "disabled" && (!member.projectIds?.length || member.projectIds.includes(input.projectId)));
    const members = memberships.map((member) => ({
      email: member.email,
      externalId: connector.principalField ? member.customFields?.[connector.principalField] : member.email,
      permission: member.role === "viewer" ? "read" : "write"
    }));
    const result = await this.integrationRuntime.reconcilePermissions(connector, {resourceId: input.resourceId, members, ...options});
    this.recordActivity(context, input.projectId, "integration-permissions", input.resourceId, "integration.permissions-synchronized", ["added", "removed"], `Synchronized ${result.desiredCount} provider permissions`, {connectorId});
    return result;
  }

  async receiveProviderWebhook(context, connectorId, request) {
    const connector = await this.configuredConnector(context, connectorId);
    const event = collaborationConnectorTypes.has(connector.type) ? await this.integrationRuntime.verifyCollaborationWebhook(connector, request) : await this.integrationRuntime.verifyWebhook(connector, request);
    const deliveryKey = `${context.workspaceId}:${connectorId}:${event.deliveryId}`;
    if (this.providerWebhookDeliveries.has(deliveryKey)) return {...clone(this.providerWebhookDeliveries.get(deliveryKey)), duplicate: true};
    if (collaborationConnectorTypes.has(connector.type)) {
      if (!connectorAllowsProject(connector, event.projectId)) throw new ValidationError("Collaboration connector is not enabled for this project");
      await this.getProject(event.projectId, context.workspaceId);
      let result;
      if (event.action === "create-work-item") {
        const configuration = await this.getWorkConfiguration(context);
        const workItem = await this.createWorkItem(context, event.projectId, {title: event.title, description: event.description, type: configuration.defaultTypeId, status: configuration.defaultStatusId, priority: "medium", tags: [connector.type]});
        result = {accepted: true, action: event.action, workItem};
      } else {
        const workItem = this.workItems.get(event.workItemId);
        if (!workItem || workItem.projectId !== event.projectId) throw new ValidationError("Collaboration relation task must belong to the selected project");
        if (event.action === "link") {
          const link = await this.createIntegrationLink(context, {projectId: event.projectId, connectorId, workItemId: event.workItemId, externalId: event.resourceId, externalUrl: event.externalUrl, title: event.title, linkType: event.linkType, metadata: {source: connector.type}});
          result = {accepted: true, action: event.action, link};
        } else {
          const link = (await this.listIntegrationLinks(context, {projectId: event.projectId, connectorId, workItemId: event.workItemId})).find((item) => item.externalId === event.resourceId);
          result = {accepted: true, action: event.action, removed: link ? await this.deleteIntegrationLink(context, link.id, link.version) : {deleted: false}};
        }
      }
      this.providerWebhookDeliveries.set(deliveryKey, result);
      return clone(result);
    }
    const projectId = connector.projectId;
    if (!projectId) throw new ValidationError("Development connector projectId is required");
    await this.getProject(projectId, context.workspaceId);
    const linked = [];
    for (const workItemId of event.workItemIds ?? []) {
      const workItem = this.workItems.get(workItemId);
      if (!workItem || workItem.projectId !== projectId || !event.externalId) continue;
      linked.push(await this.createIntegrationLink(context, {projectId, connectorId, workItemId, externalId: event.externalId, externalUrl: event.externalUrl, title: event.title, linkType: "development", metadata: event.payload}));
    }
    const activity = await this.ingestIntegrationEvent(context, connectorId, {projectId, workItemId: linked[0]?.workItemId, eventType: event.eventType, externalId: event.externalId, summary: event.summary, payload: {...event.payload, deliveryId: event.deliveryId}});
    const result = {accepted: true, eventType: event.eventType, linkedCount: linked.length, links: linked, activity};
    this.providerWebhookDeliveries.set(deliveryKey, result);
    return clone(result);
  }

  async listProviderWorkItems(context, connectorId, filters, request) {
    const connector = await this.configuredConnector(context, connectorId);
    if (!collaborationConnectorTypes.has(connector.type)) throw new ValidationError("Connector does not provide a collaboration work-item API");
    await this.integrationRuntime.verifyInboundToken(connector, request);
    if (!connectorAllowsProject(connector, filters.projectId)) throw new ValidationError("Collaboration connector is not enabled for this project");
    const items = await this.listWorkItems(filters.projectId, context.workspaceId);
    const query = String(filters.query ?? "").toLowerCase();
    return items.filter((item) => !query || `${item.id} ${item.title} ${item.description ?? ""}`.toLowerCase().includes(query)).slice(0, 100);
  }

  async createProviderWorkItem(context, connectorId, projectId, input, request) {
    const connector = await this.configuredConnector(context, connectorId);
    if (!collaborationConnectorTypes.has(connector.type)) throw new ValidationError("Connector does not provide a collaboration work-item API");
    await this.integrationRuntime.verifyInboundToken(connector, request);
    if (!connectorAllowsProject(connector, projectId)) throw new ValidationError("Collaboration connector is not enabled for this project");
    return this.createWorkItem(context, projectId, input);
  }

  async listIntegrationLinks(context, filters = {}) {
    if (filters.projectId) await this.getProject(filters.projectId, context.workspaceId, context.membership?.projectIds);
    return [...this.integrationLinks.values()]
      .filter((item) => item.workspaceId === context.workspaceId)
      .filter((item) => !filters.projectId || item.projectId === filters.projectId)
      .filter((item) => !filters.workItemId || item.workItemId === filters.workItemId)
      .filter((item) => !filters.connectorId || item.connectorId === filters.connectorId)
      .map(clone)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async createIntegrationLink(context, input) {
    await this.getProject(input.projectId, context.workspaceId, context.membership?.projectIds);
    await this.configuredConnector(context, input.connectorId);
    if (input.workItemId) {
      const item = this.workItems.get(input.workItemId);
      if (!item || item.projectId !== input.projectId) throw new ValidationError("Linked task must belong to the selected project");
    }
    const duplicate = [...this.integrationLinks.values()].find((item) => item.workspaceId === context.workspaceId
      && item.connectorId === input.connectorId && item.externalId === input.externalId && item.workItemId === input.workItemId);
    if (duplicate) return clone(duplicate);
    const now = this.now();
    const link = {...clone(input), id: newId(), workspaceId: context.workspaceId, version: 1, createdAt: now, updatedAt: now, createdBy: context.actorId};
    this.integrationLinks.set(link.id, link);
    this.recordActivity(context, link.projectId, "integration-link", link.id, "integration.linked", ["connectorId", "externalId", "workItemId"], `Linked ${link.title}`);
    return clone(link);
  }

  async deleteIntegrationLink(context, linkId, version) {
    const link = this.integrationLinks.get(linkId);
    if (!link || link.workspaceId !== context.workspaceId || !hasProjectAccess(link.projectId, context.membership?.projectIds)) throw new NotFoundError("Integration link not found");
    if (Number(version) !== Number(link.version)) throw new ConflictError();
    this.integrationLinks.delete(linkId);
    this.recordActivity(context, link.projectId, "integration-link", link.id, "integration.unlinked", ["connectorId", "externalId"], `Unlinked ${link.title}`);
    return {deleted: true, id: linkId};
  }

  async ingestIntegrationEvent(context, connectorId, input) {
    await this.configuredConnector(context, connectorId);
    let link = input.linkId ? this.integrationLinks.get(input.linkId) : undefined;
    if (!link && input.externalId) {
      link = [...this.integrationLinks.values()].find((item) => item.workspaceId === context.workspaceId && item.connectorId === connectorId && item.externalId === input.externalId);
    }
    const projectId = input.projectId ?? link?.projectId;
    const workItemId = input.workItemId ?? link?.workItemId;
    if (!projectId) throw new ValidationError("The event must resolve to a project");
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    if (workItemId) {
      const item = this.workItems.get(workItemId);
      if (!item || item.projectId !== projectId) throw new ValidationError("Event task must belong to the selected project");
    }
    return this.recordActivity(context, projectId, "integration-event", input.externalId ?? link?.id ?? newId(), `integration.${input.eventType}`, ["summary"], input.summary, {
      connectorId,
      workItemId,
      externalId: input.externalId,
      integrationPayload: clone(input.payload)
    });
  }

  async importJiraIssues(context, input) {
    await this.configuredConnector(context, input.connectorId, "jira");
    await this.getProject(input.projectId, context.workspaceId, context.membership?.projectIds);
    const configuration = await this.getWorkConfiguration(context);
    const typeIds = new Set(configuration.types.filter((item) => item.active).map((item) => item.id));
    const statusIds = new Set(configuration.statuses.filter((item) => item.active).map((item) => item.id));
    const imported = [];
    for (const issue of input.issues) {
      const workItem = await this.createWorkItem(context, input.projectId, {
        title: issue.summary,
        description: issue.description,
        type: typeIds.has(issue.type) ? issue.type : configuration.defaultTypeId,
        status: statusIds.has(issue.status) ? issue.status : configuration.defaultStatusId,
        assigneeId: issue.assigneeId,
        priority: issue.priority,
        tags: issue.labels,
        customFields: {jiraKey: issue.key}
      });
      const link = await this.createIntegrationLink(context, {
        projectId: input.projectId,
        connectorId: input.connectorId,
        workItemId: workItem.id,
        externalId: issue.key,
        externalUrl: issue.externalUrl,
        title: issue.summary,
        linkType: "issue",
        metadata: {importedFrom: "jira"}
      });
      imported.push({workItem, link});
    }
    return {items: imported, importedCount: imported.length};
  }

  async listExternalShares(context) {
    return [...this.externalShares.values()]
      .filter((item) => item.workspaceId === context.workspaceId)
      .filter((item) => hasProjectAccess(item.projectId, context.membership?.projectIds))
      .map(clone)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async createExternalShare(context, input) {
    const capabilities = await this.getWorkspaceCapabilities(context);
    if (!capabilities.externalSharing?.enabled) throw new ForbiddenError("External sharing is not enabled");
    await this.getProject(input.projectId, context.workspaceId, context.membership?.projectIds);
    const workItem = this.workItems.get(input.workItemId);
    if (!workItem || workItem.projectId !== input.projectId) throw new NotFoundError("Task not found");
    const permissions = input.permissions?.length ? [...new Set(input.permissions)] : ["read"];
    if (!permissions.includes("read")) permissions.unshift("read");
    const now = this.now();
    const defaultDays = Math.max(1, Math.min(Number(capabilities.externalSharing.defaultExpiresDays ?? 30), 365));
    const expiresAt = input.expiresAt ?? new Date(new Date(now).getTime() + defaultDays * 86400000).toISOString();
    if (expiresAt <= now) throw new ValidationError("External share expiry must be in the future");
    const share = {...clone(input), permissions, token: newId(), workspaceId: context.workspaceId, expiresAt, version: 1, createdAt: now, updatedAt: now, createdBy: context.actorId};
    this.externalShares.set(share.token, share);
    this.recordActivity(context, share.projectId, "external-share", share.token, "external-share.created", ["targetType", "target", "permissions", "expiresAt"], `Shared task ${workItem.title}`);
    return clone(share);
  }

  async revokeExternalShare(context, token, version) {
    const share = this.externalShares.get(token);
    if (!share || share.workspaceId !== context.workspaceId || !hasProjectAccess(share.projectId, context.membership?.projectIds)) throw new NotFoundError("External share not found");
    if (Number(version) !== Number(share.version)) throw new ConflictError();
    share.revokedAt = this.now();
    share.revokedBy = context.actorId;
    share.version += 1;
    share.updatedAt = share.revokedAt;
    this.recordActivity(context, share.projectId, "external-share", share.token, "external-share.revoked", ["revokedAt"], "Revoked external share");
    return {revoked: true, token, version: share.version};
  }

  async externalShareRecipientAllowed(context, share) {
    const actorEmail = String(context.user?.email ?? "").trim().toLowerCase();
    if (share.targetType === "email") return actorEmail && actorEmail === share.target;
    if (share.targetType === "user") return context.actorId === share.target || actorEmail === share.target;
    if (share.targetType === "group") {
      const capabilities = await this.getWorkspaceCapabilities({workspaceId: share.workspaceId});
      const group = capabilities.groups?.find((item) => String(item.id).toLowerCase() === share.target);
      return Boolean(group && ((group.memberIds ?? []).includes(context.actorId) || (group.memberEmails ?? []).map((email) => String(email).toLowerCase()).includes(actorEmail)));
    }
    return false;
  }

  async getExternalShare(context, token) {
    const share = this.externalShares.get(token);
    if (!share || share.revokedAt || share.expiresAt <= this.now()) throw new NotFoundError("External share not found or expired");
    if (!(await this.externalShareRecipientAllowed(context, share))) throw new NotFoundError("External share not found or expired");
    const project = this.projects.get(share.projectId);
    const workItem = this.workItems.get(share.workItemId);
    if (!project || !workItem) throw new NotFoundError("Shared task no longer exists");
    const activity = this.activities.filter((item) => item.workspaceId === share.workspaceId && item.projectId === share.projectId && item.entityType === "work-item" && item.entityId === share.workItemId && item.visibility !== "internal").map(clone);
    return {share: clone(share), project: clone(project), workItem: clone(workItem), activity};
  }

  async commentOnExternalShare(context, token, summary) {
    const shared = await this.getExternalShare(context, token);
    if (!shared.share.permissions.includes("comment")) throw new ForbiddenError("This share is read-only");
    return this.recordActivity({...context, workspaceId: shared.share.workspaceId}, shared.share.projectId, "work-item", shared.share.workItemId, "external-comment.created", ["summary"], summary, {visibility: "external", externalShareToken: token});
  }

  async checkOutboundLink(context, input) {
    const capabilities = await this.getWorkspaceCapabilities(context);
    const policy = capabilities.outboundLinks?.policy ?? "warn";
    const host = new URL(input.url).hostname.toLowerCase();
    const allowedDomain = (capabilities.outboundLinks?.allowDomains ?? []).some((domain) => host === String(domain).toLowerCase() || host.endsWith(`.${String(domain).toLowerCase()}`));
    const requiresConfirmation = !allowedDomain && ["warn", "capture"].includes(policy) && !input.confirmed;
    const allowed = allowedDomain || policy === "allow" || ((policy === "warn" || policy === "capture") && input.confirmed);
    const now = this.now();
    const navigation = {id: newId(), workspaceId: context.workspaceId, actorId: context.actorId, ...clone(input), host, policy, allowedDomain, allowed, requiresConfirmation, createdAt: now};
    if (policy === "capture" || capabilities.outboundLinks?.captureEvents) this.outboundNavigations.set(navigation.id, navigation);
    if (policy === "capture" || capabilities.outboundLinks?.captureEvents) this.recordActivity(context, undefined, "outbound-link", navigation.id, "outbound-link.checked", ["url", "policy", "allowed"], `${allowed ? "Allowed" : "Blocked"} navigation to ${host}`);
    return clone(navigation);
  }

  async listOutboundNavigations(context) {
    return [...this.outboundNavigations.values()].filter((item) => item.workspaceId === context.workspaceId).map(clone).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async syncDirectory(context, input) {
    const capabilities = await this.getWorkspaceCapabilities(context);
    if (input.source === "ldap" && !capabilities.authentication?.ldap?.enabled) throw new ForbiddenError("LDAP synchronization is not enabled");
    if (input.source === "scim" && !capabilities.scim?.enabled) throw new ForbiddenError("SCIM provisioning is not enabled");
    const existing = await this.listMemberships(context);
    const byExternalId = new Map(existing.filter((member) => member.directorySource === input.source && member.directoryExternalId).map((member) => [member.directoryExternalId, member]));
    const byEmail = new Map(existing.map((member) => [String(member.email).toLowerCase(), member]));
    const items = [];
    for (const user of input.users) {
      const current = byExternalId.get(user.externalId) ?? byEmail.get(String(user.email).toLowerCase());
      if (current?.directorySource && current.directorySource !== input.source) throw new ValidationError(`Directory identity ${user.email} is already managed by ${current.directorySource}`);
      const member = await this.upsertMembership(context, {
        userId: current?.userId ?? (user.externalId || undefined),
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status,
        groupIds: user.groupIds,
        department: user.department,
        directorySource: input.source,
        directoryExternalId: user.externalId,
        projectIds: []
      });
      items.push(member);
      if (user.externalId) byExternalId.set(user.externalId, member);
      byEmail.set(String(user.email).toLowerCase(), member);
    }
    this.recordActivity(context, undefined, "directory-sync", newId(), `directory.${input.source}.synchronized`, ["users"], `Synchronized ${items.length} ${input.source.toUpperCase()} users`);
    return {source: input.source, items, synchronizedCount: items.length};
  }

  async synchronizeLdapDirectory(context, ldapRuntime) {
    const capabilities = await this.getWorkspaceCapabilities(context);
    const configuration = capabilities.authentication?.ldap;
    if (!configuration?.enabled) throw new ForbiddenError("LDAP synchronization is not enabled");
    const directory = await ldapRuntime.synchronize(configuration);
    const ldapGroups = directory.groups.map((group) => ({id: ldapGroupId(group), name: group.name, ldapDn: group.externalId, managedBy: "ldap", customFields: {}}));
    const ldapGroupIds = new Set([...(capabilities.groups ?? []).filter((group) => group.managedBy === "ldap").map((group) => group.id), ...ldapGroups.map((group) => group.id)]);
    const groupByDn = new Map(ldapGroups.map((group) => [group.ldapDn, group]));
    const departments = [...new Set(directory.users.map((user) => user.department).filter(Boolean))].map((name) => ({id: ldapDepartmentId(name), name, managedBy: "ldap"}));
    await this.patchWorkspaceCapabilities(context, {...capabilities, version: capabilities.version, groups: [...(capabilities.groups ?? []).filter((group) => group.managedBy !== "ldap"), ...ldapGroups], departments: [...(capabilities.departments ?? []).filter((department) => department.managedBy !== "ldap"), ...departments]});
    const existing = await this.listMemberships(context);
    const existingByExternalId = new Map(existing.filter((member) => member.directorySource === "ldap").map((member) => [member.directoryExternalId ?? member.userId, member]));
    const existingByEmail = new Map(existing.map((member) => [String(member.email).toLowerCase(), member]));
    const synchronized = [];
    const seen = new Set();
    for (const user of directory.users) {
      seen.add(user.externalId);
      const current = existingByExternalId.get(user.externalId) ?? existingByEmail.get(String(user.email).toLowerCase());
      if (current?.directorySource && current.directorySource !== "ldap") throw new ValidationError(`Directory identity ${user.email} is already managed by ${current.directorySource}`);
      const forwardGroups = directory.groups.filter((group) => (group.memberDns ?? []).includes(user.externalId)).map((group) => groupByDn.get(group.externalId)?.id).filter(Boolean);
      const reverseGroups = (user.groupDns ?? []).map((dn) => groupByDn.get(dn)?.id).filter(Boolean);
      const manualGroups = (current?.groupIds ?? []).filter((groupId) => !ldapGroupIds.has(groupId));
      const member = await this.upsertMembership(context, {userId: current?.userId ?? user.externalId, email: user.email, name: user.name, role: current?.role ?? configuration.defaultRole ?? roles.viewer, status: user.status, groupIds: [...new Set([...manualGroups, ...forwardGroups, ...reverseGroups])], projectIds: current?.projectIds ?? [], department: user.department, directorySource: "ldap", directoryExternalId: user.externalId});
      synchronized.push(member);
      existingByEmail.set(String(user.email).toLowerCase(), member);
    }
    let disabledCount = 0;
    for (const member of existingByExternalId.values()) {
      if (seen.has(member.directoryExternalId ?? member.userId) || member.status === "disabled") continue;
      await this.patchMembership(context, member.userId, {status: "disabled"});
      disabledCount += 1;
    }
    this.recordActivity(context, undefined, "directory-sync", newId(), "directory.ldap.queried-and-synchronized", ["users", "groups", "disabled"], `Queried LDAP and synchronized ${synchronized.length} users and ${ldapGroups.length} groups`);
    return {source: "ldap", items: synchronized, groups: ldapGroups, synchronizedCount: synchronized.length, disabledCount};
  }

  async deliverWebhook(context, webhookId, event) {
    const capabilities = await this.getWorkspaceCapabilities(context);
    const webhook = capabilities.webhooks?.find((item) => item.id === webhookId && item.enabled !== false);
    if (!webhook) throw new NotFoundError("Webhook not found");
    const delivery = {id: newId(), workspaceId: context.workspaceId, webhookId, eventType: event.eventType, payload: clone(event.payload ?? {}), status: "pending", attempts: 1, createdAt: this.now(), createdBy: context.actorId};
    let timeout;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(webhook.url, {method: "POST", redirect: "error", headers: {"content-type": "application/json", "x-team-spaces-event": event.eventType, "x-team-spaces-delivery": delivery.id}, body: JSON.stringify({id: delivery.id, eventType: event.eventType, workspaceId: context.workspaceId, payload: delivery.payload}), signal: controller.signal});
      delivery.status = response.ok ? "delivered" : "failed";
      delivery.responseStatus = response.status;
    } catch (error) {
      delivery.status = "failed";
      delivery.error = error instanceof Error ? error.name : "DeliveryError";
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    delivery.completedAt = this.now();
    this.webhookDeliveries.set(delivery.id, delivery);
    this.recordActivity(context, undefined, "webhook-delivery", delivery.id, `webhook.${delivery.status}`, ["status", "responseStatus"], `${delivery.status === "delivered" ? "Delivered" : "Failed"} webhook ${webhookId}`);
    return clone(delivery);
  }

  async publishWebhookEvent(context, eventType, payload) {
    const capabilities = await this.getWorkspaceCapabilities(context);
    const webhooks = (capabilities.webhooks ?? []).filter((webhook) => {
      const events = webhook.eventTypes ?? webhook.events ?? [];
      return webhook.enabled !== false && (events.includes("*") || events.includes(eventType));
    }).slice(0, 25);
    if (!webhooks.length) return [];
    const serialized = JSON.stringify(payload ?? {});
    const safePayload = Buffer.byteLength(serialized, "utf8") <= 32 * 1024
      ? clone(payload ?? {})
      : {truncated: true, correlationId: context.correlationId};
    const settled = await Promise.allSettled(webhooks.map((webhook) => this.deliverWebhook(context, webhook.id, {eventType, payload: safePayload})));
    return settled.map((result, index) => result.status === "fulfilled" ? result.value : {webhookId: webhooks[index].id, eventType, status: "failed"});
  }

  async listWebhookDeliveries(context) {
    return [...this.webhookDeliveries.values()].filter((item) => item.workspaceId === context.workspaceId).map(clone).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async recordDocumentScan(context, projectId, documentId, input) {
    const document = this.documents.get(documentId);
    if (!document || document.workspaceId !== context.workspaceId || document.projectId !== projectId) throw new NotFoundError("Document not found");
    if (document.status !== "pending" || document.scanStatus !== "queued") throw new ConflictError("Only queued pending documents can accept scan results");
    const now = this.now();
    document.scanStatus = input.status;
    document.scanEngine = input.engine ?? "external";
    document.scannedAt = input.scannedAt ?? now;
    if (input.extractedText !== undefined) document.extractedText = input.extractedText;
    document.version = Number(document.version ?? 1) + 1;
    document.updatedAt = now;
    this.recordActivity(context, projectId, "document", documentId, `document.scan.${input.status}`, ["scanStatus", "scanEngine"], `Document scan marked ${input.status}`);
    return publicDocument(document);
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string}} context
   * @param {{projectId: string, filename: string, contentType: string, sizeBytes: number}} input
   */
  async createUploadIntent(context, input) {
    return this.createDocumentUploadIntent(context, {...input, name: input.filename, category: "other", description: "", tags: []});
  }
}
