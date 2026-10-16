// @ts-nocheck

import {
  customFieldRecord,
  parseAccountInput,
  parseActivityInput,
  parseContentOperationsInput,
  parseContentPresenceInput,
  parseDocumentFinalizeInput,
  parseDocumentPatchInput,
  parseDocumentUploadIntentInput,
  parseDirectorySyncInput,
  parseExternalShareInput,
  parseIntegrationEventInput,
  parseIntegrationLinkInput,
  parseIntegrationPermissionSyncInput,
  parseIntegrationResourceInput,
  parseJiraImportInput,
  parseLifecycleGateApprovalInput,
  parseMembershipInput,
  parseMeetingIdentifier,
  parseMeetingAttendanceResponseInput,
  parseMeetingCopyInput,
  parseMeetingInput,
  parseMeetingPatchInput,
  parseMeetingQuery,
  parseNotificationPreferencesInput,
  parseOutboundLinkInput,
  parsePlanningResourceInput,
  parsePlanningResourcePatchInput,
  parsePlaceholderInput,
  parsePortfolioInput,
  parsePortfolioPatchInput,
  parseProfileInput,
  parseProjectContentInput,
  parseProjectContentPatchInput,
  parseProjectCopyInput,
  parseProjectInput,
  parseProjectInitiationInput,
  parseProjectInitiationReviewInput,
  parseProjectPatchInput,
  parseRepositorySnapshotInput,
  parseSavedViewInput,
  parseTimeEntryInput,
  parseTimeEntryPatchInput,
  parseTimerStartInput,
  parseWorkConfigurationInput,
  parseWorkQuery,
  parseWorkItemInput,
  parseWorkItemCopyInput,
  parseWorkItemMoveInput,
  parseWorkItemPatchInput,
  parseVersionInput,
  parseWorkspaceCapabilitiesInput,
  parseWorkspaceInput,
  planningResourceKinds,
  projectContentKinds,
  projectContentStatuses,
  roles
} from "@teamspaces/contracts";
import {buildPlanningSummary, newId} from "@teamspaces/domain";
import {hasPermission, permissions, requirePermission} from "../authorization/rbac.js";
import {NotFoundError, ValidationError} from "../errors.js";
import {ganttPdfExport, workItemExport} from "../repositories/work-exports.js";
import {buildNotificationDigest, groupNotificationEvents, notificationEvents, notificationReadIds, workNotificationRecipients} from "../repositories/notifications.js";
import {parseListOptions} from "../validation/http.js";
import {issueLdapSession} from "../directory/ldap-session.js";
import {coordinationDashboard} from "../coordination.js";

/**
 * @param {string} path
 * @param {string} prefix
 */
function stripPrefix(path, prefix) {
  return path.startsWith(prefix) ? path.slice(prefix.length) || "/" : path;
}

function accountFilters(context) {
  return {
    workspaceId: context.workspaceId,
    allowedProjectIds: context.membership?.projectIds
  };
}

async function clientCapabilities(repository, context, capabilities) {
  const connectors = [];
  for (const connector of capabilities.connectors ?? []) {
    if (connector.type === "github" && connector.resourceKind === "projects") {
      try { await repository.getProject(connector.projectId, context.workspaceId, context.membership?.projectIds); }
      catch (error) { if (error?.status === 404) continue; throw error; }
    }
    connectors.push(connector);
  }
  return {...capabilities, connectors};
}

function publicListLimit(context) {
  const limit = Number(context.publicDemo?.pageLimit);
  return Number.isInteger(limit) && limit > 0 ? limit : undefined;
}

function publicListReadLimit(context) {
  const limit = publicListLimit(context);
  return limit ? limit + 1 : undefined;
}

function listEnvelope(items, context) {
  const limit = publicListLimit(context);
  const visible = limit ? items.slice(0, limit) : items;
  return {
    items: visible,
    pageInfo: {
      hasNextPage: false,
      ...(limit && items.length > visible.length ? {truncated: true} : {})
    }
  };
}

function meetingPathIdentifier(value) {
  try {
    return parseMeetingIdentifier(decodeURIComponent(value), "meetingId");
  } catch (error) {
    if (error instanceof URIError) throw new ValidationError("meetingId is invalid");
    throw error;
  }
}

