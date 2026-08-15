// @ts-nocheck

import {buildPlanningSummary, buildPortfolioSummary, newId, reverseTimestamp} from "@teamspaces/domain";
import {demoMembership, demoUser, demoWorkspace, seedData} from "@teamspaces/test-fixtures";
import {
  assertWorkConfigurationUpdate,
  assertWorkItemConfiguration,
  assertWorkQueryConfiguration,
  assertMeetingPayloadSize,
  assertMeetingUpdate,
  defaultWorkConfiguration,
  maxMeetingParticipants,
  parseWorkConfigurationInput,
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
  constructor(seed = seedData) {
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
    this.documents = new Map((seed.documents ?? []).map((item) => [item.id, clone(item)]));
    this.workConfigurations = new Map((seed.workConfigurations ?? []).map((item) => [item.workspaceId, clone(item)]));
    this.savedViews = new Map((seed.savedViews ?? []).map((item) => [item.id, clone(item)]));
    this.attachments = new Map();
    this.uploadIntents = new Map();
    this.activities = (seed.activities ?? []).map(clone);
  }

  now() {
    return new Date().toISOString();
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
  recordActivity(context, projectId, entityType, entityId, eventType, fields, summary) {
    const timestamp = this.now();
    this.activities.push({
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
      correlationId: context.correlationId
    });
  }

  async getWorkspace(context = {}) {
    return clone(this.workspaces.get(context.workspaceId) ?? this.workspace);
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

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string}} context
   * @param {{userId?: string, email: string, name: string, role: string, status: string}} input
   */
  async upsertMembership(context, input) {
    const userId = input.userId ?? userIdFromEmail(input.email);
    const now = this.now();
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
      version: Number(this.memberships.get(`${context.workspaceId}:${userId}`)?.version ?? 0) + 1,
      createdAt: this.memberships.get(`${context.workspaceId}:${userId}`)?.createdAt ?? now,
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
    const changed = [];
    for (const field of ["name", "email", "role", "status", "projectIds"]) {
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
    const changed = [];
    for (const field of ["name", "title", "department", "timezone", "locale"]) {
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
    let projects = [...this.projects.values()].map(clone);
    if (filters.workspaceId) projects = projects.filter((project) => project.workspaceId === filters.workspaceId);
    if (Array.isArray(filters.allowedProjectIds) && filters.allowedProjectIds.length) projects = projects.filter((project) => filters.allowedProjectIds.includes(project.id));
    if (filters.search) projects = projects.filter((project) => includesFolded(project.name, filters.search) || includesFolded(project.description, filters.search));
    for (const field of ["status", "health", "ownerId", "portfolioId", "priority", "phase"]) {
      if (filters[field]) projects = projects.filter((project) => project[field] === filters[field]);
    }
    projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return filters.limit ? projects.slice(0, Number(filters.limit)) : projects;
  }

  /**
   * @param {string} id
   */
  async getProject(id, workspaceId = "", allowedProjectIds = []) {
    const project = this.projects.get(id);
    if (!project) throw new NotFoundError("Project not found");
    if (workspaceId && project.workspaceId !== workspaceId) throw new NotFoundError("Project not found");
    if (!hasProjectAccess(id, allowedProjectIds)) throw new NotFoundError("Project not found");
    return clone(project);
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string}} context
   * @param {ReturnType<import("@teamspaces/contracts").parseProjectInput>} input
   */
  async createProject(context, input) {
    if (input.portfolioId && this.portfolios.get(input.portfolioId)?.workspaceId !== context.workspaceId) throw new ValidationError("portfolioId does not exist");
    const now = this.now();
    const project = {
      id: context.publicDemo?.projectIdPrefix ? `${context.publicDemo.projectIdPrefix}${newId()}` : newId(),
      workspaceId: context.workspaceId,
      ownerId: input.ownerId ?? context.actorId,
      status: "active",
      health: "on-track",
      priority: "medium",
      phase: "Proposed",
      archived: false,
      favorite: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...input
    };
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
    const project = this.projects.get(projectId);
    if (!project) throw new NotFoundError("Project not found");
    if (project.workspaceId !== context.workspaceId) throw new NotFoundError("Project not found");
    const expected = Number(patch.version ?? project.version);
    if (expected !== project.version) throw new ConflictError();
    const mutable = ["name", "description", "portfolioId", "ownerId", "status", "health", "priority", "phase", "startDate", "targetDate", "percentComplete", "favorite", "tags", "archived"];
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
    const configuration = await this.getWorkConfiguration(context);
    const type = input.type ?? configuration.defaultTypeId;
    const status = input.status ?? configuration.defaultStatusId;
    assertWorkItemConfiguration(configuration, {
      type,
      status,
      role: context.membership?.role,
      creating: true
    });
    const now = this.now();
    const item = {
      id: newId(),
      workspaceId: context.workspaceId,
      projectId,
      recordedMinutes: 0,
      rank: Date.now(),
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...input,
      type,
      status,
      reporterId: input.reporterId ?? context.actorId,
      assigneeId: input.assigneeId ?? context.actorId
    };
    this.workItems.set(item.id, item);
    this.recordActivity(context, projectId, "work-item", item.id, "work.created", ["title"], `Created task ${item.title}`);
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
    const configuration = await this.getWorkConfiguration(context);
    const type = patch.type ?? item.type;
    const status = patch.status ?? item.status;
    assertWorkItemConfiguration(configuration, {
      type,
      status,
      previousType: item.type,
      previousStatus: item.status,
      role: context.membership?.role
    });
    const changed = [];
    for (const field of ["title", "description", "type", "status", "priority", "assigneeId", "startDate", "dueDate", "estimateMinutes", "effortPoints", "periodId", "periodName", "periodGoal", "intakeGroup", "milestoneName", "parentId", "blockedBy", "relatedIds", "watcherIds", "acceptanceCriteria", "customFields", "rank", "tags"]) {
      if (patch[field] !== undefined && JSON.stringify(patch[field]) !== JSON.stringify(item[field])) {
        item[field] = patch[field];
        changed.push(field);
      }
    }
    item.version += 1;
    item.updatedAt = this.now();
    this.recordActivity(context, item.projectId, "work-item", item.id, "work.updated", changed, `Updated task ${item.title}`);
    return clone(item);
  }

  /**
   * @param {{workspaceId: string, membership?: {projectIds?: string[]}}} context
   * @param {{version: number, projectId: string, limit: number, cursor?: string}} query
   */
  async listMeetingsPage(context, query) {
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
    assertMeetingPayloadSize(meeting);
    this.assertMeetingParticipants(context, input.projectId, participantIds);
    assertMeetingPresenters(meeting);
    this.assertMeetingWorkItems(input.projectId, meeting);
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
    if (patch.participantIds !== undefined || patch.agendaItems !== undefined) assertMeetingPresenters(next);
    if (patch.agendaItems !== undefined) this.assertMeetingWorkItems(projectId, next);
    const changed = Object.keys(updates).filter((field) => JSON.stringify(current[field]) !== JSON.stringify(next[field]));
    next.version = Number(current.version) + 1;
    next.updatedAt = this.now();
    next.updatedBy = context.actorId;
    this.meetings.set(key, next);
    this.recordActivity(context, projectId, "meeting", meetingId, "meeting.updated", changed, `Updated meeting ${next.title}`);
    return clone(next);
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
    if (input.projectId && this.projects.get(input.projectId)?.workspaceId !== context.workspaceId) throw new NotFoundError("Project not found");
    if (input.projectId && !hasProjectAccess(input.projectId, context.membership?.projectIds)) throw new NotFoundError("Project not found");
    if (input.workItemId) {
      const item = this.workItems.get(input.workItemId);
      if (!item || this.projects.get(item.projectId)?.workspaceId !== context.workspaceId) throw new NotFoundError("Task not found");
      if (!hasProjectAccess(item.projectId, context.membership?.projectIds)) throw new NotFoundError("Task not found");
    }
    const now = this.now();
    const entry = {
      id: newId(),
      workspaceId: context.workspaceId,
      userId: context.actorId,
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...input
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
      expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
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
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      uploadUrl: `memory://documents/${document.id}`,
      uploadHeaders: {
        "content-type": input.contentType,
        "if-none-match": "*",
        "x-amz-server-side-encryption": "AES256"
      },
      document: clone(document)
    };
    this.uploadIntents.set(intent.id, intent);
    this.recordActivity(context, input.projectId, "document", document.id, "document.upload-intent.created", ["name", "filename"], `Prepared document ${document.name}`);
    return clone(intent);
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
    if (document.status === "ready") return clone(document);
    if (document.status !== "pending") throw new ConflictError("Only pending documents can be finalized");
    if (Number(document.expiresAt ?? 0) <= Math.floor(Date.now() / 1000)) throw new ValidationError("Upload intent has expired");
    document.status = "ready";
    document.objectVersionId = "memory-version-1";
    document.version = Number(document.version ?? 1) + 1;
    document.updatedAt = this.now();
    delete document.expiresAt;
    this.recordActivity(context, document.projectId, "document", document.id, "document.finalized", ["status"], `Finalized document ${document.name}`);
    return clone(document);
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
    return clone({
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
      document: clone(document),
      downloadUrl: `memory://documents/${document.id}/download`,
      expiresAt: Math.floor(Date.now() / 1000) + 600
    };
  }

  /**
   * @param {string} userId
   */
  async listSavedViews(userId, workspaceId = "", limit) {
    const views = [...this.savedViews.values()]
      .filter((view) => view.userId === userId && (!workspaceId || view.workspaceId === workspaceId))
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

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string}} context
   * @param {{projectId: string, filename: string, contentType: string, sizeBytes: number}} input
   */
  async createUploadIntent(context, input) {
    return this.createDocumentUploadIntent(context, {...input, name: input.filename, category: "other", description: "", tags: []});
  }
}