function requiredText(value, name, maximum = 2000) {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${name} is required`);
  return value.trim().slice(0, maximum);
}

function dateQuery(value, name) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime())) {
    throw new ValidationError(`${name} must be a date in YYYY-MM-DD format`);
  }
  return value;
}

function resourceConfigurationInput(body, kind) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Number.isInteger(Number(body.version))) throw new ValidationError("version is required");
  const userId = requiredText(body.userId, "userId", 128);
  if (kind === "profile") {
    const weeklyMinutes = Number(body.weeklyMinutes);
    if (!Number.isInteger(weeklyMinutes) || weeklyMinutes < 0 || weeklyMinutes > 10080) throw new ValidationError("weeklyMinutes must be between 0 and 10,080");
    const skills = Array.isArray(body.skills) ? [...new Set(body.skills.filter((skill) => typeof skill === "string" && skill.trim()).map((skill) => skill.trim().slice(0, 100)))].slice(0, 50) : [];
    return {version: Number(body.version), item: {userId, weeklyMinutes, skills}};
  }
  const startDate = dateQuery(body.startDate ?? body.date, "startDate");
  const endDate = dateQuery(body.endDate ?? body.date ?? startDate, "endDate");
  if (startDate > endDate) throw new ValidationError("startDate must not be after endDate");
  const minutes = Number(body.minutes);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 100000) throw new ValidationError("minutes must be between 0 and 100,000");
  if (kind === "allocation") return {version: Number(body.version), item: {id: typeof body.id === "string" && body.id ? body.id : newId(), userId, projectId: requiredText(body.projectId, "projectId", 128), startDate, endDate, minutes, note: typeof body.note === "string" ? body.note.trim().slice(0, 500) : ""}};
  return {version: Number(body.version), item: {id: typeof body.id === "string" && body.id ? body.id : newId(), userId, startDate, endDate, minutes, note: typeof body.note === "string" ? body.note.trim().slice(0, 500) : ""}};
}

async function saveResourceConfiguration(context, repository, key, item, version) {
  const capabilities = await repository.getWorkspaceCapabilities(context);
  const resources = structuredClone(capabilities.resources ?? {profiles: [], allocations: [], timeOff: []});
  if (key === "profiles") resources.profiles = [...(resources.profiles ?? []).filter((candidate) => candidate.userId !== item.userId), item];
  else resources[key] = [...(resources[key] ?? []).filter((candidate) => candidate.id !== item.id), item];
  return repository.patchWorkspaceCapabilities(context, {...capabilities, resources, version});
}

async function deleteResourceConfiguration(context, repository, key, id, version) {
  const capabilities = await repository.getWorkspaceCapabilities(context);
  const resources = structuredClone(capabilities.resources ?? {profiles: [], allocations: [], timeOff: []});
  if (!(resources[key] ?? []).some((item) => item.id === id)) throw new NotFoundError("Resource-planner record not found");
  resources[key] = resources[key].filter((item) => item.id !== id);
  return repository.patchWorkspaceCapabilities(context, {...capabilities, resources, version});
}

function webhookEventInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("Webhook event body is required");
  return {eventType: requiredText(body.eventType, "eventType", 128), payload: body.payload && typeof body.payload === "object" ? body.payload : {}};
}

function documentScanInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !["clean", "infected", "error"].includes(body.status)) throw new ValidationError("status must be clean, infected, or error");
  const scannedAt = typeof body.scannedAt === "string" && body.scannedAt ? new Date(body.scannedAt) : undefined;
  if (scannedAt && Number.isNaN(scannedAt.getTime())) throw new ValidationError("scannedAt must be a timestamp");
  if (body.extractedText !== undefined && (typeof body.extractedText !== "string" || body.extractedText.length > 100000)) throw new ValidationError("extractedText must be at most 100,000 characters");
  return {status: body.status, engine: typeof body.engine === "string" ? body.engine.trim().slice(0, 128) : undefined, scannedAt: scannedAt?.toISOString(), extractedText: typeof body.extractedText === "string" ? body.extractedText : undefined};
}

const scimCustomFieldsSchema = "urn:teamspaces:params:scim:schemas:extension:custom-fields:1.0:User";
const scimGroupCustomFieldsSchema = "urn:teamspaces:params:scim:schemas:extension:custom-fields:1.0:Group";

function scimUserInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("SCIM user body is required");
  const email = body.userName ?? body.emails?.find((item) => item?.primary)?.value ?? body.emails?.[0]?.value;
  return {
    externalId: typeof body.externalId === "string" ? body.externalId : undefined,
    email,
    name: body.displayName ?? ([body.name?.givenName, body.name?.familyName].filter(Boolean).join(" ") || email),
    role: body.role ?? "viewer",
    status: body.active === false ? "disabled" : "active",
    groupIds: (body.groups ?? []).map((group) => typeof group === "string" ? group : group?.value).filter(Boolean),
    customFields: body[scimCustomFieldsSchema]?.customFields ?? body.customFields
  };
}

function scimUser(member) {
  const customFields = member.customFields ?? {};
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User", ...(Object.keys(customFields).length ? [scimCustomFieldsSchema] : [])],
    id: member.userId,
    externalId: member.userId,
    userName: member.email,
    displayName: member.name,
    active: member.status !== "disabled",
    roles: [{value: member.role}],
    groups: (member.groupIds ?? []).map((value) => ({value})),
    ...(Object.keys(customFields).length ? {[scimCustomFieldsSchema]: {customFields}} : {})
  };
}

function scimGroupInput(body, fallbackId = "") {
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.displayName !== "string" || !body.displayName.trim()) {
    throw new ValidationError("SCIM group displayName is required");
  }
  const members = Array.isArray(body.members) ? body.members : [];
  if (members.length > 90) throw new ValidationError("SCIM groups support at most 90 members per request");
  const memberIds = [...new Set(members.map((member) => typeof member === "string" ? member : member?.value).filter((value) => typeof value === "string" && value))];
  return {
    id: fallbackId,
    externalId: typeof body.externalId === "string" ? body.externalId.trim().slice(0, 128) : undefined,
    name: body.displayName.trim().slice(0, 200),
    memberIds,
    customFields: customFieldRecord(body[scimGroupCustomFieldsSchema]?.customFields ?? body.customFields)
  };
}

function scimGroup(group, memberships = []) {
  const customFields = group.customFields ?? {};
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group", ...(Object.keys(customFields).length ? [scimGroupCustomFieldsSchema] : [])],
    id: group.id,
    externalId: group.scimExternalId ?? group.externalId ?? group.id,
    displayName: group.name ?? group.label ?? group.id,
    members: memberships.filter((member) => member.groupIds?.includes(group.id)).map((member) => ({value: member.userId, display: member.name ?? member.email})),
    ...(Object.keys(customFields).length ? {[scimGroupCustomFieldsSchema]: {customFields}} : {})
  };
}

function scimGroupId(name, groups = []) {
  const root = `scim-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 35) || "group"}`;
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const candidate = suffix === 1 ? root : `${root.slice(0, 44)}-${suffix}`;
    if (!groups.some((group) => group.id === candidate)) return candidate;
  }
  throw new ValidationError("Unable to allocate a SCIM group ID");
}

function mcpTools(capabilities) {
  const taskFields = {
    title: {type: "string"},
    description: {type: "string"},
    status: {type: "string", description: "Use a configured workspace task status."},
    priority: {type: "string"},
    blockedBy: {type: "array", items: {type: "string"}},
    acceptanceCriteria: {type: "string"},
    coordination: {
      type: "object",
      description: "Private role/task/run metadata. Preserve existing sourceId and taskKey on updates. Acceptance requires a closed task and evidence; a run state never accepts work.",
      required: ["roleId"],
      properties: {
        roleId: {type: "string", enum: ["coordinator", "ui-ux", "workflow-review", "feature-delivery", "maintenance"]},
        sourceId: {type: "string"}, taskKey: {type: "string"},
        nextAction: {type: "string"}, decision: {type: "string"},
        scopePaths: {type: "array", items: {type: "string"}},
        parityIds: {type: "array", items: {type: "string"}},
        sourceRefs: {type: "array", items: {type: "string"}},
        dependencies: {type: "array", items: {type: "object", required: ["projectId", "taskId"], properties: {projectId: {type: "string"}, taskId: {type: "string"}}}},
        acceptanceState: {type: "string", enum: ["pending", "review", "accepted"]},
        evidence: {type: "array", items: {type: "object", required: ["label", "url"], properties: {label: {type: "string"}, url: {type: "string"}, visibility: {type: "string", enum: ["private", "public"]}}}},
        run: {type: "object", required: ["id", "state", "updatedAt"], properties: {id: {type: "string"}, state: {type: "string"}, updatedAt: {type: "string"}, sourceRevision: {type: "string"}, url: {type: "string"}}}
      }
    }
  };
  const definitions = [
    {name: "search", description: "Search accessible Team Spaces records", inputSchema: {type: "object", properties: {query: {type: "string"}}, required: ["query"]}},
    {name: "list_projects", description: "List accessible projects", inputSchema: {type: "object", properties: {}}},
    {name: "list_work_items", description: "List work items in an accessible project", inputSchema: {type: "object", properties: {projectId: {type: "string"}}, required: ["projectId"]}},
    {name: "create_work_item", description: "Create a work item", inputSchema: {type: "object", properties: {projectId: {type: "string"}, ...taskFields}, required: ["projectId", "title"]}, mutating: true},
    {name: "update_work_item", description: "Update a work item using its current version", inputSchema: {type: "object", properties: {projectId: {type: "string"}, workItemId: {type: "string"}, version: {type: "integer"}, ...taskFields}, required: ["projectId", "workItemId", "version"]}, mutating: true}
  ];
  const allowed = new Set(capabilities.mcp?.allowedToolIds ?? []);
  return definitions.filter((tool) => (!allowed.size || allowed.has(tool.name)) && (!capabilities.mcp?.readOnly || !tool.mutating));
}

async function mcpResponse({body, context, repository}) {
  const id = body?.id ?? null;
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") return {jsonrpc: "2.0", id, error: {code: -32600, message: "Invalid Request"}};
  const capabilities = await repository.getWorkspaceCapabilities(context);
  if (!capabilities.mcp?.enabled) return {jsonrpc: "2.0", id, error: {code: -32001, message: "MCP is not enabled"}};
  if (body.method === "initialize") return {jsonrpc: "2.0", id, result: {protocolVersion: "2025-06-18", capabilities: {tools: {listChanged: false}}, serverInfo: {name: "team-spaces", version: "1.0.0"}}};
  const tools = mcpTools(capabilities);
  if (body.method === "tools/list") return {jsonrpc: "2.0", id, result: {tools: tools.map(({mutating: _mutating, ...tool}) => tool)}};
  if (body.method !== "tools/call") return {jsonrpc: "2.0", id, error: {code: -32601, message: "Method not found"}};
  const name = body.params?.name;
  const args = body.params?.arguments ?? {};
  if (!tools.some((tool) => tool.name === name)) return {jsonrpc: "2.0", id, error: {code: -32602, message: "Tool is not allowed"}};
  try {
    let value;
    if (name === "search") value = await repository.globalSearch(context, requiredText(args.query, "query", 200), 50);
    if (name === "list_projects") value = await repository.listProjects({limit: 100, ...accountFilters(context)});
    if (name === "list_work_items") value = await repository.listWorkItems(requiredText(args.projectId, "projectId", 128), context.workspaceId, context.membership?.projectIds);
    if (name === "create_work_item") {
      requirePermission(context, permissions.workManage);
      const projectId = requiredText(args.projectId, "projectId", 128);
      value = await repository.createWorkItem(context, projectId, parseWorkItemInput(args));
    }
    if (name === "update_work_item") {
      requirePermission(context, permissions.workManage);
      const projectId = requiredText(args.projectId, "projectId", 128);
      const workItemId = requiredText(args.workItemId, "workItemId", 128);
      value = await repository.patchWorkItem(context, projectId, workItemId, parseWorkItemPatchInput(args));
    }
    return {jsonrpc: "2.0", id, result: {content: [{type: "text", text: JSON.stringify(value)}], structuredContent: value}};
  } catch (error) {
    const message = Number(error?.statusCode) >= 500 ? "The tool could not complete the request" : String(error?.message ?? "The tool could not complete the request");
    return {jsonrpc: "2.0", id, result: {content: [{type: "text", text: message}], isError: true}};
  }
}

async function userNotificationCenter(context, repository, filter = "all", projectId) {
  if (!["all", "unread", "read"].includes(filter)) throw new ValidationError("filter must be all, unread, or read");
  const [capabilities, activity] = await Promise.all([
    repository.getWorkspaceCapabilities(context),
    repository.listActivity(projectId, context.workspaceId, publicListReadLimit(context) ?? 100)
  ]);
  const preferences = await repository.getNotificationPreferences(context, capabilities);
  const events = notificationEvents(activity, {
    actorId: context.actorId,
    allowedProjectIds: context.membership?.projectIds,
    canViewInternal: hasPermission(context.membership, permissions.projectManage),
    notificationPreferences: preferences
  }, capabilities);
  const readStates = await repository.getNotificationReadStates(context, events.map((event) => event.id));
  return groupNotificationEvents(events, readStates, filter);
}

/**
 * @param {{method: string, path: string, searchParams: URLSearchParams, body: unknown, context: any, repository: any, ldapRuntime?: any, headers?: Record<string, string>, rawBody?: string}} request
 */
export async function route(request) {
  const path = stripPrefix(stripPrefix(request.path, "/api/v1/demo"), "/api/v1");
  const {method, body, context, repository, searchParams} = request;

  if (method === "GET" && path === "/coordination") {
    requirePermission(context, permissions.workspaceRead);
    return coordinationDashboard(repository, context, searchParams.get("initiativeId") || undefined);
  }
  if (method === "PUT" && path === "/coordination/public-registration") {
    requirePermission(context, permissions.workspaceManage);
    requirePermission(context, permissions.projectManage);
    return repository.setPublicCoordinationRegistration(context, body);
  }

  if (method === "GET" && path === "/health") {
    return {
      ok: true,
      service: "teamspaces-api",
      tableConfigured: Boolean(process.env.TABLE_NAME || repository),
      attachmentBucketConfigured: Boolean(process.env.ATTACHMENT_BUCKET_NAME || repository)
    };
  }

  if (method === "GET" && path === "/bootstrap") {
    requirePermission(context, permissions.workspaceRead);
    const [portfolios, projects, summary, workConfiguration, capabilities] = await Promise.all([
      repository.listPortfolios(context),
      repository.listProjects({limit: 25, ...accountFilters(context)}),
      repository.getPortfolioSummary(context),
      repository.getWorkConfiguration(context),
      repository.getWorkspaceCapabilities(context)
    ]);
    return {
      user: context.user,
      workspace: context.workspace,
      membership: context.membership,
      portfolios,
      projects,
      summary,
      workConfiguration,
      capabilities: await clientCapabilities(repository, context, capabilities),
      ...(context.publicDemo ? {publicDemo: context.publicDemo.metadata} : {})
    };
  }

  if (method === "GET" && path === "/me") {
    requirePermission(context, permissions.workspaceRead);
    return {user: context.user, workspace: context.workspace, membership: context.membership};
  }

  if (method === "GET" && path === "/accounts") {
    requirePermission(context, permissions.workspaceRead);
    return {...listEnvelope(await repository.listAccounts(context.actorId), context), currentAccountId: context.workspaceId};
  }
  if (method === "POST" && path === "/accounts") {
    requirePermission(context, permissions.workspaceRead);
    return {statusCode: 201, body: await repository.createAccount(context, parseAccountInput(body))};
  }

  if (method === "PATCH" && path === "/me/profile") {
    requirePermission(context, permissions.workspaceRead);
    return repository.updateCurrentUserProfile(context, parseProfileInput(body));
  }

  if (method === "GET" && path === "/workspace") {
    requirePermission(context, permissions.workspaceRead);
    return repository.getWorkspace(context);
  }
  if (method === "PATCH" && path === "/workspace") {
    requirePermission(context, permissions.workspaceManage);
    return repository.patchWorkspace(context, parseWorkspaceInput(body));
  }

  if (method === "GET" && path === "/capabilities") {
    requirePermission(context, permissions.workspaceRead);
    return clientCapabilities(repository, context, await repository.getWorkspaceCapabilities(context));
  }
  if (method === "PATCH" && path === "/capabilities") {
    requirePermission(context, permissions.workspaceManage);
    return repository.patchWorkspaceCapabilities(context, parseWorkspaceCapabilitiesInput(body));
  }

  if (method === "POST" && path === "/mcp") {
    requirePermission(context, permissions.workspaceRead);
    return {rawJson: await mcpResponse({body, context, repository})};
  }

  const providerWebhookMatch = path.match(/^\/provider-webhooks\/([^/]+)\/([^/]+)$/);
  if (providerWebhookMatch && method === "POST") {
    const workspaceId = decodeURIComponent(providerWebhookMatch[1]);
    if (workspaceId !== context.workspaceId || !context.providerWebhook) throw new NotFoundError("Provider webhook endpoint not found");
    return {statusCode: 202, body: await repository.receiveProviderWebhook(context, decodeURIComponent(providerWebhookMatch[2]), {headers: request.headers, rawBody: request.rawBody})};
  }
  const providerApiMatch = path.match(/^\/provider-api\/([^/]+)\/([^/]+)\/work-items$/);
  if (providerApiMatch && ["GET", "POST"].includes(method)) {
    const workspaceId = decodeURIComponent(providerApiMatch[1]);
    const connectorId = decodeURIComponent(providerApiMatch[2]);
    if (!context.providerApi || workspaceId !== context.workspaceId) throw new NotFoundError("Provider API endpoint not found");
    const providerRequest = {headers: request.headers};
    if (method === "GET") {
      const projectId = requiredText(searchParams.get("projectId"), "projectId", 128);
      const query = String(searchParams.get("query") ?? "");
      if (query.length > 240) throw new ValidationError("query is too long");
      return listEnvelope(await repository.listProviderWorkItems(context, connectorId, {projectId, query}, providerRequest), context);
    }
    const projectId = requiredText(body?.projectId, "projectId", 128);
    const configuration = await repository.getWorkConfiguration(context);
    const input = parseWorkItemInput({...body, type: body?.type ?? configuration.defaultTypeId, status: body?.status ?? configuration.defaultStatusId});
    return {statusCode: 201, body: await repository.createProviderWorkItem(context, connectorId, projectId, input, providerRequest)};
  }
  const ldapAuthenticationMatch = path.match(/^\/ldap-auth\/([^/]+)$/);
  if (ldapAuthenticationMatch && method === "POST") {
    const workspaceId = decodeURIComponent(ldapAuthenticationMatch[1]);
    if (!context.ldapLogin || workspaceId !== context.workspaceId) throw new NotFoundError("LDAP authentication endpoint not found");
    if (typeof body?.username !== "string" || !body.username.trim() || body.username.length > 320 || typeof body?.password !== "string" || !body.password || body.password.length > 1024) throw new ValidationError("LDAP username and password are required");
    const capabilities = await repository.getWorkspaceCapabilities(context);
    const configuration = capabilities.authentication?.ldap;
    if (!configuration?.enabled) throw new NotFoundError("LDAP authentication endpoint not found");
    const user = await request.ldapRuntime.authenticate(configuration, {username: body.username.trim(), password: body.password});
    const groupIds = (capabilities.groups ?? []).filter((group) => group.ldapDn && user.groupDns?.includes(group.ldapDn)).map((group) => group.id);
    const synchronized = await repository.syncDirectory(context, parseDirectorySyncInput({source: "ldap", users: [{externalId: user.externalId, email: user.email, name: user.name, role: configuration.defaultRole ?? roles.viewer, status: user.status, groupIds}]}));
    const credential = await request.ldapRuntime.credential(configuration);
    return {statusCode: 201, body: {...issueLdapSession({workspaceId, user, credential, lifetimeSeconds: configuration.sessionLifetimeSeconds}), user: synchronized.items[0]}};
  }

  if (method === "GET" && path === "/integrations") {
    requirePermission(context, permissions.workspaceRead);
    return repository.listIntegrationCatalog(context);
  }
  const integrationHealthMatch = path.match(/^\/integrations\/([^/]+)\/health$/);
  if (integrationHealthMatch && method === "POST") {
    requirePermission(context, permissions.workspaceManage);
    return repository.checkIntegrationHealth(context, decodeURIComponent(integrationHealthMatch[1]), {callerToken: context.providerToken});
  }
  const integrationResourcesMatch = path.match(/^\/integrations\/([^/]+)\/resources$/);
  if (integrationResourcesMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    const pathValue = String(searchParams.get("path") ?? "");
    const query = String(searchParams.get("query") ?? "");
    const cursor = String(searchParams.get("cursor") ?? "");
    if (pathValue.length > 1000 || query.length > 240 || cursor.length > 500) throw new ValidationError("Provider resource query is too long");
    return repository.browseIntegrationResources(context, decodeURIComponent(integrationResourcesMatch[1]), {path: pathValue, query, cursor, callerToken: context.providerToken});
  }
  if (integrationResourcesMatch && method === "POST") {
    requirePermission(context, permissions.workManage);
    return {statusCode: 201, body: await repository.createIntegrationResource(context, decodeURIComponent(integrationResourcesMatch[1]), parseIntegrationResourceInput(body), {callerToken: context.providerToken})};
  }
  const integrationPermissionsMatch = path.match(/^\/integrations\/([^/]+)\/permissions\/sync$/);
  if (integrationPermissionsMatch && method === "POST") {
    requirePermission(context, permissions.workspaceManage);
    return repository.synchronizeIntegrationPermissions(context, decodeURIComponent(integrationPermissionsMatch[1]), parseIntegrationPermissionSyncInput(body), {callerToken: context.providerToken});
  }
  if (method === "GET" && path === "/integration-links") {
    requirePermission(context, permissions.workspaceRead);
    return listEnvelope(await repository.listIntegrationLinks(context, {
      projectId: searchParams.get("projectId") ?? undefined,
      workItemId: searchParams.get("workItemId") ?? undefined,
      connectorId: searchParams.get("connectorId") ?? undefined
    }), context);
  }
  if (method === "POST" && path === "/integration-links") {
    requirePermission(context, permissions.workManage);
    return {statusCode: 201, body: await repository.createIntegrationLink(context, parseIntegrationLinkInput(body))};
  }
  const integrationLinkMatch = path.match(/^\/integration-links\/([^/]+)$/);
  if (integrationLinkMatch && method === "DELETE") {
    requirePermission(context, permissions.workManage);
    return repository.deleteIntegrationLink(context, decodeURIComponent(integrationLinkMatch[1]), parseVersionInput(body).version);
  }
  const integrationEventMatch = path.match(/^\/integrations\/([^/]+)\/events$/);
  if (integrationEventMatch && method === "POST") {
    requirePermission(context, permissions.workManage);
    return {statusCode: 201, body: await repository.ingestIntegrationEvent(context, decodeURIComponent(integrationEventMatch[1]), parseIntegrationEventInput(body))};
  }
  if (method === "POST" && path === "/integrations/jira/import") {
    requirePermission(context, permissions.workManage);
    return {statusCode: 201, body: await repository.importJiraIssues(context, parseJiraImportInput(body))};
  }
  if (method === "GET" && path === "/repositories") {
    requirePermission(context, permissions.workspaceRead);
    return listEnvelope(await repository.listRepositories(context), context);
  }
  const repositoryTreeMatch = path.match(/^\/repositories\/([^/]+)\/tree$/);
  if (repositoryTreeMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    const repositoryPath = String(searchParams.get("path") ?? "");
    if (repositoryPath.length > 1000 || repositoryPath.split("/").some((segment) => segment === "." || segment === "..")) throw new ValidationError("Repository path is invalid");
    return repository.browseRepository(context, decodeURIComponent(repositoryTreeMatch[1]), {path: repositoryPath, ref: searchParams.get("ref") ?? undefined});
  }
  const repositorySyncMatch = path.match(/^\/repositories\/([^/]+)\/sync$/);
  if (repositorySyncMatch && method === "POST") {
    requirePermission(context, permissions.workspaceManage);
    return repository.syncRepositorySnapshot(context, decodeURIComponent(repositorySyncMatch[1]), parseRepositorySnapshotInput(body));
  }

  if (method === "GET" && path === "/external-shares") {
    requirePermission(context, permissions.projectManage);
    return listEnvelope(await repository.listExternalShares(context), context);
  }
  if (method === "POST" && path === "/external-shares") {
    requirePermission(context, permissions.projectManage);
    return {statusCode: 201, body: await repository.createExternalShare(context, parseExternalShareInput(body))};
  }
  const externalShareMatch = path.match(/^\/external-shares\/([^/]+)$/);
  if (externalShareMatch && method === "DELETE") {
    requirePermission(context, permissions.projectManage);
    return repository.revokeExternalShare(context, decodeURIComponent(externalShareMatch[1]), parseVersionInput(body).version);
  }
  const sharedWorkMatch = path.match(/^\/shared-work\/([^/]+)$/);
  if (sharedWorkMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    return repository.getExternalShare(context, decodeURIComponent(sharedWorkMatch[1]));
  }
  const sharedWorkCommentsMatch = path.match(/^\/shared-work\/([^/]+)\/comments$/);
  if (sharedWorkCommentsMatch && method === "POST") {
    requirePermission(context, permissions.workspaceRead);
    return {statusCode: 201, body: await repository.commentOnExternalShare(context, decodeURIComponent(sharedWorkCommentsMatch[1]), requiredText(body?.summary, "summary", 10000))};
  }

  if (method === "POST" && path === "/outbound-links/check") {
    requirePermission(context, permissions.workspaceRead);
    return repository.checkOutboundLink(context, parseOutboundLinkInput(body));
  }
  if (method === "GET" && path === "/outbound-links/events") {
    requirePermission(context, permissions.workspaceManage);
    return listEnvelope(await repository.listOutboundNavigations(context), context);
  }

  if (method === "POST" && path === "/directory/sync") {
    requirePermission(context, permissions.workspaceManage);
    return repository.syncDirectory(context, parseDirectorySyncInput(body));
  }
  if (method === "POST" && path === "/directory/ldap/sync") {
    requirePermission(context, permissions.workspaceManage);
    return repository.synchronizeLdapDirectory(context, request.ldapRuntime);
  }
  if (method === "GET" && path === "/scim/v2/Users") {
    requirePermission(context, permissions.workspaceManage);
    let resources = (await repository.listMemberships(context)).map(scimUser);
    const filter = String(searchParams.get("filter") ?? "");
    const userNameFilter = filter.match(/^userName\s+eq\s+"([^"]+)"$/i)?.[1];
    const externalIdFilter = filter.match(/^externalId\s+eq\s+"([^"]+)"$/i)?.[1];
    if (userNameFilter) resources = resources.filter((user) => user.userName === userNameFilter);
    if (externalIdFilter) resources = resources.filter((user) => user.externalId === externalIdFilter);
    const startIndex = Math.max(1, Number(searchParams.get("startIndex") ?? 1) || 1);
    const count = Math.min(100, Math.max(0, Number(searchParams.get("count") ?? 100) || 100));
    const page = resources.slice(startIndex - 1, startIndex - 1 + count);
    return {schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: resources.length, startIndex, itemsPerPage: page.length, Resources: page};
  }
  if (method === "POST" && path === "/scim/v2/Users") {
    requirePermission(context, permissions.workspaceManage);
    const result = await repository.syncDirectory(context, parseDirectorySyncInput({source: "scim", users: [scimUserInput(body)]}));
    return {statusCode: 201, body: scimUser(result.items[0])};
  }
  const scimUserMatch = path.match(/^\/scim\/v2\/Users\/([^/]+)$/);
  if (scimUserMatch && ["GET", "PUT", "PATCH", "DELETE"].includes(method)) {
    requirePermission(context, permissions.workspaceManage);
    const userId = decodeURIComponent(scimUserMatch[1]);
    const members = await repository.listMemberships(context);
    const current = members.find((member) => member.userId === userId);
    if (!current) throw new NotFoundError("SCIM user not found");
    if (method === "GET") return scimUser(current);
    if (method === "PUT") {
      const replacement = {...scimUserInput(body), externalId: userId};
      const result = await repository.syncDirectory(context, parseDirectorySyncInput({source: "scim", users: [replacement]}));
      return scimUser(result.items[0]);
    }
    const patchOperations = Array.isArray(body?.Operations) ? body.Operations : [];
    const activeOperation = patchOperations.find((operation) => String(operation.path ?? "").toLowerCase() === "active");
    const displayNameOperation = patchOperations.find((operation) => String(operation.path ?? "").toLowerCase() === "displayname");
    const roleOperation = patchOperations.find((operation) => String(operation.path ?? "").toLowerCase() === "role");
    const user = {
      externalId: userId,
      email: current.email,
      name: displayNameOperation?.value ?? current.name,
      role: roleOperation?.value ?? current.role,
      status: method === "DELETE" || activeOperation?.value === false ? "disabled" : current.status,
      groupIds: current.groupIds ?? []
    };
    const result = await repository.syncDirectory(context, parseDirectorySyncInput({source: "scim", users: [user]}));
    return method === "DELETE" ? {statusCode: 204, body: {}} : scimUser(result.items[0]);
  }
  if (method === "GET" && path === "/scim/v2/Groups") {
    requirePermission(context, permissions.workspaceManage);
    const [capabilities, memberships] = await Promise.all([repository.getWorkspaceCapabilities(context), repository.listMemberships(context)]);
    let resources = (capabilities.groups ?? []).map((group) => scimGroup(group, memberships));
    const displayNameFilter = String(searchParams.get("filter") ?? "").match(/^displayName\s+eq\s+"([^"]+)"$/i)?.[1];
    if (displayNameFilter) resources = resources.filter((group) => group.displayName === displayNameFilter);
    const startIndex = Math.max(1, Number(searchParams.get("startIndex") ?? 1) || 1);
    const count = Math.min(100, Math.max(0, Number(searchParams.get("count") ?? 100) || 100));
    const page = resources.slice(startIndex - 1, startIndex - 1 + count);
    return {schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: resources.length, startIndex, itemsPerPage: page.length, Resources: page};
  }
  if (method === "POST" && path === "/scim/v2/Groups") {
    requirePermission(context, permissions.workspaceManage);
    const capabilities = await repository.getWorkspaceCapabilities(context);
    const input = scimGroupInput(body);
    input.id = scimGroupId(input.externalId ?? input.name, capabilities.groups ?? []);
    const saved = await repository.saveScimGroup(context, input);
    return {statusCode: 201, body: scimGroup(saved.group, saved.memberships)};
  }
  const scimGroupMatch = path.match(/^\/scim\/v2\/Groups\/([^/]+)$/);
  if (scimGroupMatch && method === "GET") {
    requirePermission(context, permissions.workspaceManage);
    const groupId = decodeURIComponent(scimGroupMatch[1]);
    const [capabilities, memberships] = await Promise.all([repository.getWorkspaceCapabilities(context), repository.listMemberships(context)]);
    const group = capabilities.groups?.find((item) => item.id === groupId);
    if (!group) throw new NotFoundError("SCIM group not found");
    return scimGroup(group, memberships);
  }
  if (scimGroupMatch && ["PUT", "PATCH", "DELETE"].includes(method)) {
    requirePermission(context, permissions.workspaceManage);
    const groupId = decodeURIComponent(scimGroupMatch[1]);
    const [capabilities, memberships] = await Promise.all([repository.getWorkspaceCapabilities(context), repository.listMemberships(context)]);
    const current = capabilities.groups?.find((item) => item.id === groupId);
    if (!current) throw new NotFoundError("SCIM group not found");
    if (method === "DELETE") {
      await repository.deleteScimGroup(context, groupId);
      return {statusCode: 204, body: {}};
    }
    let name = current.name ?? current.label ?? current.id;
    let memberIds = memberships.filter((member) => member.groupIds?.includes(groupId)).map((member) => member.userId);
    let externalId = current.scimExternalId ?? current.externalId;
    let customFields = current.customFields ?? {};
    if (method === "PUT") {
      const replacement = scimGroupInput(body, groupId);
      name = replacement.name;
      memberIds = replacement.memberIds;
      externalId = replacement.externalId;
      customFields = replacement.customFields;
    } else {
      for (const operation of Array.isArray(body?.Operations) ? body.Operations : []) {
        const op = String(operation.op ?? "replace").toLowerCase();
        const operationPath = String(operation.path ?? "");
        if (operationPath.toLowerCase() === "displayname") name = String(operation.value ?? "").trim().slice(0, 200) || name;
        if (operationPath.toLowerCase() === "externalid") externalId = String(operation.value ?? "").trim().slice(0, 128) || externalId;
        if (["customfields", `${scimGroupCustomFieldsSchema}:customfields`.toLowerCase()].includes(operationPath.toLowerCase())) customFields = customFieldRecord(operation.value);
        if (operationPath.toLowerCase() === "members" || !operationPath && operation.value?.members) {
          const values = operationPath ? operation.value : operation.value.members;
          const ids = (Array.isArray(values) ? values : [values]).map((member) => typeof member === "string" ? member : member?.value).filter(Boolean);
          if (op === "replace") memberIds = [...new Set(ids)];
          if (op === "add") memberIds = [...new Set([...memberIds, ...ids])];
          if (op === "remove") memberIds = memberIds.filter((id) => !ids.includes(id));
        } else if (op === "remove") {
          const selectedId = operationPath.match(/^members\[value\s+eq\s+"([^"]+)"\]$/i)?.[1];
          if (selectedId) memberIds = memberIds.filter((id) => id !== selectedId);
        }
      }
    }
    if (memberIds.length > 90) throw new ValidationError("SCIM groups support at most 90 members per request");
    const saved = await repository.saveScimGroup(context, {id: groupId, name, externalId, memberIds, customFields});
    return scimGroup(saved.group, saved.memberships);
  }

  const webhookDeliveryMatch = path.match(/^\/webhooks\/([^/]+)\/deliver$/);
  if (webhookDeliveryMatch && method === "POST") {
    requirePermission(context, permissions.workspaceManage);
    return {statusCode: 202, body: await repository.deliverWebhook(context, decodeURIComponent(webhookDeliveryMatch[1]), webhookEventInput(body))};
  }
  if (method === "GET" && path === "/webhook-deliveries") {
    requirePermission(context, permissions.workspaceManage);
    return listEnvelope(await repository.listWebhookDeliveries(context), context);
  }

  if (method === "GET" && path === "/work-configuration") {
    requirePermission(context, permissions.workspaceRead);
    return repository.getWorkConfiguration(context);
  }
  if (method === "PATCH" && path === "/work-configuration") {
    requirePermission(context, permissions.workspaceManage);
    return repository.patchWorkConfiguration(context, parseWorkConfigurationInput(body));
  }

  if (method === "GET" && path === "/memberships") {
    requirePermission(context, permissions.workspaceRead);
    return listEnvelope(await repository.listMemberships(context), context);
  }
  if (method === "POST" && path === "/memberships") {
    requirePermission(context, permissions.workspaceManage);
    return {statusCode: 201, body: await repository.upsertMembership(context, parseMembershipInput(body))};
  }

  const membershipMatch = path.match(/^\/memberships\/([^/]+)$/);
  if (membershipMatch && method === "PATCH") {
    requirePermission(context, permissions.workspaceManage);
    return repository.patchMembership(context, membershipMatch[1], parseMembershipInput(body));
  }
  if (method === "GET" && path === "/placeholders") {
    requirePermission(context, permissions.workspaceRead);
    return listEnvelope(await repository.listPlaceholders(context), context);
  }
  if (method === "POST" && path === "/placeholders") {
    requirePermission(context, permissions.workspaceManage);
    return {statusCode: 201, body: await repository.createPlaceholder(context, parsePlaceholderInput(body))};
  }

  if (method === "GET" && path === "/portfolios") {
    requirePermission(context, permissions.workspaceRead);
    return listEnvelope(await repository.listPortfolios(context), context);
  }

  if (method === "POST" && path === "/portfolios") {
    requirePermission(context, permissions.portfolioManage);
    return {statusCode: 201, body: await repository.createPortfolio(context, parsePortfolioInput(body))};
  }

  const portfolioMatch = path.match(/^\/portfolios\/([^/]+)$/);
  if (portfolioMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    const item = (await repository.listPortfolios(context)).find((portfolio) => portfolio.id === portfolioMatch[1]);
    if (!item) throw new NotFoundError("Portfolio not found");
    return item;
  }
  if (portfolioMatch && method === "PATCH") {
    requirePermission(context, permissions.portfolioManage);
    return repository.patchPortfolio(context, portfolioMatch[1], parsePortfolioPatchInput(body));
  }

  if (method === "GET" && path === "/projects") {
    requirePermission(context, permissions.workspaceRead);
    return listEnvelope(await repository.listProjects({...parseListOptions(searchParams), ...accountFilters(context)}), context);
  }
  if (method === "POST" && path === "/projects") {
    requirePermission(context, permissions.projectCreate);
    return {statusCode: 201, body: await repository.createProject(context, parseProjectInput(body))};
  }

  const projectMatch = path.match(/^\/projects\/([^/]+)$/);
  if (projectMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    return repository.getProject(projectMatch[1], context.workspaceId, context.membership?.projectIds);
  }
  if (projectMatch && method === "PATCH") {
    requirePermission(context, permissions.projectManage);
    return repository.patchProject(context, projectMatch[1], parseProjectPatchInput(body));
  }

  const projectCopyMatch = path.match(/^\/projects\/([^/]+)\/copy$/);
  if (projectCopyMatch && method === "POST") {
    requirePermission(context, permissions.projectCreate);
    return {statusCode: 201, body: await repository.copyProject(context, projectCopyMatch[1], parseProjectCopyInput(body))};
  }
  const projectArchiveMatch = path.match(/^\/projects\/([^/]+)\/(archive|restore)$/);
  if (projectArchiveMatch && method === "POST") {
    requirePermission(context, permissions.projectManage);
    const input = parseVersionInput(body);
    return repository.patchProject(context, projectArchiveMatch[1], {
      ...input,
      archived: projectArchiveMatch[2] === "archive",
      status: projectArchiveMatch[2] === "archive" ? "archived" : "active"
    });
  }
  if (projectMatch && method === "DELETE") {
    requirePermission(context, permissions.projectManage);
    return repository.deleteProject(context, projectMatch[1], parseVersionInput(body));
  }

  const projectInitiationSubmitMatch = path.match(/^\/projects\/([^/]+)\/initiation\/submit$/);
  if (projectInitiationSubmitMatch && method === "POST") {
    requirePermission(context, permissions.projectManage);
    return repository.submitProjectInitiation(context, projectInitiationSubmitMatch[1], parseProjectInitiationInput(body));
  }
  const projectInitiationReviewMatch = path.match(/^\/projects\/([^/]+)\/initiation\/review$/);
  if (projectInitiationReviewMatch && method === "POST") {
    requirePermission(context, permissions.projectManage);
    return repository.reviewProjectInitiation(context, projectInitiationReviewMatch[1], parseProjectInitiationReviewInput(body));
  }
  const projectGateMatch = path.match(/^\/projects\/([^/]+)\/lifecycle-gates\/([^/]+)\/approve$/);
  if (projectGateMatch && method === "POST") {
    requirePermission(context, permissions.projectManage);
    return repository.approveLifecycleGate(context, projectGateMatch[1], decodeURIComponent(projectGateMatch[2]), parseLifecycleGateApprovalInput(body));
  }

  const projectWorkMatch = path.match(/^\/projects\/([^/]+)\/work-items$/);
  if (projectWorkMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    return repository.listWorkItemsPage({
      ...parseWorkQuery(searchParams, {projectId: projectWorkMatch[1], defaultSort: "id-asc"}),
      ...accountFilters(context)
    });
  }
  if (projectWorkMatch && method === "POST") {
    requirePermission(context, permissions.workManage);
    return {statusCode: 201, body: await repository.createWorkItem(context, projectWorkMatch[1], parseWorkItemInput(body))};
  }

  const projectWorkItemMatch = path.match(/^\/projects\/([^/]+)\/work-items\/([^/]+)$/);
  if (projectWorkItemMatch && method === "PATCH") {
    requirePermission(context, permissions.workManage);
    return repository.patchWorkItem(context, projectWorkItemMatch[1], projectWorkItemMatch[2], parseWorkItemPatchInput(body));
  }
  if (projectWorkItemMatch && method === "DELETE") {
    requirePermission(context, permissions.workManage);
    return repository.deleteWorkItem(context, projectWorkItemMatch[1], projectWorkItemMatch[2], parseVersionInput(body));
  }
  const projectWorkCopyMatch = path.match(/^\/projects\/([^/]+)\/work-items\/([^/]+)\/copy$/);
  if (projectWorkCopyMatch && method === "POST") {
    requirePermission(context, permissions.workManage);
    return {statusCode: 201, body: await repository.copyWorkItem(context, projectWorkCopyMatch[1], projectWorkCopyMatch[2], parseWorkItemCopyInput(body))};
  }
  const projectWorkMoveMatch = path.match(/^\/projects\/([^/]+)\/work-items\/([^/]+)\/move$/);
  if (projectWorkMoveMatch && method === "POST") {
    requirePermission(context, permissions.workManage);
    return repository.moveWorkItem(context, projectWorkMoveMatch[1], projectWorkMoveMatch[2], parseWorkItemMoveInput(body));
  }
  const projectWorkActionMatch = path.match(/^\/projects\/([^/]+)\/work-items\/([^/]+)\/actions\/([^/]+)$/);
  if (projectWorkActionMatch && method === "POST") {
    requirePermission(context, permissions.workManage);
    return repository.applyWorkItemCustomAction(context, projectWorkActionMatch[1], projectWorkActionMatch[2], decodeURIComponent(projectWorkActionMatch[3]), parseVersionInput(body));
  }

  if (method === "GET" && path === "/work-items/assigned") {
    requirePermission(context, permissions.workspaceRead);
    return listEnvelope(await repository.listAssignedWork(context.actorId, {
      ...accountFilters(context),
      limit: publicListReadLimit(context)
    }), context);
  }

  if (method === "GET" && path === "/planning") {
    requirePermission(context, permissions.workspaceRead);
    const workConfiguration = await repository.getWorkConfiguration(context);
    const query = {...parseWorkQuery(searchParams), ...accountFilters(context), workConfiguration};
    const page = await repository.listPlanningWorkItemsPage(query);
    return {
      ...page,
      summary: buildPlanningSummary(page.items, workConfiguration),
      summaryScope: page.queryMode === "legacy-transition"
        ? "legacy-transition"
        : query.cursor || page.pageInfo.hasNextPage
          ? "page"
          : "result"
    };
  }

  if (method === "POST" && path.match(/^\/projects\/[^/]+\/schedule$/)) {
    requirePermission(context, permissions.projectManage);
    const projectId = decodeURIComponent(path.split("/")[2]);
    return repository.scheduleProject(context, projectId);
  }
  const historicalBaselineMatch = path.match(/^\/projects\/([^/]+)\/baseline-comparison$/);
  if (historicalBaselineMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    const today = new Date().toISOString().slice(0, 10);
    const yesterdayDate = new Date(`${today}T00:00:00.000Z`);
    yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
    const from = dateQuery(searchParams.get("from") ?? yesterdayDate.toISOString().slice(0, 10), "from");
    const to = dateQuery(searchParams.get("to") ?? today, "to");
    if (from > to) throw new ValidationError("from must not be after to");
    if (to > today) throw new ValidationError("to must not be in the future");
    return repository.compareHistoricalBaseline(context, decodeURIComponent(historicalBaselineMatch[1]), from, to);
  }

  if (method === "GET" && path === "/planning-resources") {
    requirePermission(context, permissions.workspaceRead);
    const projectId = String(searchParams.get("projectId") ?? "").trim();
    if (!projectId) throw new ValidationError("projectId is required");
    const kind = searchParams.get("kind") ?? undefined;
    if (kind && !planningResourceKinds.includes(kind)) throw new ValidationError("kind is invalid");
    return listEnvelope(await repository.listPlanningResources(context, {
      projectId,
      kind,
      status: searchParams.get("status") ?? undefined,
      limit: Math.min(Number(searchParams.get("limit") ?? 100) || 100, 100)
    }), context);
  }
  if (method === "POST" && path === "/planning-resources") {
    requirePermission(context, permissions.projectManage);
    return {statusCode: 201, body: await repository.createPlanningResource(context, parsePlanningResourceInput(body))};
  }
  const baselineComparisonMatch = path.match(/^\/planning-resources\/([^/]+)\/baseline-comparison$/);
  if (baselineComparisonMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    const projectId = String(searchParams.get("projectId") ?? "").trim();
    if (!projectId) throw new ValidationError("projectId is required");
    return repository.comparePlanningBaseline(context, projectId, decodeURIComponent(baselineComparisonMatch[1]));
  }
  const burndownMatch = path.match(/^\/planning-resources\/([^/]+)\/burndown$/);
  if (burndownMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    const projectId = String(searchParams.get("projectId") ?? "").trim();
    if (!projectId) throw new ValidationError("projectId is required");
    return repository.getSprintBurndown(context, projectId, decodeURIComponent(burndownMatch[1]));
  }
  const planningResourceMatch = path.match(/^\/planning-resources\/([^/]+)$/);
  if (planningResourceMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    const projectId = String(searchParams.get("projectId") ?? "").trim();
    if (!projectId) throw new ValidationError("projectId is required");
    return repository.getPlanningResource(context, projectId, decodeURIComponent(planningResourceMatch[1]));
  }
  if (planningResourceMatch && method === "PATCH") {
    requirePermission(context, permissions.projectManage);
    const projectId = String(searchParams.get("projectId") ?? "").trim();
    if (!projectId) throw new ValidationError("projectId is required");
    return repository.patchPlanningResource(context, projectId, decodeURIComponent(planningResourceMatch[1]), parsePlanningResourcePatchInput(body));
  }
  if (planningResourceMatch && method === "DELETE") {
    requirePermission(context, permissions.projectManage);
    const projectId = String(searchParams.get("projectId") ?? "").trim();
    if (!projectId) throw new ValidationError("projectId is required");
    return repository.deletePlanningResource(context, projectId, decodeURIComponent(planningResourceMatch[1]), parseVersionInput(body));
  }

  if (method === "GET" && path === "/meetings") {
    requirePermission(context, permissions.workspaceRead);
    return repository.listMeetingsPage(context, parseMeetingQuery(searchParams));
  }
  if (method === "POST" && path === "/meetings") {
    requirePermission(context, permissions.meetingManage);
    return {statusCode: 201, body: await repository.createMeeting(context, parseMeetingInput(body))};
  }

  const meetingMatch = path.match(/^\/meetings\/([^/]+)$/);
  if (meetingMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    const projectId = parseMeetingIdentifier(searchParams.get("projectId"), "projectId");
    return repository.getMeeting(context, projectId, meetingPathIdentifier(meetingMatch[1]));
  }
  if (meetingMatch && method === "PATCH") {
    requirePermission(context, permissions.meetingManage);
    const input = parseMeetingPatchInput(body);
    return repository.patchMeeting(context, input.projectId, meetingPathIdentifier(meetingMatch[1]), input);
  }
  if (meetingMatch && method === "DELETE") {
    requirePermission(context, permissions.meetingManage);
    const projectId = String(searchParams.get("projectId") ?? "").trim();
    if (!projectId) throw new ValidationError("projectId is required");
    return repository.deleteMeeting(context, projectId, meetingPathIdentifier(meetingMatch[1]), parseVersionInput(body));
  }
  const meetingCopyMatch = path.match(/^\/meetings\/([^/]+)\/copy$/);
  if (meetingCopyMatch && method === "POST") {
    requirePermission(context, permissions.meetingManage);
    const input = parseMeetingCopyInput(body);
    return {statusCode: 201, body: await repository.copyMeeting(context, input.projectId, meetingPathIdentifier(meetingCopyMatch[1]), input)};
  }
  const meetingAttendanceMatch = path.match(/^\/meetings\/([^/]+)\/attendance$/);
  if (meetingAttendanceMatch && method === "POST") {
    requirePermission(context, permissions.workspaceRead);
    const projectId = String(searchParams.get("projectId") ?? "").trim();
    if (!projectId) throw new ValidationError("projectId is required");
    return repository.respondMeetingAttendance(context, projectId, meetingPathIdentifier(meetingAttendanceMatch[1]), parseMeetingAttendanceResponseInput(body));
  }
  const meetingCalendarMatch = path.match(/^\/meetings\/([^/]+)\/calendar$/);
  if (meetingCalendarMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    const projectId = String(searchParams.get("projectId") ?? "").trim();
    if (!projectId) throw new ValidationError("projectId is required");
    return repository.exportMeetingCalendar(context, projectId, meetingPathIdentifier(meetingCalendarMatch[1]));
  }
  const meetingPdfMatch = path.match(/^\/meetings\/([^/]+)\/pdf$/);
  if (meetingPdfMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    const projectId = String(searchParams.get("projectId") ?? "").trim();
    if (!projectId) throw new ValidationError("projectId is required");
    return repository.exportMeetingPdf(context, projectId, meetingPathIdentifier(meetingPdfMatch[1]));
  }

  if (method === "GET" && path === "/time-entries") {
    requirePermission(context, permissions.workspaceRead);
    return listEnvelope(await repository.listTimeEntries({
      ...accountFilters(context),
      userId: context.actorId,
      projectId: searchParams.get("projectId") ?? undefined,
      limit: publicListReadLimit(context)
    }), context);
  }
  if (method === "POST" && path === "/time-entries") {
    requirePermission(context, permissions.timeManageOwn);
    return {statusCode: 201, body: await repository.createTimeEntry(context, parseTimeEntryInput(body))};
  }
  const timeEntryMatch = path.match(/^\/time-entries\/([^/]+)$/);
  if (timeEntryMatch && method === "PATCH") {
    requirePermission(context, permissions.timeManageOwn);
    return repository.patchTimeEntry(context, timeEntryMatch[1], parseTimeEntryPatchInput(body));
  }
  if (timeEntryMatch && method === "DELETE") {
    requirePermission(context, permissions.timeManageOwn);
    return repository.deleteTimeEntry(context, timeEntryMatch[1], parseTimeEntryPatchInput(body));
  }
  if (method === "GET" && path === "/timer") {
    requirePermission(context, permissions.workspaceRead);
    return repository.getTimer(context);
  }
  if (method === "POST" && path === "/timer/start") {
    requirePermission(context, permissions.timeManageOwn);
    return {statusCode: 201, body: await repository.startTimer(context, parseTimerStartInput(body))};
  }
  if (method === "POST" && path === "/timer/stop") {
    requirePermission(context, permissions.timeManageOwn);
    return repository.stopTimer(context);
  }

  if (method === "GET" && path === "/activity") {
    requirePermission(context, permissions.workspaceRead);
    const projectId = searchParams.get("projectId") ?? undefined;
    if (projectId) await repository.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    let items = await repository.listActivity(projectId, context.workspaceId, publicListReadLimit(context));
    if (!hasPermission(context.membership, permissions.projectManage)) items = items.filter((item) => item.visibility !== "internal");
    const entityType = searchParams.get("entityType");
    const entityId = searchParams.get("entityId");
    if (entityType) items = items.filter((item) => item.entityType === entityType);
    if (entityId) items = items.filter((item) => item.entityId === entityId);
    items = items.map((item) => item.actorId === context.actorId ? item : Object.fromEntries(Object.entries(item).filter(([key]) => key !== "reminderAt")));
    return listEnvelope(items, context);
  }
  if (method === "GET" && path === "/notifications") {
    requirePermission(context, permissions.workspaceRead);
    const projectId = searchParams.get("projectId") ?? undefined;
    if (projectId) await repository.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    return userNotificationCenter(context, repository, searchParams.get("filter") ?? "all", projectId);
  }
  if (method === "GET" && path === "/notification-preferences") {
    requirePermission(context, permissions.workspaceRead);
    return {...await repository.getNotificationPreferences(context), scheduledDeliveryAvailable: process.env.SCHEDULED_NOTIFICATIONS_ENABLED !== "false"};
  }
  if (method === "PATCH" && path === "/notification-preferences") {
    requirePermission(context, permissions.workspaceRead);
    const preferences = parseNotificationPreferencesInput(body);
    const capabilities = await repository.getWorkspaceCapabilities(context);
    if (preferences.emailDigest !== "none") {
      const gateway = capabilities.webhooks?.find((item) => item.id === preferences.deliveryWebhookId && item.enabled !== false);
      const events = gateway?.eventTypes ?? gateway?.events ?? [];
      if (!gateway || !events.includes("notification.digest") && !events.includes("*")) throw new ValidationError("The delivery webhook must be enabled for notification.digest");
    }
    for (const override of preferences.projectOverrides) await repository.getProject(override.projectId, context.workspaceId, context.membership?.projectIds);
    return repository.saveNotificationPreferences(context, preferences);
  }
  if (method === "POST" && path === "/notifications/read") {
    requirePermission(context, permissions.workspaceRead);
    const requestedIds = notificationReadIds(body);
    if (!requestedIds.length) throw new ValidationError("ids must contain at least one notification ID");
    const center = await userNotificationCenter(context, repository);
    const accessibleIds = new Set(center.items.map((item) => item.id));
    const ids = requestedIds.filter((id) => accessibleIds.has(id));
    if (!ids.length) throw new NotFoundError("Notifications not found");
    return repository.setNotificationReadStates(context, ids, body?.read !== false);
  }
  if (method === "POST" && path === "/notifications/read-all") {
    requirePermission(context, permissions.workspaceRead);
    const center = await userNotificationCenter(context, repository);
    return repository.setNotificationReadStates(context, center.items.filter((item) => item.unread).map((item) => item.id), true);
  }
  if (method === "GET" && path === "/notifications/digest") {
    requirePermission(context, permissions.workspaceRead);
    return buildNotificationDigest(context, repository);
  }
  if (method === "POST" && path === "/notifications/digest/deliver") {
    requirePermission(context, permissions.workspaceRead);
    const preferences = await repository.getNotificationPreferences(context);
    const webhookId = typeof body?.webhookId === "string" && body.webhookId.trim() ? requiredText(body.webhookId, "webhookId", 128) : preferences.deliveryWebhookId;
    if (!webhookId) throw new ValidationError("A notification delivery webhook is required");
    const digest = await buildNotificationDigest(context, repository, {preferences});
    if (digest.frequency === "none") throw new ValidationError("Email digest delivery is disabled");
    const delivery = await repository.deliverWebhook(context, webhookId, {eventType: "notification.digest", payload: digest});
    return {statusCode: 202, body: {digest, delivery}};
  }
  if (method === "GET" && path === "/search") {
    requirePermission(context, permissions.workspaceRead);
    const query = String(searchParams.get("q") ?? "").trim();
    if (query.length > 200) throw new ValidationError("q must be at most 200 characters");
    return repository.globalSearch(context, query, Math.min(Number(searchParams.get("limit") ?? 50) || 50, 100));
  }
  if (method === "GET" && path === "/exports/work-items") {
    requirePermission(context, permissions.reportRead);
    const branding = (await repository.getWorkspaceCapabilities(context)).branding ?? {};
    const format = String(searchParams.get("format") ?? "csv").toLowerCase();
    if (!["csv", "xls", "pdf", "atom"].includes(format)) throw new ValidationError("format must be csv, xls, pdf, or atom");
    const projectId = searchParams.get("projectId") ?? "";
    let items;
    let title = "Team Spaces work items";
    if (projectId) {
      const project = await repository.getProject(projectId, context.workspaceId, context.membership?.projectIds);
      items = (await repository.listWorkItems(projectId, context.workspaceId, context.membership?.projectIds)).map((item) => ({...item, projectName: project.name}));
      title = `${project.name} work items`;
    } else {
      items = await repository.listPlanningWorkItems({workspaceId: context.workspaceId, allowedProjectIds: context.membership?.projectIds, limit: 100});
    }
    return workItemExport(format, items, {title, branding});
  }
  if (method === "GET" && path === "/exports/gantt") {
    requirePermission(context, permissions.reportRead);
    const projectId = String(searchParams.get("projectId") ?? "").trim();
    if (!projectId) throw new ValidationError("projectId is required");
    const project = await repository.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const items = (await repository.listWorkItems(projectId, context.workspaceId, context.membership?.projectIds)).map((item) => ({...item, projectName: project.name}));
    const branding = (await repository.getWorkspaceCapabilities(context)).branding ?? {};
    return ganttPdfExport(items, {title: `${project.name} Gantt`, branding});
  }
  if (method === "POST" && path === "/activity") {
    requirePermission(context, permissions.workManage);
    const input = parseActivityInput(body);
    if (input.visibility === "internal") requirePermission(context, permissions.projectManage);
    await repository.getProject(input.projectId, context.workspaceId, context.membership?.projectIds);
    const workItem = input.entityType === "work-item"
      ? (await repository.listWorkItems(input.projectId, context.workspaceId, context.membership?.projectIds)).find((item) => item.id === input.entityId)
      : undefined;
    if (input.entityType === "work-item" && !workItem) throw new NotFoundError("Task not found");
    const activity = await repository.recordActivity(context, input.projectId, input.entityType, input.entityId, input.parentId ? "comment.replied" : "comment.created", ["summary"], input.summary, {
      parentId: input.parentId,
      mentions: input.mentions,
      reactions: input.reactions,
      visibility: input.visibility,
      format: input.format,
      reminderAt: input.reminderAt,
      notificationRecipients: workNotificationRecipients(workItem)
    });
    return {statusCode: 201, body: activity};
  }

  if (method === "GET" && path === "/project-content") {
    requirePermission(context, permissions.workspaceRead);
    const projectId = String(searchParams.get("projectId") ?? "").trim();
    if (!projectId) throw new ValidationError("projectId is required");
    const kind = searchParams.get("kind") ?? undefined;
    const status = searchParams.get("status") ?? undefined;
    if (kind && !projectContentKinds.includes(kind)) throw new ValidationError("kind is invalid");
    if (status && !projectContentStatuses.includes(status)) throw new ValidationError("status is invalid");
    const search = String(searchParams.get("search") ?? "").trim().slice(0, 200);
    return listEnvelope(await repository.listProjectContent(context, {
      projectId,
      kind,
      status,
      search,
      limit: Math.min(Number(searchParams.get("limit") ?? 100) || 100, 100)
    }), context);
  }
  if (method === "POST" && path === "/project-content") {
    requirePermission(context, permissions.workManage);
    return {statusCode: 201, body: await repository.createProjectContent(context, parseProjectContentInput(body))};
  }
  const contentRevisionMatch = path.match(/^\/project-content\/([^/]+)\/revisions$/);
  if (contentRevisionMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    const projectId = String(searchParams.get("projectId") ?? "").trim();
    if (!projectId) throw new ValidationError("projectId is required");
    return listEnvelope(await repository.listProjectContentRevisions(context, projectId, decodeURIComponent(contentRevisionMatch[1])), context);
  }
  const contentOperationsMatch = path.match(/^\/project-content\/([^/]+)\/operations$/);
  if (contentOperationsMatch && method === "POST") {
    requirePermission(context, permissions.workManage);
    const projectId = String(searchParams.get("projectId") ?? "").trim();
    if (!projectId) throw new ValidationError("projectId is required");
    return {statusCode: 200, body: await repository.applyProjectContentOperations(context, projectId, decodeURIComponent(contentOperationsMatch[1]), parseContentOperationsInput(body))};
  }
  const contentPresenceMatch = path.match(/^\/project-content\/([^/]+)\/presence$/);
  if (contentPresenceMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    const projectId = String(searchParams.get("projectId") ?? "").trim();
    if (!projectId) throw new ValidationError("projectId is required");
    return listEnvelope(await repository.listProjectContentPresence(context, projectId, decodeURIComponent(contentPresenceMatch[1])), context);
  }
  if (contentPresenceMatch && method === "POST") {
    requirePermission(context, permissions.workspaceRead);
    const projectId = String(searchParams.get("projectId") ?? "").trim();
    if (!projectId) throw new ValidationError("projectId is required");
    return {statusCode: 200, body: await repository.updateProjectContentPresence(context, projectId, decodeURIComponent(contentPresenceMatch[1]), parseContentPresenceInput(body))};
  }
  const projectContentMatch = path.match(/^\/project-content\/([^/]+)$/);
  if (projectContentMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    const projectId = String(searchParams.get("projectId") ?? "").trim();
    if (!projectId) throw new ValidationError("projectId is required");
    return {statusCode: 200, body: await repository.getProjectContent(context, projectId, decodeURIComponent(projectContentMatch[1]))};
  }
  if (projectContentMatch && method === "PATCH") {
    requirePermission(context, permissions.workManage);
    const projectId = String(searchParams.get("projectId") ?? "").trim();
    if (!projectId) throw new ValidationError("projectId is required");
    return {statusCode: 200, body: await repository.patchProjectContent(context, projectId, decodeURIComponent(projectContentMatch[1]), parseProjectContentPatchInput(body))};
  }
  if (projectContentMatch && method === "DELETE") {
    requirePermission(context, permissions.workManage);
    const projectId = String(searchParams.get("projectId") ?? "").trim();
    if (!projectId) throw new ValidationError("projectId is required");
    return repository.deleteProjectContent(context, projectId, decodeURIComponent(projectContentMatch[1]), parseVersionInput(body));
  }

  if (method === "GET" && path === "/documents") {
    requirePermission(context, permissions.workspaceRead);
    return {items: await repository.listDocuments({...parseListOptions(searchParams), ...accountFilters(context)}), pageInfo: {hasNextPage: false}};
  }
  if (method === "POST" && path === "/documents/upload-intent") {
    requirePermission(context, permissions.attachmentManage);
    return {statusCode: 201, body: await repository.createDocumentUploadIntent(context, parseDocumentUploadIntentInput(body))};
  }
  if (method === "POST" && path === "/documents/finalize") {
    requirePermission(context, permissions.attachmentManage);
    return {statusCode: 201, body: await repository.finalizeDocument(context, parseDocumentFinalizeInput(body))};
  }

  const documentDownloadMatch = path.match(/^\/documents\/([^/]+)\/download$/);
  if (documentDownloadMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    const projectId = searchParams.get("projectId");
    if (!projectId) throw new ValidationError("projectId is required");
    return repository.createDocumentDownloadIntent(context, projectId, documentDownloadMatch[1]);
  }

  const documentScanMatch = path.match(/^\/documents\/([^/]+)\/scan$/);
  if (documentScanMatch && method === "POST") {
    requirePermission(context, permissions.workspaceManage);
    const projectId = searchParams.get("projectId");
    if (!projectId) throw new ValidationError("projectId is required");
    return repository.recordDocumentScan(context, projectId, documentScanMatch[1], documentScanInput(body));
  }
  const documentScanRequestMatch = path.match(/^\/documents\/([^/]+)\/scan-request$/);
  if (documentScanRequestMatch && method === "POST") {
    requirePermission(context, permissions.attachmentManage);
    const projectId = searchParams.get("projectId");
    if (!projectId) throw new ValidationError("projectId is required");
    return {statusCode: 202, body: await repository.createDocumentScanRequest(context, projectId, documentScanRequestMatch[1])};
  }

  const documentMatch = path.match(/^\/documents\/([^/]+)$/);
  if (documentMatch && method === "PATCH") {
    requirePermission(context, permissions.attachmentManage);
    const projectId = searchParams.get("projectId");
    if (!projectId) throw new ValidationError("projectId is required");
    return repository.patchDocument(context, projectId, documentMatch[1], parseDocumentPatchInput(body));
  }

  if (method === "GET" && path === "/saved-views") {
    requirePermission(context, permissions.workspaceRead);
    return listEnvelope(await repository.listSavedViews(context.actorId, context.workspaceId, publicListReadLimit(context)), context);
  }
  if (method === "POST" && path === "/saved-views") {
    requirePermission(context, permissions.savedViewManage);
    return {statusCode: 201, body: await repository.createSavedView(context, parseSavedViewInput(body))};
  }

  if (method === "GET" && path === "/reports/portfolio-summary") {
    requirePermission(context, permissions.reportRead);
    return repository.getPortfolioSummary(context);
  }
  if (method === "GET" && path === "/reports/planning-summary") {
    requirePermission(context, permissions.reportRead);
    return repository.getPlanningSummary(context);
  }
  if (method === "GET" && path === "/reports/project-timeline") {
    requirePermission(context, permissions.reportRead);
    return {items: await repository.getProjectTimeline(context)};
  }
  if (method === "GET" && path === "/reports/costs") {
    requirePermission(context, permissions.reportRead);
    return repository.getCostReport(context, {definitionId: String(searchParams.get("definitionId") ?? "").trim()});
  }
  if (method === "GET" && path === "/reports/resources") {
    requirePermission(context, permissions.reportRead);
    const week = searchParams.get("week") ? dateQuery(searchParams.get("week"), "week") : undefined;
    const projectId = searchParams.get("projectId") ?? undefined;
    if (projectId) await repository.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    return repository.getResourcePlan(context, {week, projectId, skill: String(searchParams.get("skill") ?? "").trim().slice(0, 100) || undefined});
  }
  if (method === "POST" && path === "/resource-planner/profiles") {
    requirePermission(context, permissions.workspaceManage);
    const input = resourceConfigurationInput(body, "profile");
    if (!(await repository.listMemberships(context)).some((member) => member.userId === input.item.userId)) throw new NotFoundError("Member not found");
    return saveResourceConfiguration(context, repository, "profiles", input.item, input.version);
  }
  if (method === "POST" && path === "/resource-planner/allocations") {
    requirePermission(context, permissions.projectManage);
    const input = resourceConfigurationInput(body, "allocation");
    await repository.getProject(input.item.projectId, context.workspaceId, context.membership?.projectIds);
    if (!(await repository.listMemberships(context)).some((member) => member.userId === input.item.userId)) throw new NotFoundError("Member not found");
    return saveResourceConfiguration(context, repository, "allocations", input.item, input.version);
  }
  if (method === "POST" && path === "/resource-planner/time-off") {
    requirePermission(context, permissions.workspaceManage);
    const input = resourceConfigurationInput(body, "time-off");
    if (!(await repository.listMemberships(context)).some((member) => member.userId === input.item.userId)) throw new NotFoundError("Member not found");
    return saveResourceConfiguration(context, repository, "timeOff", input.item, input.version);
  }
  const resourceAllocationMatch = path.match(/^\/resource-planner\/(allocations|time-off)\/([^/]+)$/);
  if (resourceAllocationMatch && method === "DELETE") {
    requirePermission(context, resourceAllocationMatch[1] === "allocations" ? permissions.projectManage : permissions.workspaceManage);
    return deleteResourceConfiguration(context, repository, resourceAllocationMatch[1] === "allocations" ? "allocations" : "timeOff", decodeURIComponent(resourceAllocationMatch[2]), parseVersionInput(body).version);
  }
  if (method === "GET" && path === "/security/badge") {
    requirePermission(context, permissions.workspaceRead);
    return repository.getSecurityBadge(context);
  }

  if (method === "GET" && path === "/application-data/summary") {
    requirePermission(context, permissions.workspaceRead);
    return repository.getApplicationDataSummary(context);
  }

  if (method === "POST" && path === "/attachments/upload-intent") {
    requirePermission(context, permissions.attachmentManage);
    return {statusCode: 201, body: await repository.createUploadIntent(context, parseDocumentUploadIntentInput(body))};
  }
  if (method === "POST" && path === "/attachments/finalize") {
    requirePermission(context, permissions.attachmentManage);
    return {statusCode: 201, body: await repository.finalizeDocument(context, parseDocumentFinalizeInput(body))};
  }

  const attachmentDownloadMatch = path.match(/^\/attachments\/([^/]+)\/download$/);
  if (attachmentDownloadMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    const projectId = searchParams.get("projectId");
    if (!projectId) throw new ValidationError("projectId is required");
    return repository.createDocumentDownloadIntent(context, projectId, attachmentDownloadMatch[1]);
  }

  throw new NotFoundError("Route not found");
}
