// @ts-nocheck

import {createHash} from "node:crypto";
import {DynamoDBClient} from "@aws-sdk/client-dynamodb";
import {GetObjectCommand, HeadObjectCommand, PutObjectCommand, PutObjectTaggingCommand, S3Client} from "@aws-sdk/client-s3";
import {BatchGetCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand} from "@aws-sdk/lib-dynamodb";
import {getSignedUrl} from "@aws-sdk/s3-request-presigner";
import {buildPlanningSummary, buildPortfolioSummary, newId, reverseTimestamp} from "@teamspaces/domain";
import {
  assertMeetingPayloadSize,
  assertMeetingUpdate,
  assertWorkConfigurationUpdate,
  assertWorkItemConfiguration,
  assertWorkQueryConfiguration,
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
  dynamoWorkCursorKey,
  encodeWorkCursor,
  matchesWorkQuery,
  selectWorkQuerySource,
  workPageInfo
} from "./work-query.js";
import {
  decodeMeetingCursor,
  dynamoMeetingCursorKey,
  encodeMeetingCursor,
  meetingPageInfo
} from "./meeting-query.js";
import {
  meetingCreateRequestHash,
  meetingIdempotencyClaim,
  meetingIdempotencyClaimKey
} from "./meeting-integrity.js";
import {calculateProjectSchedule, compareProjectBaseline, compareProjectHistory, workBaselineSnapshot} from "./scheduling.js";
import {automaticWorkSubject, buildCostReport, buildResourcePlan, configuredCustomAction, securityBadge, validateAndCalculateCustomFields, validateCapabilityCustomFieldValues} from "./capability-engine.js";
import {publicDocument} from "./document-security.js";
import {meetingICalendar, meetingPdfBase64} from "./meeting-exports.js";
import {effectiveNotificationPreferences, notificationScheduleHour, workNotificationRecipients} from "./notifications.js";
import {mergeContentOperations} from "./content-collaboration.js";
import {createProviderIntegrationRuntime} from "../integrations/provider-adapters.js";
import {assertCoordinationProjectUpdate, assertCoordinationReferences, assertCoordinationUpdate, coordinationDigest, coordinationProjectId, coordinationTaskId, replayCoordinationCreate, resetCopiedCoordination} from "./coordination-integrity.js";
import {prepareCoordinationRegistration} from "./coordination-registration.js";
import {assertPublicCoordinationRegistration, assertRegisteredCommunityProject, publicCoordinationRegistrationKey, publicCoordinationTaskLimit, publicDirectoryInitiativeLimit} from "../public-coordination.js";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({requestChecksumCalculation: "WHEN_REQUIRED"});
const maxWorkQueryIterations = 25;

function normalizedContentType(value) {
  return String(value ?? "").trim().toLowerCase();
}

function downloadContentDisposition(filename) {
  const ascii = String(filename ?? "download")
    .replace(/[\r\n"\\]/g, "_")
    .replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(String(filename ?? "download"))
    .replaceAll("'", "%27")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("*", "%2A");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function assertUploadedDocument(document, head) {
  const matches = Number(head.ContentLength) === Number(document.sizeBytes)
    && normalizedContentType(head.ContentType) === normalizedContentType(document.contentType)
    && head.ServerSideEncryption === "AES256"
    && head.Metadata?.documentid === document.id
    && head.ChecksumSHA256 === document.checksumSha256;
  if (!matches) throw new ValidationError("Uploaded object does not match the upload intent");
}

export function createDocumentPutRequest({bucketName, objectKey, documentId, input}) {
  return {
    command: new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      ContentLength: input.sizeBytes,
      ContentType: input.contentType,
      ChecksumSHA256: input.checksumSha256,
      IfNoneMatch: "*",
      Metadata: {documentid: documentId},
      ServerSideEncryption: "AES256",
      Tagging: "state=pending"
    }),
    uploadHeaders: {
      "content-type": input.contentType,
      "if-none-match": "*",
      "x-amz-server-side-encryption": "AES256"
    }
  };
}

function itemWithoutKeys(item) {
  const copy = {...item};
  delete copy.PK;
  delete copy.SK;
  delete copy.GSI1PK;
  delete copy.GSI1SK;
  delete copy.GSI2PK;
  delete copy.GSI2SK;
  return copy;
}

function includesFolded(value, needle) {
  return String(value ?? "").toLowerCase().includes(String(needle ?? "").toLowerCase());
}

function sortWorkItems(a, b) {
  return Number(a.rank ?? 0) - Number(b.rank ?? 0) || String(a.dueDate ?? "9999-12-31").localeCompare(String(b.dueDate ?? "9999-12-31"));
}

function userIdFromEmail(email) {
  return `user-${String(email).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
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

function definedValues(input) {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
}

function withoutUndefined(value) {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, withoutUndefined(item)]));
  }
  return value;
}

/**
 * DynamoDB reports transaction capacity, throttling, validation, and
 * conditional failures through the same exception class. Only an exclusively
 * conditional cancellation at one of the caller-designated items represents
 * an optimistic/idempotency conflict.
 * @param {any} error
 * @param {number[]} conditionalItemIndexes
 */
export function isConditionalTransactionCancellation(error, conditionalItemIndexes) {
  if (error?.name !== "TransactionCanceledException") return false;
  const reasons = error.CancellationReasons ?? error.cancellationReasons;
  if (!Array.isArray(reasons) || !reasons.length) return false;
  const codes = reasons.map((reason) => reason?.Code ?? reason?.code ?? "None");
  const failures = codes.filter((code) => code !== "None");
  return failures.length > 0
    && failures.every((code) => code === "ConditionalCheckFailed")
    && conditionalItemIndexes.some((index) => codes[index] === "ConditionalCheckFailed");
}

function accountIndexItem(membership) {
  return {
    PK: `USER#${membership.userId}`,
    SK: `ACCOUNT#${membership.workspaceId}`,
    workspaceId: membership.workspaceId,
    userId: membership.userId,
    email: membership.email,
    name: membership.name,
    role: membership.role,
    status: membership.status,
    defaultAccount: membership.defaultAccount,
    projectIds: membership.projectIds ?? [],
    updatedAt: membership.updatedAt,
    createdAt: membership.createdAt
  };
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

function personalWorkspaceId(userId) {
  return `workspace-personal-${String(userId).replace(/^user-/, "").replace(/[^a-z0-9-]+/g, "-")}`;
}

/**
 * The work configuration is a singleton in each workspace partition. Keeping
 * the key stable lets old work rows continue to use their existing project
 * keys while the workspace taxonomy changes independently.
 * @param {string} workspaceId
 */
export function workConfigurationKey(workspaceId) {
  return {PK: `WORKSPACE#${workspaceId}`, SK: "WORK_CONFIGURATION"};
}

/** @param {string} workspaceId */
export function workspaceCapabilitiesKey(workspaceId) {
  return {PK: `WORKSPACE#${workspaceId}`, SK: "CAPABILITIES"};
}

/**
 * Build the persisted work configuration without allowing request metadata to
 * replace the table key or server-managed version/timestamps.
 * @param {string} workspaceId
 * @param {Record<string, any>} configuration
 * @param {{version: number, now: string, actorId: string, createdAt?: string}} metadata
 */
export function workConfigurationItem(workspaceId, configuration, metadata) {
  const {
    PK: _pk,
    SK: _sk,
    workspaceId: _workspaceId,
    version: _version,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    updatedBy: _updatedBy,
    ...values
  } = configuration;
  return {
    ...workConfigurationKey(workspaceId),
    ...values,
    workspaceId,
    version: metadata.version,
    createdAt: metadata.createdAt ?? metadata.now,
    updatedAt: metadata.now,
    updatedBy: metadata.actorId
  };
}

/** @param {string} workspaceId */
export function defaultWorkConfigurationItem(workspaceId) {
  return {
    ...structuredClone(defaultWorkConfiguration),
    workspaceId
  };
}

/** @param {string} projectId @param {string} meetingId */
export function meetingKey(projectId, meetingId) {
  return {PK: `PROJECT#${projectId}`, SK: `MEETING#${meetingId}`};
}

/**
 * The existing GSI1 supplies chronological meeting pages while the canonical
 * project-partition row remains directly addressable by project and ID.
 * @param {{projectId: string, startsAt: string, id: string}} meeting
 */
export function meetingIndexAttrs(meeting) {
  return {
    GSI1PK: `PROJECT#${meeting.projectId}#MEETINGS`,
    GSI1SK: `START#${meeting.startsAt}#MEETING#${meeting.id}`,
    ...(meeting.workspaceId ? {
      GSI2PK: `WORKSPACE#${meeting.workspaceId}#MEETINGS`,
      GSI2SK: `START#${meeting.startsAt}#PROJECT#${meeting.projectId}#MEETING#${meeting.id}`
    } : {})
  };
}

/** @param {string} projectId @param {string} kind @param {string} contentId */
export function projectContentKey(projectId, kind, contentId) {
  return {PK: `PROJECT#${projectId}`, SK: `CONTENT#${contentId}`};
}

/** @param {{workspaceId: string, updatedAt: string, id: string}} content */
function projectContentIndexAttrs(content) {
  return {
    GSI1PK: `WORKSPACE#${content.workspaceId}#CONTENT`,
    GSI1SK: `UPDATED#${reverseTimestamp(content.updatedAt)}#${content.id}`
  };
}

/** @param {Record<string, any>} content @param {string} actorId @param {Record<string, any>} collaboration */
function projectContentRevisionItem(content, actorId, collaboration = {}) {
  return withoutUndefined({
    PK: `CONTENT#${content.id}`,
    SK: `REVISION#${String(content.version).padStart(10, "0")}`,
    contentId: content.id,
    projectId: content.projectId,
    version: content.version,
    title: content.title,
    body: content.body,
    format: content.format,
    status: content.status,
    parentId: content.parentId,
    tags: content.tags ?? [],
    actorId,
    createdAt: content.updatedAt,
    ...collaboration
  });
}

/** @param {string} projectId @param {string} resourceId */
function planningResourceKey(projectId, resourceId) {
  return {PK: `PROJECT#${projectId}`, SK: `PLANNING#${resourceId}`};
}

/** @param {{workspaceId: string, kind: string, startDate?: string, id: string}} resource */
function planningResourceIndexAttrs(resource) {
  return {
    GSI1PK: `WORKSPACE#${resource.workspaceId}#PLANNING#${resource.kind}`,
    GSI1SK: `START#${resource.startDate ?? "9999-12-31"}#${resource.id}`
  };
}

/**
 * @param {{workspaceId: string, actorId: string, correlationId: string}} context
 * @param {{projectId?: string, entityType: string, entityId: string, eventType: string, fields: string[], summary: string, timestamp: string, id: string}} values
 */
export function activityItem(context, values) {
  const reversed = reverseTimestamp(values.timestamp);
  return {
    PK: values.projectId ? `PROJECT#${values.projectId}` : `WORKSPACE#${context.workspaceId}`,
    SK: `ACTIVITY#${reversed}#${values.id}`,
    GSI1PK: `WORKSPACE#${context.workspaceId}#ACTIVITY`,
    GSI1SK: `TIME#${reversed}#${values.id}`,
    id: values.id,
    workspaceId: context.workspaceId,
    projectId: values.projectId,
    actorId: context.actorId,
    timestamp: values.timestamp,
    reverseTimestamp: reversed,
    entityType: values.entityType,
    entityId: values.entityId,
    eventType: values.eventType,
    changedFields: values.fields,
    summary: values.summary,
    correlationId: context.correlationId,
    ...withoutUndefined(values.details ?? {})
  };
}

export function notificationReadKey(workspaceId, userId, activityId) {
  return {PK: `WORKSPACE#${workspaceId}#USER#${userId}`, SK: `NOTIFICATION_READ#${activityId}`};
}

export function notificationPreferencesKey(workspaceId, userId) {
  return {PK: `WORKSPACE#${workspaceId}#USER#${userId}`, SK: "NOTIFICATION_PREFERENCES"};
}

export function notificationDigestClaimKey(workspaceId, userId, periodKey) {
  return {PK: `WORKSPACE#${workspaceId}#USER#${userId}`, SK: `NOTIFICATION_DIGEST#${periodKey}`};
}

export class DynamoRepository {
  constructor({tableName, attachmentBucketName, workspaceId = "workspace-default", workIndexReady = true, documentClient = dynamo, integrationRuntime = createProviderIntegrationRuntime()}) {
    this.tableName = tableName;
    this.attachmentBucketName = attachmentBucketName;
    this.workspaceId = workspaceId;
    this.workIndexReady = workIndexReady;
    this.workIndexMarkerReady = undefined;
    this.documentClient = documentClient;
    this.integrationRuntime = integrationRuntime;
  }

  now() {
    return new Date().toISOString();
  }

  async getPublicCoordinationRegistration(initiativeId) {
    const result = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: publicCoordinationRegistrationKey(initiativeId), ConsistentRead: true}));
    return result.Item ? itemWithoutKeys(result.Item) : undefined;
  }

  async listPublicCoordinationInitiatives() {
    const page = await this.documentClient.send(new QueryCommand({TableName: this.tableName, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :directory", ExpressionAttributeValues: {":directory": "PUBLIC_COORDINATION"}, ProjectionExpression: "initiativeId", Limit: publicDirectoryInitiativeLimit + 1}));
    return {initiativeIds: (page.Items ?? []).slice(0, publicDirectoryInitiativeLimit).map(item => item.initiativeId), truncated: Boolean(page.LastEvaluatedKey) || (page.Items?.length ?? 0) > publicDirectoryInitiativeLimit};
  }

  async readPublicCoordinationProjects(registration) {
    assertPublicCoordinationRegistration(registration);
    return Promise.all(registration.projectIds.map(async id => {
      const result = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: {PK: `PROJECT#${id}`, SK: "META"}, ConsistentRead: true}));
      return itemWithoutKeys(assertRegisteredCommunityProject(result.Item, registration));
    }));
  }

  async setPublicCoordinationRegistration(context, input) {
    const next = await prepareCoordinationRegistration(this, context, input);
    try {
      await this.documentClient.send(new PutCommand({TableName: this.tableName, Item: {...publicCoordinationRegistrationKey(input.initiativeId), ...next, ...(next.enabled ? {GSI1PK: "PUBLIC_COORDINATION", GSI1SK: next.initiativeId} : {})},
        ConditionExpression: input.version === 0 ? "attribute_not_exists(PK)" : "#version = :version AND #workspace = :workspace",
        ...(input.version === 0 ? {} : {ExpressionAttributeNames: {"#version": "version", "#workspace": "workspaceId"}, ExpressionAttributeValues: {":version": input.version, ":workspace": context.workspaceId}})}));
    } catch (error) { if (error?.name === "ConditionalCheckFailedException") throw new ConflictError(); throw error; }
    return next;
  }

  async readPublicCoordinationState(registration) {
    assertPublicCoordinationRegistration(registration);
    const projects = [];
    const tasks = [];
    for (const projectId of registration.projectIds) {
      const projectKey = {PK: `PROJECT#${projectId}`, SK: "META"};
      const current = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: projectKey, ConsistentRead: true}));
      assertRegisteredCommunityProject(current.Item, registration);
      let cursor;
      let pages = 0;
      do {
        if (++pages > 10) throw new ValidationError("Public tracker exceeds its read limit");
        const page = await this.documentClient.send(new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "PK = :project AND begins_with(SK, :work)",
          ExpressionAttributeValues: {":project": projectKey.PK, ":work": "WORK#"},
          ConsistentRead: true,
          Limit: Math.min(100, publicCoordinationTaskLimit + 1 - tasks.length),
          ExclusiveStartKey: cursor
        }));
        for (const task of page.Items ?? []) {
          if (task.workspaceId !== registration.workspaceId || task.projectId !== projectId) throw new NotFoundError("Public initiative not found");
          if (!task.deletedAt) tasks.push(itemWithoutKeys(task));
          if (tasks.length > publicCoordinationTaskLimit) throw new ValidationError("Public tracker exceeds its task limit");
        }
        cursor = page.LastEvaluatedKey;
      } while (cursor);
      const latest = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: projectKey, ConsistentRead: true}));
      projects.push(itemWithoutKeys(assertRegisteredCommunityProject(latest.Item, registration)));
    }
    return {projects, tasks, workConfiguration: await this.getWorkConfiguration({workspaceId: registration.workspaceId})};
  }

  async getOrBootstrap(user, requestedWorkspaceId = "") {
    let workspaceId = requestedWorkspaceId;
    if (workspaceId) {
      const member = await dynamo.send(new GetCommand({TableName: this.tableName, Key: {PK: `WORKSPACE#${workspaceId}`, SK: `MEMBER#${user.id}`}}));
      if (!isActiveMembership(member.Item)) throw new ForbiddenError("You are not an active member of this account");
    } else {
      const accounts = await this.listAccounts(user.id);
      const selected = accounts.find((account) => account.defaultAccount) ?? accounts[0];
      workspaceId = selected?.workspaceId ?? personalWorkspaceId(user.id);
    }
    const workspaceKey = {PK: `WORKSPACE#${workspaceId}`, SK: "META"};
    const memberKey = {PK: `WORKSPACE#${workspaceId}`, SK: `MEMBER#${user.id}`};
    const member = await dynamo.send(new GetCommand({TableName: this.tableName, Key: memberKey}));
    if (member.Item && isActiveMembership(member.Item)) {
      const workspace = await dynamo.send(new GetCommand({TableName: this.tableName, Key: workspaceKey}));
      if (!workspace.Item) throw new NotFoundError("Workspace not found");
      return {workspace: itemWithoutKeys(workspace.Item), user, membership: itemWithoutKeys(member.Item)};
    }
    if (member.Item || requestedWorkspaceId) throw new ForbiddenError("You are not an active member of this account");
    const now = this.now();
    const isDefaultWorkspace = workspaceId === this.workspaceId;
    const bootstrapAdmin = !process.env.BOOTSTRAP_ADMIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL === user.email;
    if (!isDefaultWorkspace) workspaceId = personalWorkspaceId(user.id);
    const workspace = {
      PK: `WORKSPACE#${workspaceId}`,
      SK: "META",
      id: workspaceId,
      name: isDefaultWorkspace ? process.env.WORKSPACE_NAME ?? "Team Spaces Pilot" : `${user.name ?? user.email}'s workspace`,
      accountType: isDefaultWorkspace ? "team" : "personal",
      createdBy: user.id,
      createdAt: now,
      updatedAt: now
    };
    const membership = {
      PK: `WORKSPACE#${workspaceId}`,
      SK: `MEMBER#${user.id}`,
      workspaceId,
      userId: user.id,
      role: bootstrapAdmin ? roles.admin : roles.viewer,
      email: user.email,
      name: user.name ?? user.email,
      status: "active",
      defaultAccount: !isDefaultWorkspace,
      createdAt: now,
      updatedAt: now
    };
    await dynamo.send(new TransactWriteCommand({
      TransactItems: [
        {Put: {TableName: this.tableName, Item: workspace, ConditionExpression: "attribute_not_exists(PK)"}},
        {Put: {TableName: this.tableName, Item: membership, ConditionExpression: "attribute_not_exists(PK)"}},
        {Put: {TableName: this.tableName, Item: accountIndexItem(membership)}}
      ]
    })).catch(async (error) => {
      if (error.name !== "TransactionCanceledException") throw error;
      await dynamo.send(new PutCommand({TableName: this.tableName, Item: membership, ConditionExpression: "attribute_not_exists(PK)"}));
      await dynamo.send(new PutCommand({TableName: this.tableName, Item: accountIndexItem(membership)}));
    });
    return {workspace: itemWithoutKeys(workspace), user, membership: itemWithoutKeys(membership)};
  }

  async listAccounts(userId) {
    const indexed = await this.queryByPk(`USER#${userId}`, "ACCOUNT#");
    let memberships = indexed.filter(isActiveMembership);
    if (!memberships.length) {
      const result = await dynamo.send(new ScanCommand({
      TableName: this.tableName,
      FilterExpression: "begins_with(PK, :workspace) AND SK = :member",
      ExpressionAttributeValues: {":workspace": "WORKSPACE#", ":member": `MEMBER#${userId}`}
      }));
      memberships = (result.Items ?? []).map(itemWithoutKeys).filter(isActiveMembership);
    }
    const accounts = [];
    for (const membership of memberships) {
      const workspace = await dynamo.send(new GetCommand({TableName: this.tableName, Key: {PK: `WORKSPACE#${membership.workspaceId}`, SK: "META"}}));
      if (workspace.Item) accounts.push({...membership, workspace: itemWithoutKeys(workspace.Item)});
    }
    return accounts.sort((a, b) => Number(Boolean(b.defaultAccount)) - Number(Boolean(a.defaultAccount)) || String(a.workspace?.name).localeCompare(String(b.workspace?.name)));
  }

  async createAccount(context, input) {
    const now = this.now();
    const id = newId();
    const workspace = {
      PK: `WORKSPACE#${id}`,
      SK: "META",
      id,
      name: input.name,
      accountType: input.accountType,
      defaultProjectPrefix: input.defaultProjectPrefix ?? "",
      createdBy: context.actorId,
      version: 1,
      createdAt: now,
      updatedAt: now
    };
    const membership = {
      PK: `WORKSPACE#${id}`,
      SK: `MEMBER#${context.actorId}`,
      workspaceId: id,
      userId: context.actorId,
      email: context.user?.email ?? "",
      name: context.user?.name ?? context.user?.email ?? context.actorId,
      role: roles.admin,
      status: "active",
      defaultAccount: false,
      version: 1,
      createdAt: now,
      updatedAt: now
    };
    await dynamo.send(new TransactWriteCommand({
      TransactItems: [
        {Put: {TableName: this.tableName, Item: workspace, ConditionExpression: "attribute_not_exists(PK)"}},
        {Put: {TableName: this.tableName, Item: membership, ConditionExpression: "attribute_not_exists(PK)"}},
        {Put: {TableName: this.tableName, Item: accountIndexItem(membership)}}
      ]
    }));
    await this.recordActivity({...context, workspaceId: id}, undefined, "workspace", id, "workspace.created", ["name", "accountType"], `Created account ${input.name}`);
    return {...itemWithoutKeys(workspace), membership: itemWithoutKeys(membership)};
  }

  async recordActivity(context, projectId, entityType, entityId, eventType, fields, summary, details = {}) {
    const timestamp = this.now();
    const id = newId();
    const item = activityItem(context, {
      projectId,
      entityType,
      entityId,
      eventType,
      fields,
      summary,
      timestamp,
      id,
      details
    });
    await this.documentClient.send(new PutCommand({TableName: this.tableName, Item: item}));
    return itemWithoutKeys(item);
  }

  async queryByPk(pk, skPrefix, limit) {
    const result = await this.documentClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: {":pk": pk, ":sk": skPrefix},
      ...(Number.isInteger(limit) && limit > 0 ? {Limit: limit} : {})
    }));
    return (result.Items ?? []).map(itemWithoutKeys);
  }

  async getWorkspace(context = {}) {
    const workspaceId = context.workspaceId ?? this.workspaceId;
    const result = await dynamo.send(new GetCommand({TableName: this.tableName, Key: {PK: `WORKSPACE#${workspaceId}`, SK: "META"}}));
    if (!result.Item) throw new NotFoundError("Workspace not found");
    return itemWithoutKeys(result.Item);
  }

  async getWorkspaceCapabilities(context = {}) {
    const workspaceId = context.workspaceId ?? this.workspaceId;
    const result = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: workspaceCapabilitiesKey(workspaceId),
      ConsistentRead: true
    }));
    if (!result.Item) return structuredClone({...defaultWorkspaceCapabilities, workspaceId});
    const stored = itemWithoutKeys(result.Item);
    return structuredClone({...defaultWorkspaceCapabilities, ...stored, timeEntryActivities: stored.timeEntryActivities ?? defaultWorkspaceCapabilities.timeEntryActivities});
  }

  async patchWorkspaceCapabilities(context, input) {
    const parsed = validateCapabilityCustomFieldValues(parseWorkspaceCapabilitiesInput(input));
    const key = workspaceCapabilitiesKey(context.workspaceId);
    const result = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: key, ConsistentRead: true}));
    const existing = result.Item;
    const currentVersion = Number(existing?.version ?? defaultWorkspaceCapabilities.version);
    if (Number(parsed.version) !== currentVersion) throw new ConflictError();
    const now = this.now();
    const item = withoutUndefined({
      ...key,
      ...parsed,
      workspaceId: context.workspaceId,
      version: currentVersion + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      updatedBy: context.actorId
    });
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: existing ? "#version = :version" : "attribute_not_exists(PK) AND attribute_not_exists(SK)",
        ...(existing ? {ExpressionAttributeNames: {"#version": "version"}, ExpressionAttributeValues: {":version": currentVersion}} : {})
      }));
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") throw new ConflictError();
      throw error;
    }
    await this.recordActivity(context, undefined, "workspace-capabilities", context.workspaceId, "workspace-capabilities.updated", Object.keys(parsed).filter((name) => !["schemaVersion", "version"].includes(name)), "Updated workspace capabilities");
    return itemWithoutKeys(item);
  }

  async getWorkConfiguration(context = {}) {
    const workspaceId = context.workspaceId ?? this.workspaceId;
    const result = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: workConfigurationKey(workspaceId),
      ConsistentRead: true
    }));
    return result.Item
      ? itemWithoutKeys(result.Item)
      : defaultWorkConfigurationItem(workspaceId);
  }

  async patchWorkConfiguration(context, input) {
    const parsed = parseWorkConfigurationInput(input);
    const key = workConfigurationKey(context.workspaceId);
    const result = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: key,
      ConsistentRead: true
    }));
    const existing = result.Item;
    const currentVersion = Number(existing?.version ?? defaultWorkConfiguration.version);
    if (Number(parsed.version) !== currentVersion) throw new ConflictError();
    assertWorkConfigurationUpdate(
      existing ? itemWithoutKeys(existing) : defaultWorkConfigurationItem(context.workspaceId),
      parsed
    );

    const now = this.now();
    const item = workConfigurationItem(context.workspaceId, parsed, {
      version: currentVersion + 1,
      now,
      actorId: context.actorId,
      createdAt: existing?.createdAt
    });
    const command = {
      TableName: this.tableName,
      Item: item,
      ConditionExpression: existing ? "#version = :expectedVersion" : "attribute_not_exists(PK)",
      ...(existing
        ? {
            ExpressionAttributeNames: {"#version": "version"},
            ExpressionAttributeValues: {":expectedVersion": currentVersion}
          }
        : {})
    };
    try {
      await this.documentClient.send(new PutCommand(command));
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") throw new ConflictError();
      throw error;
    }
    await this.recordActivity(
      context,
      undefined,
      "work-configuration",
      context.workspaceId,
      "work-configuration.updated",
      ["defaultTypeId", "defaultStatusId", "types", "statuses", "transitions"],
      "Updated task types and workflow"
    );
    return itemWithoutKeys(item);
  }

  async patchWorkspace(context, input) {
    const key = {PK: `WORKSPACE#${context.workspaceId}`, SK: "META"};
    const existing = await dynamo.send(new GetCommand({TableName: this.tableName, Key: key}));
    if (!existing.Item) throw new NotFoundError("Workspace not found");
    const item = {
      ...existing.Item,
      ...definedValues(input),
      version: Number(existing.Item.version ?? 1) + 1,
      updatedAt: this.now()
    };
    await dynamo.send(new PutCommand({TableName: this.tableName, Item: item}));
    await this.recordActivity(context, undefined, "workspace", context.workspaceId, "workspace.updated", Object.keys(input), `Updated workspace ${item.name}`);
    return itemWithoutKeys(item);
  }

  async listMemberships(context = {}) {
    const workspaceId = context.workspaceId ?? this.workspaceId;
    return (await this.queryByPk(`WORKSPACE#${workspaceId}`, "MEMBER#"))
      .map((membership) => ({...membership, user: {id: membership.userId, email: membership.email, name: membership.name}}))
      .sort((a, b) => String(a.email).localeCompare(String(b.email)));
  }

  async assertMembershipRole(context, role) {
    if (Object.values(roles).includes(role)) return;
    if (!String(role).startsWith("custom:")) throw new ValidationError("Membership role is not supported");
    const roleId = String(role).slice("custom:".length);
    const capabilities = await this.getWorkspaceCapabilities(context);
    if (!capabilities.customRoles?.some((item) => item.id === roleId)) throw new ValidationError("Custom role is not configured");
  }

  async upsertMembership(context, input) {
    await this.assertMembershipRole(context, input.role);
    const now = this.now();
    const userId = input.userId ?? userIdFromEmail(input.email);
    const key = {PK: `WORKSPACE#${context.workspaceId}`, SK: `MEMBER#${userId}`};
    const existing = await dynamo.send(new GetCommand({TableName: this.tableName, Key: key}));
    const capabilities = await this.getWorkspaceCapabilities(context);
    const customFields = input.customFields === undefined && existing.Item
      ? existing.Item.customFields ?? {}
      : validateAndCalculateCustomFields(capabilities, "user", input.customFields ?? {}, existing.Item?.customFields ?? {});
    const item = {
      ...key,
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
      department: input.department ?? existing.Item?.department,
      directorySource: input.directorySource ?? existing.Item?.directorySource,
      directoryExternalId: input.directoryExternalId ?? existing.Item?.directoryExternalId,
      customFields,
      version: Number(existing.Item?.version ?? 0) + 1,
      createdAt: existing.Item?.createdAt ?? now,
      updatedAt: now
    };
    await dynamo.send(new PutCommand({TableName: this.tableName, Item: item}));
    await dynamo.send(new PutCommand({TableName: this.tableName, Item: accountIndexItem(item)}));
    await this.recordActivity(context, undefined, "membership", userId, "membership.upserted", ["email", "name", "role", "status"], `Saved member ${input.email}`);
    return {...itemWithoutKeys(item), user: {id: userId, email: input.email, name: input.name}};
  }

  async patchMembership(context, userId, patch) {
    const key = {PK: `WORKSPACE#${context.workspaceId}`, SK: `MEMBER#${userId}`};
    const existing = await dynamo.send(new GetCommand({TableName: this.tableName, Key: key}));
    if (!existing.Item) throw new NotFoundError("Membership not found");
    if (patch.role) await this.assertMembershipRole(context, patch.role);
    if (patch.customFields !== undefined) {
      const capabilities = await this.getWorkspaceCapabilities(context);
      patch.customFields = validateAndCalculateCustomFields(capabilities, "user", patch.customFields, existing.Item.customFields ?? {});
    }
    const item = {...existing.Item, ...definedValues(patch), version: Number(existing.Item.version ?? 1) + 1, updatedAt: this.now()};
    await dynamo.send(new PutCommand({TableName: this.tableName, Item: item}));
    await dynamo.send(new PutCommand({TableName: this.tableName, Item: accountIndexItem(item)}));
    await this.recordActivity(context, undefined, "membership", userId, "membership.updated", Object.keys(patch), `Updated member ${item.email}`);
    return {...itemWithoutKeys(item), user: {id: userId, email: item.email, name: item.name}};
  }

  async saveScimGroup(context, input) {
    const capabilitiesKey = workspaceCapabilitiesKey(context.workspaceId);
    const [capabilitiesResult, memberships] = await Promise.all([
      this.documentClient.send(new GetCommand({TableName: this.tableName, Key: capabilitiesKey, ConsistentRead: true})),
      this.listMemberships(context)
    ]);
    const existingCapabilities = capabilitiesResult.Item;
    const capabilities = existingCapabilities ? itemWithoutKeys(existingCapabilities) : structuredClone({...defaultWorkspaceCapabilities, workspaceId: context.workspaceId});
    const knownUserIds = new Set(memberships.map((member) => member.userId));
    if (input.memberIds.some((userId) => !knownUserIds.has(userId))) throw new ValidationError("Every SCIM group member must be a workspace user");
    const now = this.now();
    const existingGroup = capabilities.groups?.find((group) => group.id === input.id);
    const group = withoutUndefined({
      ...existingGroup,
      id: input.id,
      name: input.name,
      scimExternalId: input.externalId,
      customFields: input.customFields ?? existingGroup?.customFields ?? {},
      managedBy: "scim",
      createdAt: existingGroup?.createdAt ?? now,
      updatedAt: now
    });
    const parsed = validateCapabilityCustomFieldValues(parseWorkspaceCapabilitiesInput({...capabilities, groups: [...(capabilities.groups ?? []).filter((item) => item.id !== input.id), group], version: capabilities.version}));
    const capabilityItem = withoutUndefined({
      ...capabilitiesKey,
      ...parsed,
      workspaceId: context.workspaceId,
      version: Number(capabilities.version) + 1,
      createdAt: existingCapabilities?.createdAt ?? now,
      updatedAt: now,
      updatedBy: context.actorId
    });
    const desired = new Set(input.memberIds);
    const changedMemberships = memberships.flatMap((membership) => {
      const groupIds = new Set(membership.groupIds ?? []);
      if (desired.has(membership.userId)) groupIds.add(input.id);
      else groupIds.delete(input.id);
      const next = [...groupIds];
      if (JSON.stringify(next) === JSON.stringify(membership.groupIds ?? [])) return [];
      return [{...membership, PK: `WORKSPACE#${context.workspaceId}`, SK: `MEMBER#${membership.userId}`, groupIds: next, version: Number(membership.version ?? 1) + 1, updatedAt: now, user: undefined}];
    });
    if (changedMemberships.length > 90) throw new ValidationError("A SCIM group mutation may affect at most 90 workspace users");
    const capabilityCondition = existingCapabilities ? {
      ConditionExpression: "#version = :version",
      ExpressionAttributeNames: {"#version": "version"},
      ExpressionAttributeValues: {":version": capabilities.version}
    } : {ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"};
    try {
      await this.documentClient.send(new TransactWriteCommand({TransactItems: [
        {Put: {TableName: this.tableName, Item: capabilityItem, ...capabilityCondition}},
        ...changedMemberships.map((membership) => ({Put: {
          TableName: this.tableName,
          Item: withoutUndefined(membership),
          ConditionExpression: "attribute_exists(PK)"
        }}))
      ]}));
    } catch (error) {
      if (error?.name === "TransactionCanceledException") throw new ConflictError();
      throw error;
    }
    await this.recordActivity(context, undefined, "scim-group", input.id, existingGroup ? "scim-group.updated" : "scim-group.created", ["name", "members"], `${existingGroup ? "Updated" : "Created"} SCIM group ${input.name}`);
    const changedById = new Map(changedMemberships.map((membership) => [membership.userId, itemWithoutKeys(membership)]));
    return {group, memberships: memberships.map((membership) => changedById.get(membership.userId) ?? membership)};
  }

  async deleteScimGroup(context, groupId) {
    const capabilitiesKey = workspaceCapabilitiesKey(context.workspaceId);
    const [capabilitiesResult, memberships] = await Promise.all([
      this.documentClient.send(new GetCommand({TableName: this.tableName, Key: capabilitiesKey, ConsistentRead: true})),
      this.listMemberships(context)
    ]);
    if (!capabilitiesResult.Item) throw new NotFoundError("SCIM group not found");
    const capabilities = itemWithoutKeys(capabilitiesResult.Item);
    const group = capabilities.groups?.find((item) => item.id === groupId);
    if (!group) throw new NotFoundError("SCIM group not found");
    const now = this.now();
    const parsed = validateCapabilityCustomFieldValues(parseWorkspaceCapabilitiesInput({...capabilities, groups: capabilities.groups.filter((item) => item.id !== groupId), version: capabilities.version}));
    const capabilityItem = withoutUndefined({...capabilitiesKey, ...parsed, workspaceId: context.workspaceId, version: Number(capabilities.version) + 1, createdAt: capabilities.createdAt ?? now, updatedAt: now, updatedBy: context.actorId});
    const changedMemberships = memberships.filter((membership) => membership.groupIds?.includes(groupId)).map((membership) => ({...membership, PK: `WORKSPACE#${context.workspaceId}`, SK: `MEMBER#${membership.userId}`, groupIds: membership.groupIds.filter((id) => id !== groupId), version: Number(membership.version ?? 1) + 1, updatedAt: now, user: undefined}));
    if (changedMemberships.length > 90) throw new ValidationError("A SCIM group mutation may affect at most 90 workspace users");
    try {
      await this.documentClient.send(new TransactWriteCommand({TransactItems: [
        {Put: {TableName: this.tableName, Item: capabilityItem, ConditionExpression: "#version = :version", ExpressionAttributeNames: {"#version": "version"}, ExpressionAttributeValues: {":version": capabilities.version}}},
        ...changedMemberships.map((membership) => ({Put: {TableName: this.tableName, Item: withoutUndefined(membership), ConditionExpression: "attribute_exists(PK)"}}))
      ]}));
    } catch (error) {
      if (error?.name === "TransactionCanceledException") throw new ConflictError();
      throw error;
    }
    await this.recordActivity(context, undefined, "scim-group", groupId, "scim-group.deleted", ["id", "members"], `Deleted SCIM group ${group.name ?? groupId}`);
    return {id: groupId, deleted: true};
  }

  async listPlaceholders(context) {
    return (await this.listMemberships(context)).filter((membership) => membership.placeholder);
  }

  async createPlaceholder(context, input) {
    const userId = `placeholder-${newId()}`;
    const placeholder = await this.upsertMembership(context, {...input, userId, email: `${userId}@placeholder.invalid`, role: roles.viewer, placeholder: true});
    await this.recordActivity(context, undefined, "placeholder", userId, "placeholder.created", ["name", "weeklyMinutes", "skills"], `Created placeholder ${input.name}`);
    return placeholder;
  }

  async updateCurrentUserProfile(context, input) {
    const key = {PK: `WORKSPACE#${context.workspaceId}`, SK: `MEMBER#${context.actorId}`};
    const existing = await dynamo.send(new GetCommand({TableName: this.tableName, Key: key}));
    if (!existing.Item) throw new NotFoundError("Membership not found");
    if (input.customFields !== undefined) {
      const capabilities = await this.getWorkspaceCapabilities(context);
      input.customFields = validateAndCalculateCustomFields(capabilities, "user", input.customFields, existing.Item.customFields ?? {});
    }
    const item = {
      ...existing.Item,
      ...definedValues(input),
      name: input.name ?? existing.Item.name,
      version: Number(existing.Item.version ?? 1) + 1,
      updatedAt: this.now()
    };
    await dynamo.send(new PutCommand({TableName: this.tableName, Item: item}));
    await this.recordActivity(context, undefined, "user", context.actorId, "user.profile.updated", Object.keys(input), `Updated profile ${item.name ?? item.email}`);
    return {
      user: {
        id: context.actorId,
        email: item.email,
        name: item.name,
        title: item.title,
        department: item.department,
        timezone: item.timezone,
        locale: item.locale
      },
      membership: itemWithoutKeys(item)
    };
  }

  async listPortfolios(context = {}) {
    const workspaceId = context.workspaceId ?? this.workspaceId;
    return this.queryByPk(`WORKSPACE#${workspaceId}`, "PORTFOLIO#", context.publicDemo?.pageLimit);
  }

  async createPortfolio(context, input) {
    const now = this.now();
    const id = newId();
    const item = {
      PK: `WORKSPACE#${context.workspaceId}`,
      SK: `PORTFOLIO#${id}`,
      id,
      workspaceId: context.workspaceId,
      name: input.name,
      description: input.description ?? "",
      archived: false,
      version: 1,
      createdAt: now,
      updatedAt: now
    };
    await dynamo.send(new PutCommand({TableName: this.tableName, Item: item, ConditionExpression: "attribute_not_exists(PK)"}));
    await this.recordActivity(context, undefined, "portfolio", id, "portfolio.created", ["name"], `Created portfolio ${input.name}`);
    return itemWithoutKeys(item);
  }

  async patchPortfolio(context, portfolioId, patch) {
    const key = {PK: `WORKSPACE#${context.workspaceId}`, SK: `PORTFOLIO#${portfolioId}`};
    const existing = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: key}));
    if (!existing.Item || existing.Item.workspaceId !== context.workspaceId || existing.Item.id !== portfolioId) {
      throw new NotFoundError("Portfolio not found");
    }
    const expectedVersion = Number(patch.version ?? existing.Item.version);
    if (expectedVersion !== Number(existing.Item.version)) throw new ConflictError();
    const item = {
      PK: key.PK,
      SK: key.SK,
      id: existing.Item.id,
      workspaceId: context.workspaceId,
      name: patch.name ?? existing.Item.name,
      description: patch.description ?? existing.Item.description ?? "",
      archived: patch.archived ?? Boolean(existing.Item.archived),
      version: Number(existing.Item.version) + 1,
      createdAt: existing.Item.createdAt,
      updatedAt: this.now()
    };
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: "#version = :expectedVersion",
        ExpressionAttributeNames: {"#version": "version"},
        ExpressionAttributeValues: {":expectedVersion": expectedVersion}
      }));
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") throw new ConflictError();
      throw error;
    }
    await this.recordActivity(context, undefined, "portfolio", portfolioId, "portfolio.updated", Object.keys(patch), `Updated portfolio ${existing.Item.name}`);
    return itemWithoutKeys(item);
  }

  async listProjects(filters = {}) {
    const workspaceId = filters.workspaceId ?? this.workspaceId;
    const gsiPk = filters.portfolioId
      ? `WORKSPACE#${workspaceId}#PORTFOLIO#${filters.portfolioId}#PROJECTS`
      : `WORKSPACE#${workspaceId}#PROJECTS`;
    const result = await this.documentClient.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: {":pk": gsiPk},
      ScanIndexForward: false,
      Limit: filters.limit ?? 100
    }));
    let projects = (result.Items ?? []).map(itemWithoutKeys).filter((project) => !project.deletedAt);
    if (Array.isArray(filters.allowedProjectIds) && filters.allowedProjectIds.length) projects = projects.filter((project) => filters.allowedProjectIds.includes(project.id));
    for (const field of ["status", "health", "ownerId", "priority", "phase"]) {
      if (filters[field]) projects = projects.filter((project) => project[field] === filters[field]);
    }
    if (filters.archived === "true" || filters.archived === true) projects = projects.filter((project) => project.archived);
    if (filters.archived === "false" || filters.archived === false) projects = projects.filter((project) => !project.archived);
    if (filters.template === "true" || filters.template === true) projects = projects.filter((project) => project.template);
    if (filters.template === "false" || filters.template === false) projects = projects.filter((project) => !project.template);
    if (filters.favorite === "true" || filters.favorite === true) projects = projects.filter((project) => project.favorite);
    if (filters.search) {
      const needle = String(filters.search).toLowerCase();
      projects = projects.filter((project) => `${project.name} ${project.description ?? ""}`.toLowerCase().includes(needle));
    }
    return projects;
  }

  async getProject(id, workspaceId = "", allowedProjectIds = []) {
    const result = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: {PK: `PROJECT#${id}`, SK: "META"}}));
    if (!result.Item || result.Item.deletedAt) throw new NotFoundError("Project not found");
    if (workspaceId && result.Item.workspaceId !== workspaceId) throw new NotFoundError("Project not found");
    if (!hasProjectAccess(id, allowedProjectIds)) throw new NotFoundError("Project not found");
    return itemWithoutKeys(result.Item);
  }

  projectIndexAttrs(project) {
    return {
      GSI1PK: `WORKSPACE#${project.workspaceId}#PROJECTS`,
      GSI1SK: `STATUS#${project.status}#UPDATED#${project.updatedAt}#PROJECT#${project.id}`
    };
  }

  projectPortfolioProjection(project) {
    if (!project.portfolioId) return undefined;
    return {
      ...project,
      PK: `WORKSPACE#${project.workspaceId}`,
      SK: `PROJECT_PORTFOLIO#${project.portfolioId}#PROJECT#${project.id}`,
      GSI1PK: `WORKSPACE#${project.workspaceId}#PORTFOLIO#${project.portfolioId}#PROJECTS`,
      GSI1SK: `STATUS#${project.status}#UPDATED#${project.updatedAt}#PROJECT#${project.id}`
    };
  }

  projectPortfolioProjectionKey(project) {
    if (!project.portfolioId) return undefined;
    return {
      PK: `WORKSPACE#${project.workspaceId}`,
      SK: `PROJECT_PORTFOLIO#${project.portfolioId}#PROJECT#${project.id}`
    };
  }

  workIndexAttrs(workItem) {
    return {
      GSI1PK: `WORKSPACE#${workItem.workspaceId}#WORK`,
      GSI1SK: `UPDATED#${workItem.updatedAt}#PROJECT#${workItem.projectId}#WORK#${workItem.id}`
    };
  }

  async createProject(context, input) {
    const stableId = coordinationProjectId(context.workspaceId, input);
    const id = context.publicDemo?.projectIdPrefix ? `${context.publicDemo.projectIdPrefix}${stableId ?? newId()}` : stableId ?? newId();
    const createDigest = stableId ? coordinationDigest(input) : undefined;
    if (stableId) {
      const existing = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: {PK: `PROJECT#${id}`, SK: "META"}, ConsistentRead: true}));
      if (existing.Item) {
        await this.getProject(id, context.workspaceId, context.membership?.projectIds);
        return itemWithoutKeys(replayCoordinationCreate(existing.Item, createDigest));
      }
    }
    if (input.portfolioId) {
      const portfolio = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: {PK: `WORKSPACE#${context.workspaceId}`, SK: `PORTFOLIO#${input.portfolioId}`}}));
      if (!portfolio.Item) throw new ValidationError("portfolioId does not exist");
    }
    if (input.parentProjectId) await this.getProject(input.parentProjectId, context.workspaceId, context.membership?.projectIds);
    const capabilities = await this.getWorkspaceCapabilities(context);
    const configuredPhases = capabilities.lifecycle?.phases ?? [];
    const requestedPhase = input.phase ?? configuredPhases[0]?.label ?? configuredPhases[0]?.id;
    const phase = configuredPhases.find((item) => item.id === requestedPhase || item.label === requestedPhase);
    if (!phase) throw new ValidationError("Project phase is not configured");
    input.customFields = validateAndCalculateCustomFields(capabilities, "project", input.customFields, {});
    const now = this.now();
    const item = {
      PK: `PROJECT#${id}`,
      SK: "META",
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
    Object.assign(item, this.projectIndexAttrs(item));
    const projection = this.projectPortfolioProjection(item);
    const demoRegistry = context.publicDemo ? {
      PK: `WORKSPACE#${context.workspaceId}`,
      SK: `DEMO_PARTITION#PROJECT#${id}`,
      workspaceId: context.workspaceId,
      projectId: id,
      createdAt: now,
      updatedAt: now
    } : undefined;
    try {
      await this.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        {Put: {TableName: this.tableName, Item: item, ConditionExpression: "attribute_not_exists(PK)"}},
        ...(projection ? [{Put: {TableName: this.tableName, Item: projection, ConditionExpression: "attribute_not_exists(PK)"}}] : []),
        ...(demoRegistry ? [{Put: {TableName: this.tableName, Item: demoRegistry, ConditionExpression: "attribute_not_exists(PK)"}}] : [])
      ]
      }));
    } catch (error) {
      if (stableId && error?.name === "TransactionCanceledException") {
        const existing = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: {PK: `PROJECT#${id}`, SK: "META"}, ConsistentRead: true}));
        if (existing.Item && existing.Item.workspaceId === context.workspaceId) {
          await this.getProject(id, context.workspaceId, context.membership?.projectIds);
          return itemWithoutKeys(replayCoordinationCreate(existing.Item, createDigest));
        }
      }
      throw error;
    }
    await this.recordActivity(context, id, "project", id, "project.created", ["name"], `Created project ${item.name}`);
    return itemWithoutKeys(item);
  }

  async patchProject(context, projectId, patch) {
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const existing = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: {PK: `PROJECT#${projectId}`, SK: "META"}}));
    if (!existing.Item || existing.Item.deletedAt) throw new NotFoundError("Project not found");
    if (existing.Item.workspaceId !== context.workspaceId) throw new NotFoundError("Project not found");
    assertCoordinationProjectUpdate(existing.Item, patch);
    const expectedVersion = Number(patch.version ?? existing.Item.version);
    if (expectedVersion !== Number(existing.Item.version)) throw new ConflictError();
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
    if (patch.phase && patch.phase !== existing.Item.phase) {
      capabilities = await this.getWorkspaceCapabilities(context);
      const phase = (capabilities.lifecycle?.phases ?? []).find((item) => item.id === patch.phase || item.label === patch.phase);
      if (!phase) throw new ValidationError("Project phase is not configured");
      const approvals = new Set((existing.Item.lifecycleGateApprovals ?? []).filter((approval) => approval.status === "approved").map((approval) => approval.gateId));
      const missing = (phase.gates ?? []).map((gate) => typeof gate === "string" ? gate : gate.id).filter((gateId) => !approvals.has(gateId));
      if (missing.length) throw new ConflictError(`Approve lifecycle gates before entering ${phase.label ?? phase.id}: ${missing.join(", ")}`);
    }
    if (patch.customFields !== undefined) {
      capabilities ??= await this.getWorkspaceCapabilities(context);
      patch.customFields = validateAndCalculateCustomFields(capabilities, "project", patch.customFields, existing.Item.customFields ?? {});
    }
    const item = {...existing.Item, ...patch, version: existing.Item.version + 1, updatedAt: this.now()};
    if (item.portfolioId) {
      const portfolio = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: {PK: `WORKSPACE#${context.workspaceId}`, SK: `PORTFOLIO#${item.portfolioId}`}}));
      if (!portfolio.Item) throw new ValidationError("portfolioId does not exist");
    }
    Object.assign(item, this.projectIndexAttrs(item));
    const oldProjectionKey = this.projectPortfolioProjectionKey(existing.Item);
    const projection = this.projectPortfolioProjection(item);
    const projectionMoved = oldProjectionKey && (!projection || oldProjectionKey.SK !== projection.SK);
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: item,
              ConditionExpression: "#version = :expectedVersion",
              ExpressionAttributeNames: {"#version": "version"},
              ExpressionAttributeValues: {":expectedVersion": expectedVersion}
            }
          },
          ...(projectionMoved ? [{Delete: {TableName: this.tableName, Key: oldProjectionKey}}] : []),
          ...(projection ? [{Put: {TableName: this.tableName, Item: projection}}] : [])
        ]
      }));
    } catch (error) {
      if (error?.name === "TransactionCanceledException") throw new ConflictError();
      throw error;
    }
    await this.recordActivity(context, projectId, "project", projectId, "project.updated", Object.keys(patch), `Updated project ${item.name}`);
    return itemWithoutKeys(item);
  }

  async submitProjectInitiation(context, projectId, input) {
    const project = await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    if (Number(input.version) !== Number(project.version)) throw new ConflictError();
    const capabilities = await this.getWorkspaceCapabilities(context);
    const configuration = capabilities.lifecycle?.initiation;
    if (!configuration?.enabled) throw new ForbiddenError("Project initiation is not enabled");
    const missing = (configuration.requestFields ?? []).filter((field) => field.required && (input.requestData?.[field.id] === undefined || input.requestData?.[field.id] === "")).map((field) => field.name ?? field.id);
    if (missing.length) throw new ValidationError(`Required initiation fields are missing: ${missing.join(", ")}`);
    const templateProjectId = input.templateProjectId ?? configuration.templateProjectId;
    let template;
    if (templateProjectId) {
      template = await this.getProject(templateProjectId, context.workspaceId, context.membership?.projectIds);
      if (!template.template) throw new ValidationError("Initiation template must reference a template project");
    }
    const now = this.now();
    const artifact = {id: newId(), projectId, schemaVersion: 1, submittedAt: now, submittedBy: context.actorId, requestData: structuredClone(input.requestData), templateProjectId, decisions: []};
    const updated = await this.patchProject(context, projectId, {
      version: project.version,
      initiationStatus: "submitted",
      initiationRequest: {requestData: structuredClone(input.requestData), note: input.note, submittedAt: now, submittedBy: context.actorId, templateProjectId},
      initiationApprovals: [],
      initiationAuditArtifact: artifact,
      ...(template ? {modules: template.modules ?? project.modules, tags: [...new Set([...(template.tags ?? []), ...(project.tags ?? [])])], templateSourceProjectId: template.id} : {})
    });
    await this.recordActivity(context, projectId, "project-initiation", artifact.id, "project-initiation.submitted", ["requestData", "templateProjectId"], `Submitted initiation request for ${project.name}`);
    return updated;
  }

  async reviewProjectInitiation(context, projectId, input) {
    const project = await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    if (Number(input.version) !== Number(project.version)) throw new ConflictError();
    if (project.initiationStatus !== "submitted" && project.initiationStatus !== "changes-requested") throw new ConflictError("Only a submitted initiation request can be reviewed");
    const capabilities = await this.getWorkspaceCapabilities(context);
    const reviewers = capabilities.lifecycle?.initiation?.reviewerIds ?? [];
    if (reviewers.length && !reviewers.includes(context.actorId)) throw new ForbiddenError("You are not an initiation reviewer");
    const now = this.now();
    const decision = {id: newId(), decision: input.decision, comment: input.comment, reviewerId: context.actorId, reviewedAt: now};
    const updated = await this.patchProject(context, projectId, {
      version: project.version,
      initiationStatus: input.decision,
      initiationApprovals: [...(project.initiationApprovals ?? []), decision],
      initiationAuditArtifact: {...project.initiationAuditArtifact, decisions: [...(project.initiationAuditArtifact?.decisions ?? []), decision], finalizedAt: input.decision === "approved" || input.decision === "rejected" ? now : undefined}
    });
    await this.recordActivity(context, projectId, "project-initiation", project.initiationAuditArtifact?.id ?? projectId, `project-initiation.${input.decision}`, ["decision", "comment"], `${input.decision.replaceAll("-", " ")} initiation request for ${project.name}`);
    return updated;
  }

  async approveLifecycleGate(context, projectId, gateId, input) {
    const project = await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    if (Number(input.version) !== Number(project.version)) throw new ConflictError();
    const capabilities = await this.getWorkspaceCapabilities(context);
    const gates = (capabilities.lifecycle?.phases ?? []).flatMap((phase) => (phase.gates ?? []).map((gate) => typeof gate === "string" ? {id: gate} : gate));
    const gate = gates.find((item) => item.id === gateId);
    if (!gate) throw new NotFoundError("Lifecycle gate not found");
    if (gate.reviewerIds?.length && !gate.reviewerIds.includes(context.actorId)) throw new ForbiddenError("You are not a reviewer for this lifecycle gate");
    const now = this.now();
    const approval = {gateId, status: "approved", comment: input.comment, reviewerId: context.actorId, approvedAt: now};
    const updated = await this.patchProject(context, projectId, {version: project.version, lifecycleGateApprovals: [...(project.lifecycleGateApprovals ?? []).filter((item) => item.gateId !== gateId), approval]});
    await this.recordActivity(context, projectId, "lifecycle-gate", gateId, "lifecycle-gate.approved", ["status", "comment"], `Approved lifecycle gate ${gate.name ?? gateId}`);
    return updated;
  }

  async copyProject(context, projectId, input) {
    const source = await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const sourceItems = input.includeTasks ? await this.listWorkItems(projectId, context.workspaceId, context.membership?.projectIds) : [];
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
    const ids = new Map(sourceItems.map((item) => [item.id, newId()]));
    for (const sourceItem of sourceItems) {
      const now = this.now();
      const id = ids.get(sourceItem.id);
      const item = {
        ...sourceItem,
        PK: `PROJECT#${copy.id}`,
        SK: `WORK#${id}`,
        id,
        workspaceId: context.workspaceId,
        projectId: copy.id,
        parentId: ids.get(sourceItem.parentId),
        blockedBy: (sourceItem.blockedBy ?? []).map((relatedId) => ids.get(relatedId)).filter(Boolean),
        relatedIds: (sourceItem.relatedIds ?? []).map((relatedId) => ids.get(relatedId)).filter(Boolean),
        relations: (sourceItem.relations ?? []).map((relation) => ({...relation, targetId: ids.get(relation.targetId)})).filter((relation) => relation.targetId),
        recordedMinutes: 0,
        percentComplete: 0,
        version: 1,
        createdAt: now,
        updatedAt: now
      };
      resetCopiedCoordination(item);
      item.GSI2PK = `WORKSPACE#${context.workspaceId}#ASSIGNEE#${item.assigneeId || "UNASSIGNED"}`;
      item.GSI2SK = `DUE#${item.dueDate || "9999-12-31"}#WORK#${id}`;
      Object.assign(item, this.workIndexAttrs(item));
      await this.documentClient.send(new PutCommand({TableName: this.tableName, Item: item, ConditionExpression: "attribute_not_exists(PK)"}));
    }
    await this.recordActivity(context, copy.id, "project", copy.id, "project.copied", ["sourceProjectId"], `Copied project ${source.name}`);
    return copy;
  }

  async deleteProject(context, projectId, input) {
    const project = await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const children = await this.listProjects({workspaceId: context.workspaceId, allowedProjectIds: context.membership?.projectIds, limit: 100});
    if (children.some((item) => item.parentProjectId === projectId)) {
      throw new ConflictError("Move or delete subprojects before deleting this project");
    }
    const deletedAt = this.now();
    await this.patchProject(context, projectId, {
      version: input.version,
      status: "archived",
      archived: true,
      deletedAt,
      deletedBy: context.actorId
    });
    await this.recordActivity(context, projectId, "project", projectId, "project.deleted", ["deletedAt"], `Deleted project ${project.name}`);
    return {id: projectId, deleted: true};
  }

  async listWorkItems(projectId, workspaceId = "", allowedProjectIds = []) {
    await this.getProject(projectId, workspaceId, allowedProjectIds);
    const memberships = await this.listMemberships({workspaceId}).catch(() => []);
    const members = new Map(memberships.map((membership) => [membership.userId, membership]));
    return (await this.queryByPk(`PROJECT#${projectId}`, "WORK#"))
      .map((item) => ({
        ...item,
        assigneeName: members.get(item.assigneeId)?.name ?? item.assigneeId ?? "Unassigned"
      }))
      .sort(sortWorkItems);
  }

  async listPlanningWorkItems(filters = {}) {
    const projects = await this.listProjects({limit: 100, workspaceId: filters.workspaceId, allowedProjectIds: filters.allowedProjectIds});
    const projectNames = new Map(projects.map((project) => [project.id, project.name]));
    let items = [];
    for (const project of projects) items.push(...await this.listWorkItems(project.id, filters.workspaceId, filters.allowedProjectIds));
    for (const field of ["projectId", "status", "assigneeId", "periodId", "intakeGroup", "milestoneName"]) {
      if (filters[field]) items = items.filter((item) => item[field] === filters[field]);
    }
    if (filters.search) {
      items = items.filter((item) => includesFolded(item.title, filters.search) || includesFolded(item.description, filters.search));
    }
    return items.map((item) => ({
      ...item,
      projectName: projectNames.get(item.projectId) ?? item.projectId,
      assigneeName: item.assigneeName ?? item.assigneeId ?? "Unassigned"
    })).sort(sortWorkItems);
  }

  /**
   * Execute Work Query v1 using one selective DynamoDB access path. Query
   * pages are iterated in a bounded loop because DynamoDB applies its Limit
   * before application-level compound filters.
   * @param {Record<string, any>} [filters]
   */
  async listWorkItemsPage(filters = {}) {
    const workspaceId = filters.workspaceId ?? this.workspaceId;
    assertWorkQueryConfiguration(filters.workConfiguration ?? await this.getWorkConfiguration({workspaceId}), filters);
    const source = selectWorkQuerySource(filters);
    if (source === "workspace" && !await this.isWorkIndexMigrationReady()) {
      if (filters.cursor) throw new ValidationError("Work index migration is not ready for cursor pagination");
      const legacyItems = filters.projectId
        ? await this.listWorkItems(filters.projectId, workspaceId, filters.allowedProjectIds)
        : await this.listPlanningWorkItems(filters);
      const items = legacyItems
        .filter((item) => matchesWorkQuery(item, filters))
        .sort((a, b) => compareWorkItems(a, b, filters.sort));
      return {items, pageInfo: workPageInfo(false), queryMode: "legacy-transition"};
    }
    if (filters.projectId) await this.getProject(filters.projectId, workspaceId, filters.allowedProjectIds);
    let exclusiveStartKey = decodeWorkCursor(filters.cursor, {source, workspaceId, query: filters});
    if (exclusiveStartKey) {
      const validTableKey = typeof exclusiveStartKey.PK === "string" && typeof exclusiveStartKey.SK === "string";
      const validIndexKey = source === "workspace"
        ? exclusiveStartKey.GSI1PK === `WORKSPACE#${workspaceId}#WORK`
          && typeof exclusiveStartKey.GSI1SK === "string"
          && exclusiveStartKey.GSI1SK.startsWith("UPDATED#")
        : source === "assignee"
          ? exclusiveStartKey.GSI2PK === `WORKSPACE#${workspaceId}#ASSIGNEE#${filters.assigneeId}`
            && typeof exclusiveStartKey.GSI2SK === "string"
            && exclusiveStartKey.GSI2SK.startsWith("DUE#")
          : exclusiveStartKey.PK === `PROJECT#${filters.projectId}`
            && typeof exclusiveStartKey.SK === "string"
            && exclusiveStartKey.SK.startsWith("WORK#");
      if (!validTableKey || !validIndexKey) throw new ValidationError("Cursor key is invalid for this work query");
    }

    const matches = [];
    let lastEvaluatedKey;
    let iterations = 0;
    while (iterations < maxWorkQueryIterations && matches.length <= filters.limit) {
      iterations += 1;
      const command = {
        TableName: this.tableName,
        ExclusiveStartKey: exclusiveStartKey,
        Limit: Math.max(25, Math.min(100, (filters.limit + 1 - matches.length) * 2)),
        ScanIndexForward: source !== "workspace"
      };
      if (source === "project") {
        Object.assign(command, {
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :work)",
          ExpressionAttributeValues: {":pk": `PROJECT#${filters.projectId}`, ":work": "WORK#"}
        });
      } else if (source === "assignee") {
        const values = {":pk": `WORKSPACE#${workspaceId}#ASSIGNEE#${filters.assigneeId}`};
        let keyCondition = "GSI2PK = :pk";
        if (filters.dueFrom || filters.dueTo) {
          values[":dueFrom"] = `DUE#${filters.dueFrom ?? "0000-01-01"}`;
          values[":dueTo"] = `DUE#${filters.dueTo ?? "9999-12-31"}#\uffff`;
          keyCondition += " AND GSI2SK BETWEEN :dueFrom AND :dueTo";
        }
        Object.assign(command, {
          IndexName: "GSI2",
          KeyConditionExpression: keyCondition,
          ExpressionAttributeValues: values
        });
      } else {
        Object.assign(command, {
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pk",
          ExpressionAttributeValues: {":pk": `WORKSPACE#${workspaceId}#WORK`}
        });
      }
      const result = await dynamo.send(new QueryCommand(command));
      for (const item of result.Items ?? []) {
        if (item.workspaceId !== workspaceId) continue;
        if (!hasProjectAccess(item.projectId, filters.allowedProjectIds)) continue;
        if (matchesWorkQuery(item, filters)) matches.push(item);
        if (matches.length > filters.limit) break;
      }
      lastEvaluatedKey = result.LastEvaluatedKey;
      if (matches.length > filters.limit || !lastEvaluatedKey) break;
      exclusiveStartKey = lastEvaluatedKey;
    }

    const pageRecords = matches.slice(0, filters.limit);
    const hasNextPage = matches.length > filters.limit || Boolean(lastEvaluatedKey);
    const continuationKey = matches.length > filters.limit && pageRecords.length
      ? dynamoWorkCursorKey(pageRecords.at(-1), source)
      : lastEvaluatedKey;
    const endCursor = hasNextPage && continuationKey
      ? encodeWorkCursor({source, workspaceId, query: filters, key: continuationKey})
      : undefined;

    const memberships = await this.listMemberships({workspaceId}).catch(() => []);
    const members = new Map(memberships.map((membership) => [membership.userId, membership]));
    const projectNames = new Map();
    let projectKeys = [...new Set(pageRecords.map((item) => item.projectId))]
      .map((projectId) => ({PK: `PROJECT#${projectId}`, SK: "META"}));
    for (let attempt = 0; attempt < 3 && projectKeys.length; attempt += 1) {
      const result = await dynamo.send(new BatchGetCommand({
        RequestItems: {[this.tableName]: {Keys: projectKeys}}
      }));
      for (const project of result.Responses?.[this.tableName] ?? []) {
        if (project.workspaceId === workspaceId && hasProjectAccess(project.id, filters.allowedProjectIds)) {
          projectNames.set(project.id, project.name);
        }
      }
      projectKeys = result.UnprocessedKeys?.[this.tableName]?.Keys ?? [];
    }
    const items = pageRecords.map(itemWithoutKeys).map((item) => ({
      ...item,
      projectName: projectNames.get(item.projectId) ?? item.projectId,
      assigneeName: members.get(item.assigneeId)?.name ?? item.assigneeId ?? "Unassigned"
    }));
    return {items, pageInfo: workPageInfo(hasNextPage, endCursor)};
  }

  /** @param {Record<string, any>} [filters] */
  async listPlanningWorkItemsPage(filters = {}) {
    return this.listWorkItemsPage(filters);
  }

  async isWorkIndexMigrationReady() {
    if (!this.workIndexReady) return false;
    if (this.workIndexMarkerReady !== undefined) return this.workIndexMarkerReady;
    const result = await dynamo.send(new GetCommand({
      TableName: this.tableName,
      Key: {PK: "SYSTEM#MIGRATION", SK: "WORK_INDEX_V1"},
      ConsistentRead: true
    }));
    this.workIndexMarkerReady = result.Item?.status === "ready";
    return this.workIndexMarkerReady;
  }

  async listAssignedWork(assigneeId, filters = {}) {
    const workspaceId = filters.workspaceId ?? this.workspaceId;
    const result = await dynamo.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: "GSI2",
      KeyConditionExpression: "GSI2PK = :pk",
      ExpressionAttributeValues: {":pk": `WORKSPACE#${workspaceId}#ASSIGNEE#${assigneeId}`},
      Limit: filters.limit ?? 100
    }));
    return (result.Items ?? []).map(itemWithoutKeys).filter((item) => hasProjectAccess(item.projectId, filters.allowedProjectIds));
  }

  async createWorkItem(context, projectId, input) {
    const project = await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const stableId = coordinationTaskId(context.workspaceId, projectId, input);
    const createDigest = stableId ? coordinationDigest(input) : undefined;
    if (stableId) {
      const existing = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: {PK: `PROJECT#${projectId}`, SK: `WORK#${stableId}`}, ConsistentRead: true}));
      if (existing.Item) return itemWithoutKeys(replayCoordinationCreate(existing.Item, createDigest));
    }
    const [configuration, capabilities] = await Promise.all([this.getWorkConfiguration(context), this.getWorkspaceCapabilities(context)]);
    const {autoSubject, ...submitted} = input;
    const configuredInput = {
      ...submitted,
      type: input.type ?? configuration.defaultTypeId,
      status: input.status ?? configuration.defaultStatusId,
      priority: input.priority ?? (capabilities.priorities ?? []).find((priority) => priority.active !== false)?.id ?? "medium"
    };
    if (!(capabilities.priorities ?? []).some((priority) => priority.id === configuredInput.priority && priority.active !== false)) throw new ValidationError("Task priority is not configured");
    if (configuredInput.teamId && !(capabilities.groups ?? []).some((group) => group.id === configuredInput.teamId)) throw new ValidationError("Task team is not configured");
    configuredInput.title = configuredInput.title || automaticWorkSubject(capabilities, {projectId, projectName: project.name, type: configuredInput.type, category: configuredInput.category, versionName: configuredInput.versionName, sequence: new Date(this.now()).getTime()});
    configuredInput.customFields = validateAndCalculateCustomFields(capabilities, "work-item", configuredInput.customFields, {});
    assertWorkItemConfiguration(configuration, {
      type: configuredInput.type,
      status: configuredInput.status,
      role: context.membership?.role,
      creating: true
    });
    await this.assertWorkItemReferences(projectId, stableId, configuredInput);
    await assertCoordinationReferences(this, context, projectId, configuredInput, {id: stableId});
    assertCoordinationUpdate({}, configuredInput, configuration);
    const now = this.now();
    const id = stableId ?? newId();
    const item = {
      PK: `PROJECT#${projectId}`,
      SK: `WORK#${id}`,
      GSI2PK: `WORKSPACE#${context.workspaceId}#ASSIGNEE#${configuredInput.assigneeId ?? context.actorId}`,
      GSI2SK: `DUE#${configuredInput.dueDate ?? "9999-12-31"}#WORK#${id}`,
      id,
      ...(createDigest ? {coordinationCreateDigest: createDigest} : {}),
      workspaceId: context.workspaceId,
      projectId,
      recordedMinutes: 0,
      rank: new Date(this.now()).getTime(),
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...configuredInput,
      reporterId: configuredInput.reporterId ?? context.actorId,
      assigneeId: configuredInput.assigneeId ?? context.actorId
    };
    item.GSI2PK = `WORKSPACE#${context.workspaceId}#ASSIGNEE#${item.assigneeId}`;
    Object.assign(item, this.workIndexAttrs(item));
    try {
      await this.documentClient.send(new PutCommand({TableName: this.tableName, Item: item, ...(stableId ? {ConditionExpression: "attribute_not_exists(PK)"} : {})}));
    } catch (error) {
      if (stableId && error?.name === "ConditionalCheckFailedException") {
        const existing = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: {PK: `PROJECT#${projectId}`, SK: `WORK#${id}`}, ConsistentRead: true}));
        if (existing.Item) return itemWithoutKeys(replayCoordinationCreate(existing.Item, createDigest));
      }
      throw error;
    }
    await this.recordActivity(context, projectId, "work-item", id, "work.created", ["title"], `Created task ${item.title}`, {currentSnapshot: workBaselineSnapshot(item), notificationRecipients: workNotificationRecipients(item)});
    return itemWithoutKeys(item);
  }

  async patchWorkItem(context, projectId, workItemId, patch) {
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const key = {PK: `PROJECT#${projectId}`, SK: `WORK#${workItemId}`};
    const existing = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: key}));
    if (!existing.Item || existing.Item.workspaceId !== context.workspaceId) throw new NotFoundError("Task not found");
    const expectedVersion = Number(patch.version ?? existing.Item.version);
    if (expectedVersion !== Number(existing.Item.version)) throw new ConflictError();
    const capabilities = await this.getWorkspaceCapabilities(context);
    if (capabilities.work?.readOnlyStatusIds?.includes(existing.Item.status) && Object.keys(patch).some((field) => !["version", "status"].includes(field))) throw new ConflictError("This task state is read-only");
    if (patch.customFields !== undefined) patch.customFields = validateAndCalculateCustomFields(capabilities, "work-item", patch.customFields, existing.Item.customFields ?? {});
    if (patch.priority !== undefined && !(capabilities.priorities ?? []).some((priority) => priority.id === patch.priority && priority.active !== false)) throw new ValidationError("Task priority is not configured");
    if (patch.teamId && !(capabilities.groups ?? []).some((group) => group.id === patch.teamId)) throw new ValidationError("Task team is not configured");
    const previousSnapshot = workBaselineSnapshot(existing.Item);
    const item = {...existing.Item, ...patch, version: Number(existing.Item.version) + 1, updatedAt: this.now()};
    if (patch.coordination !== undefined || item.coordination?.acceptanceState === "accepted") assertCoordinationUpdate(existing.Item, patch, await this.getWorkConfiguration(context));
    if (patch.type !== undefined || patch.status !== undefined) {
      const configuration = await this.getWorkConfiguration(context);
      assertWorkItemConfiguration(configuration, {
        type: item.type,
        status: item.status,
        previousType: existing.Item.type,
        previousStatus: existing.Item.status,
        role: context.membership?.role,
        creating: false
      });
    }
    await this.assertWorkItemReferences(projectId, workItemId, patch);
    await assertCoordinationReferences(this, context, projectId, patch, existing.Item);
    item.GSI2PK = `WORKSPACE#${context.workspaceId}#ASSIGNEE#${item.assigneeId || "UNASSIGNED"}`;
    item.GSI2SK = `DUE#${item.dueDate || "9999-12-31"}#WORK#${item.id}`;
    Object.assign(item, this.workIndexAttrs(item));
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: "#version = :expectedVersion",
        ExpressionAttributeNames: {"#version": "version"},
        ExpressionAttributeValues: {":expectedVersion": expectedVersion}
      }));
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") throw new ConflictError();
      throw error;
    }
    await this.recordActivity(context, projectId, "work-item", workItemId, "work.updated", Object.keys(patch), `Updated task ${item.title}`, {previousSnapshot, currentSnapshot: workBaselineSnapshot(item), notificationRecipients: workNotificationRecipients(item)});
    return itemWithoutKeys(item);
  }

  async assertWorkItemReferences(projectId, workItemId, input) {
    const ids = [...new Set([
      input.parentId,
      ...(input.blockedBy ?? []),
      ...(input.relatedIds ?? []),
      ...(input.relations ?? []).map((relation) => relation.targetId)
    ].filter(Boolean))];
    if (workItemId && ids.includes(workItemId)) throw new ValidationError("A task cannot relate to itself");
    const items = await this.batchGetExact(ids.map((id) => ({PK: `PROJECT#${projectId}`, SK: `WORK#${id}`})));
    if (items.length !== ids.length || items.some((item) => item.projectId !== projectId)) {
      throw new ValidationError("Every related task must exist in the same project");
    }
  }

  async applyWorkItemCustomAction(context, projectId, workItemId, actionId, input) {
    const capabilities = await this.getWorkspaceCapabilities(context);
    const action = configuredCustomAction(capabilities, actionId);
    const allowedRoles = action.roleIds ?? action.roles ?? [];
    if (allowedRoles.length && !allowedRoles.includes(context.membership?.role)) throw new ForbiddenError("Custom action is not available for this role");
    return this.patchWorkItem(context, projectId, workItemId, {version: input.version, ...structuredClone(action.changes)});
  }

  async getCoordinationTask(context, projectId, taskId) {
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const result = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: {PK: `PROJECT#${projectId}`, SK: `WORK#${taskId}`}, ConsistentRead: true}));
    if (!result.Item || result.Item.workspaceId !== context.workspaceId) throw new NotFoundError("Task not found");
    return itemWithoutKeys(result.Item);
  }

  async copyWorkItem(context, projectId, workItemId, input) {
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const existing = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {PK: `PROJECT#${projectId}`, SK: `WORK#${workItemId}`}
    }));
    if (!existing.Item || existing.Item.workspaceId !== context.workspaceId) throw new NotFoundError("Task not found");
    const targetProjectId = input.targetProjectId ?? projectId;
    await this.getProject(targetProjectId, context.workspaceId, context.membership?.projectIds);
    const now = this.now();
    const id = newId();
    const item = {
      ...existing.Item,
      PK: `PROJECT#${targetProjectId}`,
      SK: `WORK#${id}`,
      id,
      projectId: targetProjectId,
      title: input.title ?? `${existing.Item.title} copy`,
      parentId: targetProjectId === projectId ? existing.Item.parentId : undefined,
      blockedBy: targetProjectId === projectId ? existing.Item.blockedBy ?? [] : [],
      relatedIds: targetProjectId === projectId ? existing.Item.relatedIds ?? [] : [],
      relations: targetProjectId === projectId ? existing.Item.relations ?? [] : [],
      recordedMinutes: 0,
      version: 1,
      createdAt: now,
      updatedAt: now
    };
    resetCopiedCoordination(item);
    item.GSI2PK = `WORKSPACE#${context.workspaceId}#ASSIGNEE#${item.assigneeId || "UNASSIGNED"}`;
    item.GSI2SK = `DUE#${item.dueDate || "9999-12-31"}#WORK#${id}`;
    Object.assign(item, this.workIndexAttrs(item));
    await this.documentClient.send(new PutCommand({TableName: this.tableName, Item: item, ConditionExpression: "attribute_not_exists(PK)"}));
    await this.recordActivity(context, targetProjectId, "work-item", id, "work.copied", ["sourceWorkItemId"], `Copied task ${existing.Item.title}`, {currentSnapshot: workBaselineSnapshot(item), notificationRecipients: workNotificationRecipients(item)});
    return itemWithoutKeys(item);
  }

  async moveWorkItem(context, projectId, workItemId, input) {
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    await this.getProject(input.targetProjectId, context.workspaceId, context.membership?.projectIds);
    const sourceKey = {PK: `PROJECT#${projectId}`, SK: `WORK#${workItemId}`};
    const existing = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: sourceKey, ConsistentRead: true}));
    if (!existing.Item || existing.Item.workspaceId !== context.workspaceId) throw new NotFoundError("Task not found");
    if (existing.Item.coordination?.sourceId && input.targetProjectId !== projectId) throw new ConflictError("Synchronized tasks keep their project identity; create a new source task in the destination instead");
    if (Number(existing.Item.version) !== Number(input.version)) throw new ConflictError();
    const previousSnapshot = workBaselineSnapshot(existing.Item);
    const item = {
      ...existing.Item,
      PK: `PROJECT#${input.targetProjectId}`,
      SK: `WORK#${workItemId}`,
      projectId: input.targetProjectId,
      parentId: undefined,
      blockedBy: [],
      relatedIds: [],
      relations: [],
      version: Number(existing.Item.version) + 1,
      updatedAt: this.now()
    };
    Object.assign(item, this.workIndexAttrs(item));
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {Delete: {
            TableName: this.tableName,
            Key: sourceKey,
            ConditionExpression: "#version = :expectedVersion",
            ExpressionAttributeNames: {"#version": "version"},
            ExpressionAttributeValues: {":expectedVersion": input.version}
          }},
          {Put: {TableName: this.tableName, Item: item, ConditionExpression: "attribute_not_exists(PK)"}}
        ]
      }));
    } catch (error) {
      if (error?.name === "TransactionCanceledException") throw new ConflictError();
      throw error;
    }
    if (projectId !== input.targetProjectId) await this.recordActivity(context, projectId, "work-item", workItemId, "work.moved-out", ["projectId"], `Moved task ${item.title} out of project`, {previousSnapshot});
    await this.recordActivity(context, input.targetProjectId, "work-item", workItemId, "work.moved", ["projectId"], `Moved task ${item.title}`, {previousSnapshot, currentSnapshot: workBaselineSnapshot(item), notificationRecipients: workNotificationRecipients(item)});
    return itemWithoutKeys(item);
  }

  async deleteWorkItem(context, projectId, workItemId, input) {
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const children = await this.listWorkItems(projectId, context.workspaceId, context.membership?.projectIds);
    if (children.some((item) => item.parentId === workItemId
      || item.blockedBy?.includes(workItemId)
      || item.relatedIds?.includes(workItemId)
      || item.relations?.some((relation) => relation.targetId === workItemId))) {
      throw new ConflictError("Remove task hierarchy and relation references before deleting this task");
    }
    const key = {PK: `PROJECT#${projectId}`, SK: `WORK#${workItemId}`};
    try {
      await this.documentClient.send(new DeleteCommand({
        TableName: this.tableName,
        Key: key,
        ConditionExpression: "#version = :expectedVersion AND workspaceId = :workspaceId",
        ExpressionAttributeNames: {"#version": "version"},
        ExpressionAttributeValues: {":expectedVersion": input.version, ":workspaceId": context.workspaceId}
      }));
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") throw new ConflictError();
      throw error;
    }
    const deleted = children.find((item) => item.id === workItemId) ?? {};
    await this.recordActivity(context, projectId, "work-item", workItemId, "work.deleted", ["id"], `Deleted task ${deleted.title ?? workItemId}`, {previousSnapshot: workBaselineSnapshot(deleted), notificationRecipients: workNotificationRecipients(deleted)});
    return {id: workItemId, deleted: true};
  }

  /** @param {Array<{PK: string, SK: string}>} keys */
  async batchGetExact(keys) {
    if (!keys.length) return [];
    const items = [];
    for (let start = 0; start < keys.length; start += 100) {
      let remaining = keys.slice(start, start + 100);
      for (let attempt = 0; attempt < 3 && remaining.length; attempt += 1) {
        const result = await this.documentClient.send(new BatchGetCommand({
          RequestItems: {
            [this.tableName]: {
              Keys: remaining,
              ConsistentRead: true
            }
          }
        }));
        items.push(...(result.Responses?.[this.tableName] ?? []));
        remaining = result.UnprocessedKeys?.[this.tableName]?.Keys ?? [];
      }
      if (remaining.length) throw new Error("DynamoDB did not process all reference checks");
    }
    return items;
  }

  /**
   * @param {{workspaceId: string, membership?: {projectIds?: string[]}}} context
   * @param {{version: number, projectId: string, limit: number, cursor?: string}} query
   */
  async listMeetingsPage(context, query) {
    if (!query.projectId) {
      const result = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI2",
        KeyConditionExpression: "GSI2PK = :pk",
        ExpressionAttributeValues: {":pk": `WORKSPACE#${context.workspaceId}#MEETINGS`},
        ScanIndexForward: true,
        Limit: query.limit
      }));
      const items = (result.Items ?? []).filter((meeting) => meeting.workspaceId === context.workspaceId && hasProjectAccess(meeting.projectId, context.membership?.projectIds)).map(itemWithoutKeys);
      return {items, pageInfo: meetingPageInfo(false)};
    }
    await this.getProject(query.projectId, context.workspaceId, context.membership?.projectIds);
    const exclusiveStartKey = decodeMeetingCursor(query.cursor, {
      adapter: "dynamo",
      workspaceId: context.workspaceId,
      query
    });
    const expectedIndexPk = `PROJECT#${query.projectId}#MEETINGS`;
    if (exclusiveStartKey && (
      exclusiveStartKey.PK !== `PROJECT#${query.projectId}`
      || typeof exclusiveStartKey.SK !== "string"
      || !exclusiveStartKey.SK.startsWith("MEETING#")
      || exclusiveStartKey.GSI1PK !== expectedIndexPk
      || typeof exclusiveStartKey.GSI1SK !== "string"
      || !exclusiveStartKey.GSI1SK.startsWith("START#")
    )) {
      throw new ValidationError("Cursor key is invalid for this meeting query");
    }
    const result = await this.documentClient.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: {":pk": expectedIndexPk},
      ExclusiveStartKey: exclusiveStartKey,
      ScanIndexForward: true,
      Limit: query.limit + 1
    }));
    const records = (result.Items ?? [])
      .filter((meeting) => meeting.workspaceId === context.workspaceId && meeting.projectId === query.projectId);
    const pageRecords = records.slice(0, query.limit);
    const hasNextPage = records.length > query.limit || Boolean(result.LastEvaluatedKey);
    const continuationKey = hasNextPage && pageRecords.length
      ? dynamoMeetingCursorKey(pageRecords.at(-1))
      : undefined;
    const endCursor = continuationKey
      ? encodeMeetingCursor({adapter: "dynamo", workspaceId: context.workspaceId, query, key: continuationKey})
      : undefined;
    return {
      items: pageRecords.map(itemWithoutKeys),
      pageInfo: meetingPageInfo(hasNextPage, endCursor)
    };
  }

  /**
   * @param {{workspaceId: string, membership?: {projectIds?: string[]}}} context
   * @param {string} projectId
   * @param {string} meetingId
   */
  async getMeeting(context, projectId, meetingId) {
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const result = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: meetingKey(projectId, meetingId),
      ConsistentRead: true
    }));
    if (!result.Item || result.Item.workspaceId !== context.workspaceId || result.Item.projectId !== projectId) {
      throw new NotFoundError("Meeting not found");
    }
    return itemWithoutKeys(result.Item);
  }

  /**
   * @param {{workspaceId: string}} context
   * @param {string} projectId
   * @param {string[]} participantIds
   */
  async assertMeetingParticipants(context, projectId, participantIds) {
    const memberships = await this.batchGetExact(participantIds.map((participantId) => ({
      PK: `WORKSPACE#${context.workspaceId}`,
      SK: `MEMBER#${participantId}`
    })));
    const activeParticipants = new Set(memberships
      .filter((membership) => membership.workspaceId === context.workspaceId)
      .filter((membership) => membership.status === undefined || membership.status === "active")
      .filter((membership) => hasProjectAccess(projectId, membership.projectIds))
      .map((membership) => membership.userId));
    if (participantIds.some((participantId) => !activeParticipants.has(participantId))) {
      throw new ValidationError("participantIds must reference active project members");
    }
  }

  /** @param {{workspaceId: string}} context @param {string} projectId @param {Record<string, any>} meeting */
  async assertMeetingWorkItems(context, projectId, meeting) {
    const workItemIds = meetingWorkItemIds(meeting);
    const workItems = await this.batchGetExact(workItemIds.map((workItemId) => ({
      PK: `PROJECT#${projectId}`,
      SK: `WORK#${workItemId}`
    })));
    const validIds = new Set(workItems
      .filter((item) => item.workspaceId === context.workspaceId && item.projectId === projectId)
      .map((item) => item.id));
    if (workItemIds.some((workItemId) => !validIds.has(workItemId))) {
      throw new ValidationError("Meeting work item links must belong to the meeting project");
    }
  }

  async assertMeetingAttachments(context, projectId, meeting) {
    const attachmentIds = meeting.attachmentIds ?? [];
    const documents = await this.batchGetExact(attachmentIds.map((documentId) => ({PK: `PROJECT#${projectId}`, SK: `DOCUMENT#${documentId}`})));
    if (documents.length !== attachmentIds.length || documents.some((document) => document.workspaceId !== context.workspaceId || document.projectId !== projectId)) {
      throw new ValidationError("Meeting attachments must belong to the meeting project");
    }
  }

  /**
   * @param {{workspaceId: string, actorId: string}} context
   * @param {string} idempotencyKey
   * @param {string} requestHash
   */
  async getMeetingCreateReplay(context, idempotencyKey, requestHash) {
    const claim = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: meetingIdempotencyClaimKey(context, idempotencyKey),
      ConsistentRead: true
    }));
    if (!claim.Item) return undefined;
    if (claim.Item.requestHash !== requestHash) {
      throw new ConflictError("Idempotency key was already used with a different meeting request");
    }
    if (!claim.Item.result || typeof claim.Item.result !== "object" || Array.isArray(claim.Item.result)) {
      throw new ConflictError("Idempotent meeting result is unavailable");
    }
    return structuredClone(claim.Item.result);
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
    if (context.idempotencyKey) {
      const replay = await this.getMeetingCreateReplay(context, context.idempotencyKey, requestHash);
      if (replay) return replay;
    }
    const now = this.now();
    const id = newId();
    const item = {
      ...meetingKey(input.projectId, id),
      id,
      workspaceId: context.workspaceId,
      version: 1,
      createdBy: context.actorId,
      updatedBy: context.actorId,
      createdAt: now,
      updatedAt: now,
      ...canonicalInput
    };
    if (item.recurrence) item.seriesId = item.id;
    Object.assign(item, meetingIndexAttrs(item));
    assertMeetingPayloadSize(item);
    await this.assertMeetingParticipants(context, input.projectId, participantIds);
    assertMeetingPresenters(item);
    await this.assertMeetingWorkItems(context, input.projectId, item);
    await this.assertMeetingAttachments(context, input.projectId, item);
    const persistedItem = withoutUndefined(item);
    const result = itemWithoutKeys(persistedItem);
    const activity = activityItem(context, {
      projectId: input.projectId,
      entityType: "meeting",
      entityId: id,
      eventType: "meeting.created",
      fields: ["title", "startsAt"],
      summary: `Created meeting ${item.title}`,
      timestamp: now,
      id: newId()
    });
    const claim = context.idempotencyKey
      ? meetingIdempotencyClaim(context, context.idempotencyKey, {requestHash, result, now})
      : undefined;
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {Put: {
            TableName: this.tableName,
            Item: persistedItem,
            ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
          }},
          {Put: {
            TableName: this.tableName,
            Item: activity,
            ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
          }},
          ...(claim ? [{Put: {
            TableName: this.tableName,
            Item: claim,
            ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
          }}] : [])
        ]
      }));
    } catch (error) {
      if (error?.name === "TransactionCanceledException") {
        if (context.idempotencyKey) {
          const replay = await this.getMeetingCreateReplay(context, context.idempotencyKey, requestHash);
          if (replay) return replay;
        }
        const conditionalIndexes = context.idempotencyKey ? [0, 2] : [0];
        if (isConditionalTransactionCancellation(error, conditionalIndexes)) {
          throw new ConflictError("Meeting create transaction conflicted");
        }
      }
      throw error;
    }
    return result;
  }

  /**
   * @param {{actorId: string, workspaceId: string, correlationId: string, membership?: {projectIds?: string[]}}} context
   * @param {string} projectId
   * @param {string} meetingId
   * @param {Record<string, any>} patch
   */
  async patchMeeting(context, projectId, meetingId, patch) {
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const key = meetingKey(projectId, meetingId);
    const result = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: key,
      ConsistentRead: true
    }));
    const current = result.Item;
    if (!current || current.workspaceId !== context.workspaceId || current.projectId !== projectId) {
      throw new NotFoundError("Meeting not found");
    }
    const expectedVersion = Number(patch.version);
    if (expectedVersion !== Number(current.version)) throw new ConflictError();
    const {projectId: _projectId, version: _version, ...updates} = patch;
    const item = {...current, ...updates};
    assertMeetingUpdate(itemWithoutKeys(current), itemWithoutKeys(item), patch);
    if (!item.participantIds.includes(current.createdBy)) {
      throw new ValidationError("The meeting creator must remain a participant");
    }
    const participantIdsToValidate = meetingParticipantIdsToValidate(current, item, patch);
    if (participantIdsToValidate.length) await this.assertMeetingParticipants(context, projectId, participantIdsToValidate);
    if (patch.participantIds !== undefined || patch.agendaItems !== undefined || patch.attendance !== undefined) assertMeetingPresenters(item);
    if (patch.agendaItems !== undefined) await this.assertMeetingWorkItems(context, projectId, item);
    if (patch.attachmentIds !== undefined) await this.assertMeetingAttachments(context, projectId, item);
    const changed = Object.keys(updates).filter((field) => JSON.stringify(current[field]) !== JSON.stringify(item[field]));
    item.version = Number(current.version) + 1;
    item.updatedAt = this.now();
    item.updatedBy = context.actorId;
    Object.assign(item, meetingIndexAttrs(item));
    const persistedItem = withoutUndefined(item);
    const activity = activityItem(context, {
      projectId,
      entityType: "meeting",
      entityId: meetingId,
      eventType: "meeting.updated",
      fields: changed,
      summary: `Updated meeting ${item.title}`,
      timestamp: item.updatedAt,
      id: newId()
    });
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {Put: {
            TableName: this.tableName,
            Item: persistedItem,
            ConditionExpression: "#version = :expectedVersion AND workspaceId = :workspaceId",
            ExpressionAttributeNames: {"#version": "version"},
            ExpressionAttributeValues: {
              ":expectedVersion": expectedVersion,
              ":workspaceId": context.workspaceId
            }
          }},
          {Put: {
            TableName: this.tableName,
            Item: activity,
            ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"
          }}
        ]
      }));
    } catch (error) {
      if (isConditionalTransactionCancellation(error, [0])) throw new ConflictError();
      throw error;
    }
    return itemWithoutKeys(persistedItem);
  }

  async copyMeeting(context, projectId, meetingId, input) {
    const source = await this.getMeeting(context, projectId, meetingId);
    return this.createMeeting(context, {
      projectId,
      title: input.title ?? `${source.title} copy`,
      description: source.description ?? "",
      startsAt: input.startsAt ?? source.startsAt,
      endsAt: input.endsAt ?? source.endsAt,
      status: "draft",
      location: source.location ?? "",
      participantIds: source.participantIds ?? [],
      agendaItems: (source.agendaItems ?? []).map((item) => ({...structuredClone(item), outcome: ""})),
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
    const now = this.now();
    const activity = activityItem(context, {projectId, entityType: "meeting", entityId: meetingId, eventType: "meeting.deleted", fields: ["id"], summary: `Deleted meeting ${meeting.title}`, timestamp: now, id: newId()});
    try {
      await this.documentClient.send(new TransactWriteCommand({TransactItems: [
        {Delete: {TableName: this.tableName, Key: meetingKey(projectId, meetingId), ConditionExpression: "#version = :version AND workspaceId = :workspaceId", ExpressionAttributeNames: {"#version": "version"}, ExpressionAttributeValues: {":version": input.version, ":workspaceId": context.workspaceId}}},
        {Put: {TableName: this.tableName, Item: activity, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"}}
      ]}));
    } catch (error) {
      if (isConditionalTransactionCancellation(error, [0])) throw new ConflictError();
      throw error;
    }
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
    const result = await this.documentClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: {":pk": `PROJECT#${filters.projectId}`, ":prefix": "CONTENT#"},
      Limit: Math.min(Number(filters.limit ?? 100), 100)
    }));
    let items = (result.Items ?? []).filter((item) => item.workspaceId === context.workspaceId).map(itemWithoutKeys);
    if (filters.kind) items = items.filter((item) => item.kind === filters.kind);
    if (filters.status) items = items.filter((item) => item.status === filters.status);
    if (filters.search) items = items.filter((item) => includesFolded(`${item.title} ${item.body} ${(item.tags ?? []).join(" ")}`, filters.search));
    return items.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
      || String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, filters.limit ?? 100);
  }

  async getProjectContent(context, projectId, contentId) {
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const result = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: projectContentKey(projectId, "", contentId),
      ConsistentRead: true
    }));
    if (!result.Item || result.Item.workspaceId !== context.workspaceId) throw new NotFoundError("Project content not found");
    return itemWithoutKeys(result.Item);
  }

  async assertProjectContentParent(context, projectId, contentId, parentId) {
    if (!parentId) return;
    if (parentId === contentId) throw new ValidationError("Content cannot be its own parent");
    const visited = new Set([contentId]);
    let currentId = parentId;
    for (let depth = 0; currentId && depth < 100; depth += 1) {
      if (visited.has(currentId)) throw new ValidationError("Content hierarchy cannot contain a cycle");
      visited.add(currentId);
      const result = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: projectContentKey(projectId, "", currentId),
        ConsistentRead: true
      }));
      if (!result.Item || result.Item.workspaceId !== context.workspaceId) {
        throw new ValidationError("Content parent must exist in the same project");
      }
      currentId = result.Item.parentId;
    }
    if (currentId) throw new ValidationError("Content hierarchy is too deep");
  }

  async createProjectContent(context, input) {
    await this.getProject(input.projectId, context.workspaceId, context.membership?.projectIds);
    await this.assertProjectContentParent(context, input.projectId, undefined, input.parentId);
    const now = this.now();
    const id = newId();
    const item = withoutUndefined({
      ...projectContentKey(input.projectId, input.kind, id),
      id,
      workspaceId: context.workspaceId,
      version: 1,
      createdBy: context.actorId,
      updatedBy: context.actorId,
      createdAt: now,
      updatedAt: now,
      ...input
    });
    Object.assign(item, projectContentIndexAttrs(item));
    const activity = activityItem(context, {
      projectId: input.projectId,
      entityType: input.kind,
      entityId: id,
      eventType: "content.created",
      fields: ["title", "body"],
      summary: `Created ${input.kind} ${input.title}`,
      timestamp: now,
      id: newId()
    });
    await this.documentClient.send(new TransactWriteCommand({TransactItems: [
      {Put: {TableName: this.tableName, Item: item, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"}},
      {Put: {TableName: this.tableName, Item: projectContentRevisionItem(item, context.actorId), ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"}},
      {Put: {TableName: this.tableName, Item: activity, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"}}
    ]}));
    return itemWithoutKeys(item);
  }

  async patchProjectContent(context, projectId, contentId, patch) {
    const key = projectContentKey(projectId, "", contentId);
    const result = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: key, ConsistentRead: true}));
    const current = result.Item;
    if (!current || current.workspaceId !== context.workspaceId) throw new NotFoundError("Project content not found");
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    if (Number(patch.version) !== Number(current.version)) throw new ConflictError();
    const {version: _version, ...updates} = patch;
    if (current.status === "locked" && !(Object.keys(updates).length === 1 && updates.status !== undefined)) {
      throw new ConflictError("Locked content must be unlocked before editing");
    }
    await this.assertProjectContentParent(context, projectId, contentId, updates.parentId ?? current.parentId);
    const now = this.now();
    const item = withoutUndefined({...current, ...updates, version: Number(current.version) + 1, updatedBy: context.actorId, updatedAt: now});
    Object.assign(item, projectContentIndexAttrs(item));
    const changed = Object.keys(updates).filter((field) => JSON.stringify(current[field]) !== JSON.stringify(item[field]));
    const activity = activityItem(context, {
      projectId,
      entityType: item.kind,
      entityId: contentId,
      eventType: "content.updated",
      fields: changed,
      summary: `Updated ${item.kind} ${item.title}`,
      timestamp: now,
      id: newId()
    });
    try {
      await this.documentClient.send(new TransactWriteCommand({TransactItems: [
        {Put: {TableName: this.tableName, Item: item, ConditionExpression: "#version = :version AND workspaceId = :workspaceId", ExpressionAttributeNames: {"#version": "version"}, ExpressionAttributeValues: {":version": patch.version, ":workspaceId": context.workspaceId}}},
        {Put: {TableName: this.tableName, Item: projectContentRevisionItem(item, context.actorId), ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"}},
        {Put: {TableName: this.tableName, Item: activity, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"}}
      ]}));
    } catch (error) {
      if (isConditionalTransactionCancellation(error, [0])) throw new ConflictError();
      throw error;
    }
    return itemWithoutKeys(item);
  }

  async applyProjectContentOperations(context, projectId, contentId, input) {
    const current = await this.getProjectContent(context, projectId, contentId);
    if (current.status === "locked") throw new ConflictError("Locked content must be unlocked before editing");
    const history = await this.documentClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: {":pk": `CONTENT#${contentId}`, ":prefix": "REVISION#"},
      ScanIndexForward: false,
      ConsistentRead: true,
      Limit: 100
    }));
    const revisions = (history.Items ?? []).map(itemWithoutKeys);
    const merged = mergeContentOperations(current, revisions, input);
    if (merged.duplicate) return {...current, collaboration: {duplicate: true, merged: false, baseVersion: input.version}};
    const now = this.now();
    const item = withoutUndefined({
      ...projectContentKey(projectId, current.kind, contentId),
      ...current,
      body: merged.body,
      version: Number(current.version) + 1,
      updatedBy: context.actorId,
      updatedAt: now
    });
    Object.assign(item, projectContentIndexAttrs(item));
    const activity = activityItem(context, {
      projectId,
      entityType: current.kind,
      entityId: contentId,
      eventType: "content.operations.applied",
      fields: ["body"],
      summary: `Applied ${input.operations.length} collaborative operations`,
      timestamp: now,
      id: newId(),
      details: {clientId: input.clientId}
    });
    try {
      await this.documentClient.send(new TransactWriteCommand({TransactItems: [
        {Put: {TableName: this.tableName, Item: item, ConditionExpression: "#version = :version AND workspaceId = :workspaceId", ExpressionAttributeNames: {"#version": "version"}, ExpressionAttributeValues: {":version": current.version, ":workspaceId": context.workspaceId}}},
        {Put: {TableName: this.tableName, Item: projectContentRevisionItem(item, context.actorId, {collaborationOperation: merged.operation, collaborationKey: merged.collaborationKey, collaborationBaseVersion: merged.baseVersion}), ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"}},
        {Put: {TableName: this.tableName, Item: activity, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"}}
      ]}));
    } catch (error) {
      if (isConditionalTransactionCancellation(error, [0])) throw new ConflictError("Document advanced while merging; retry the same change");
      throw error;
    }
    return {...itemWithoutKeys(item), collaboration: {duplicate: false, merged: merged.merged, baseVersion: merged.baseVersion}};
  }

  async updateProjectContentPresence(context, projectId, contentId, input) {
    await this.getProjectContent(context, projectId, contentId);
    const now = this.now();
    const item = {PK: `PROJECT#${projectId}`, SK: `CONTENT_SESSION#${contentId}#${context.actorId}#${input.clientId}`, workspaceId: context.workspaceId, projectId, contentId, userId: context.actorId, userName: context.user?.name ?? context.actorId, ...input, seenAt: now, expiresAt: Math.floor(new Date(now).getTime() / 1000) + 120};
    await this.documentClient.send(new PutCommand({TableName: this.tableName, Item: item}));
    return itemWithoutKeys(item);
  }

  async listProjectContentPresence(context, projectId, contentId) {
    await this.getProjectContent(context, projectId, contentId);
    const result = await this.documentClient.send(new QueryCommand({TableName: this.tableName, KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)", ExpressionAttributeValues: {":pk": `PROJECT#${projectId}`, ":prefix": `CONTENT_SESSION#${contentId}#`}, Limit: 100}));
    const now = Math.floor(new Date(this.now()).getTime() / 1000);
    return (result.Items ?? []).filter((item) => item.workspaceId === context.workspaceId && item.expiresAt > now).map(itemWithoutKeys);
  }

  async deleteProjectContent(context, projectId, contentId, input) {
    const item = await this.getProjectContent(context, projectId, contentId);
    if (Number(input.version) !== Number(item.version)) throw new ConflictError();
    const children = await this.listProjectContent(context, {projectId, limit: 100});
    if (children.some((candidate) => candidate.parentId === contentId)) throw new ConflictError("Move or delete child content first");
    const now = this.now();
    const activity = activityItem(context, {
      projectId,
      entityType: item.kind,
      entityId: contentId,
      eventType: "content.deleted",
      fields: ["id"],
      summary: `Deleted ${item.kind} ${item.title}`,
      timestamp: now,
      id: newId()
    });
    try {
      await this.documentClient.send(new TransactWriteCommand({TransactItems: [
        {Delete: {TableName: this.tableName, Key: projectContentKey(projectId, "", contentId), ConditionExpression: "#version = :version AND workspaceId = :workspaceId", ExpressionAttributeNames: {"#version": "version"}, ExpressionAttributeValues: {":version": input.version, ":workspaceId": context.workspaceId}}},
        {Put: {TableName: this.tableName, Item: activity, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"}}
      ]}));
    } catch (error) {
      if (isConditionalTransactionCancellation(error, [0])) throw new ConflictError();
      throw error;
    }
    return {id: contentId, deleted: true};
  }

  async listProjectContentRevisions(context, projectId, contentId) {
    await this.getProjectContent(context, projectId, contentId);
    const result = await this.documentClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: {":pk": `CONTENT#${contentId}`, ":prefix": "REVISION#"},
      ScanIndexForward: false,
      Limit: 100
    }));
    return (result.Items ?? []).map(itemWithoutKeys);
  }

  async listPlanningResources(context, filters = {}) {
    await this.getProject(filters.projectId, context.workspaceId, context.membership?.projectIds);
    const result = await this.documentClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: {":pk": `PROJECT#${filters.projectId}`, ":prefix": "PLANNING#"},
      Limit: Math.min(Number(filters.limit ?? 100), 100)
    }));
    let items = (result.Items ?? []).filter((item) => item.workspaceId === context.workspaceId).map(itemWithoutKeys);
    const canManageBoards = [roles.admin, roles.portfolioManager, roles.projectManager].includes(context.membership?.role);
    if (!canManageBoards) items = items.filter((item) => item.kind !== "board" || !item.boardEditorIds?.length || item.boardEditorIds.includes(context.actorId));
    if (filters.kind) items = items.filter((item) => item.kind === filters.kind);
    if (filters.status) items = items.filter((item) => item.status === filters.status);
    const workItems = (filters.kind === "version" || filters.kind === "sprint" || !filters.kind)
      ? await this.listWorkItems(filters.projectId, context.workspaceId, context.membership?.projectIds)
      : [];
    return items.sort((a, b) => String(a.startDate ?? "9999-12-31").localeCompare(String(b.startDate ?? "9999-12-31")))
      .slice(0, filters.limit ?? 100)
      .map((item) => {
        const linked = item.kind === "version"
          ? workItems.filter((work) => work.versionId === item.id || !work.versionId && work.versionName === item.name)
          : item.kind === "sprint" ? workItems.filter((work) => work.sprintId === item.id) : [];
        return {...item, workItemCount: linked.length, completedPoints: linked.reduce((sum, work) => sum + Number(work.percentComplete >= 100 ? work.effortPoints ?? 0 : 0), 0), totalPoints: linked.reduce((sum, work) => sum + Number(work.effortPoints ?? 0), 0)};
      });
  }

  async getPlanningResource(context, projectId, resourceId) {
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const result = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: planningResourceKey(projectId, resourceId), ConsistentRead: true}));
    if (!result.Item || result.Item.workspaceId !== context.workspaceId) throw new NotFoundError("Planning resource not found");
    const canManageBoard = [roles.admin, roles.portfolioManager, roles.projectManager].includes(context.membership?.role);
    if (result.Item.kind === "board" && result.Item.boardEditorIds?.length && !result.Item.boardEditorIds.includes(context.actorId) && !canManageBoard) throw new NotFoundError("Planning resource not found");
    return itemWithoutKeys(result.Item);
  }

  async createPlanningResource(context, input) {
    await this.getProject(input.projectId, context.workspaceId, context.membership?.projectIds);
    for (const sharedProjectId of input.sharedProjectIds ?? []) await this.getProject(sharedProjectId, context.workspaceId, context.membership?.projectIds);
    if (input.kind === "version") {
      const capabilities = await this.getWorkspaceCapabilities(context);
      input.customFields = validateAndCalculateCustomFields(capabilities, "version", input.customFields ?? {}, {});
    }
    const now = this.now();
    const id = newId();
    const snapshot = input.kind === "baseline" ? (await this.listWorkItems(input.projectId, context.workspaceId, context.membership?.projectIds))
      .slice(0, 100)
      .map((work) => Object.fromEntries(["id", "title", "startDate", "dueDate", "status", "percentComplete", "estimateMinutes", "remainingMinutes"].map((field) => [field, work[field]]).filter(([, value]) => value !== undefined))) : undefined;
    const item = withoutUndefined({
      ...planningResourceKey(input.projectId, id),
      id,
      workspaceId: context.workspaceId,
      version: 1,
      createdBy: context.actorId,
      updatedBy: context.actorId,
      createdAt: now,
      updatedAt: now,
      ...input,
      ...(snapshot ? {snapshot, capturedAt: now} : {})
    });
    Object.assign(item, planningResourceIndexAttrs(item));
    await this.documentClient.send(new PutCommand({TableName: this.tableName, Item: item, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"}));
    await this.recordActivity(context, input.projectId, "planning-resource", id, "planning-resource.created", ["kind", "name"], `Created ${input.kind} ${input.name}`);
    return itemWithoutKeys(item);
  }

  async patchPlanningResource(context, projectId, resourceId, patch) {
    const key = planningResourceKey(projectId, resourceId);
    const result = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: key, ConsistentRead: true}));
    const current = result.Item;
    if (!current || current.workspaceId !== context.workspaceId) throw new NotFoundError("Planning resource not found");
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
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
    const item = withoutUndefined({...current, ...updates, startDate, endDate, version: Number(current.version) + 1, updatedBy: context.actorId, updatedAt: this.now()});
    Object.assign(item, planningResourceIndexAttrs(item));
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: "#version = :version AND workspaceId = :workspaceId",
        ExpressionAttributeNames: {"#version": "version"},
        ExpressionAttributeValues: {":version": patch.version, ":workspaceId": context.workspaceId}
      }));
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") throw new ConflictError();
      throw error;
    }
    await this.recordActivity(context, projectId, "planning-resource", resourceId, "planning-resource.updated", Object.keys(updates), `Updated ${item.kind} ${item.name}`);
    return itemWithoutKeys(item);
  }

  async deletePlanningResource(context, projectId, resourceId, input) {
    const item = await this.getPlanningResource(context, projectId, resourceId);
    if (Number(input.version) !== Number(item.version)) throw new ConflictError();
    const workItems = await this.listWorkItems(projectId, context.workspaceId, context.membership?.projectIds);
    if (workItems.some((work) => work.versionId === resourceId || work.sprintId === resourceId)) throw new ConflictError("Remove task links before deleting this planning resource");
    try {
      await this.documentClient.send(new DeleteCommand({
        TableName: this.tableName,
        Key: planningResourceKey(projectId, resourceId),
        ConditionExpression: "#version = :version AND workspaceId = :workspaceId",
        ExpressionAttributeNames: {"#version": "version"},
        ExpressionAttributeValues: {":version": input.version, ":workspaceId": context.workspaceId}
      }));
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") throw new ConflictError();
      throw error;
    }
    await this.recordActivity(context, projectId, "planning-resource", resourceId, "planning-resource.deleted", ["id"], `Deleted ${item.kind} ${item.name}`);
    return {id: resourceId, deleted: true};
  }

  async comparePlanningBaseline(context, projectId, baselineId) {
    const baseline = await this.getPlanningResource(context, projectId, baselineId);
    if (baseline.kind !== "baseline") throw new ValidationError("Planning resource is not a baseline");
    return compareProjectBaseline(await this.listWorkItems(projectId, context.workspaceId, context.membership?.projectIds), baseline);
  }

  async compareHistoricalBaseline(context, projectId, from, to) {
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const [workItems, activity] = await Promise.all([
      this.listWorkItems(projectId, context.workspaceId, context.membership?.projectIds),
      this.listActivity(projectId, context.workspaceId)
    ]);
    return compareProjectHistory(workItems, activity, from, to);
  }

  async getSprintBurndown(context, projectId, sprintId) {
    const sprint = await this.getPlanningResource(context, projectId, sprintId);
    if (sprint.kind !== "sprint" || !sprint.startDate || !sprint.endDate) throw new ValidationError("Sprint must have start and end dates");
    const items = (await this.listWorkItems(projectId, context.workspaceId, context.membership?.projectIds)).filter((item) => item.sprintId === sprintId);
    const totalPoints = items.reduce((sum, item) => sum + Number(item.effortPoints ?? 0), 0);
    const remainingPoints = items.reduce((sum, item) => sum + Number(item.percentComplete >= 100 ? 0 : item.effortPoints ?? 0), 0);
    const dates = [];
    for (let value = new Date(`${sprint.startDate}T00:00:00Z`), end = new Date(`${sprint.endDate}T00:00:00Z`); value <= end && dates.length < 370; value.setUTCDate(value.getUTCDate() + 1)) dates.push(value.toISOString().slice(0, 10));
    return {sprint, totalPoints, remainingPoints, completedPoints: totalPoints - remainingPoints, series: dates.map((date, index) => ({date, idealRemaining: Math.round(totalPoints * (1 - index / Math.max(1, dates.length - 1)) * 10) / 10, ...(date === this.now().slice(0, 10) || index === dates.length - 1 ? {actualRemaining: remainingPoints} : {})}))};
  }

  async scheduleProject(context, projectId) {
    const project = await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const resources = await this.listPlanningResources(context, {projectId, kind: "work-calendar"});
    const calendar = resources.find((item) => item.default) ?? resources.find((item) => item.status === "active") ?? resources[0] ?? {};
    const workItems = await this.listWorkItems(projectId, context.workspaceId, context.membership?.projectIds);
    const result = calculateProjectSchedule(workItems, calendar, {projectStartDate: project.startDate, today: this.now().slice(0, 10)});
    for (const update of result.updates) await this.patchWorkItem(context, projectId, update.id, update);
    await this.recordActivity(context, projectId, "project", projectId, "schedule.calculated", ["startDate", "dueDate"], `Scheduled ${result.updates.length} tasks`);
    return result;
  }

  async listTimeEntries(filters = {}) {
    const workspaceId = filters.workspaceId ?? this.workspaceId;
    if (filters.projectId) {
      await this.getProject(filters.projectId, workspaceId, filters.allowedProjectIds);
      const result = await dynamo.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: {":pk": `PROJECT#${filters.projectId}#TIME`},
        Limit: filters.limit ?? 100
      }));
      return (result.Items ?? []).map(itemWithoutKeys).filter((entry) => entry.workspaceId === workspaceId);
    }
    return (await this.queryByPk(`USER#${filters.userId}`, "TIME#", filters.limit))
      .filter((entry) => entry.workspaceId === workspaceId)
      .filter((entry) => !entry.projectId || hasProjectAccess(entry.projectId, filters.allowedProjectIds));
  }

  async createTimeEntry(context, input) {
    const capabilities = await this.getWorkspaceCapabilities(context);
    if (capabilities.work?.exactTimeRequired && (!input.startedAt || !input.endedAt)) throw new ValidationError("Exact start and end times are required");
    const activity = (capabilities.timeEntryActivities ?? []).find((item) => item.id === input.activityId && item.active !== false);
    if (!activity) throw new ValidationError("Time entry activity is not active");
    input.customFields = validateAndCalculateCustomFields(capabilities, "time-entry", input.customFields ?? {}, {});
    if (input.projectId) await this.getProject(input.projectId, context.workspaceId, context.membership?.projectIds);
    let workItem;
    if (input.workItemId) {
      const items = await this.listPlanningWorkItems({workspaceId: context.workspaceId, allowedProjectIds: context.membership?.projectIds});
      workItem = items.find((item) => item.id === input.workItemId);
      if (!workItem) throw new NotFoundError("Task not found");
    }
    const now = this.now();
    const id = newId();
    const item = {
      PK: `USER#${context.actorId}`,
      SK: `TIME#${input.entryDate}#${id}`,
      GSI1PK: (input.projectId ?? workItem?.projectId) ? `PROJECT#${input.projectId ?? workItem?.projectId}#TIME` : undefined,
      GSI1SK: `DATE#${input.entryDate}#TIME#${id}`,
      GSI2PK: `WORKSPACE#${context.workspaceId}#TIME`,
      GSI2SK: `DATE#${input.entryDate}#USER#${context.actorId}#TIME#${id}`,
      id,
      workspaceId: context.workspaceId,
      userId: context.actorId,
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...input,
      projectId: input.projectId ?? workItem?.projectId
    };
    const persistedItem = withoutUndefined(item);
    if (workItem) {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {Put: {TableName: this.tableName, Item: persistedItem, ConditionExpression: "attribute_not_exists(PK)"}},
          {Update: {
            TableName: this.tableName,
            Key: {PK: `PROJECT#${workItem.projectId}`, SK: `WORK#${workItem.id}`},
            UpdateExpression: "SET updatedAt = :now ADD recordedMinutes :duration, #version :one",
            ConditionExpression: "workspaceId = :workspaceId",
            ExpressionAttributeNames: {"#version": "version"},
            ExpressionAttributeValues: {":now": now, ":duration": input.durationMinutes, ":one": 1, ":workspaceId": context.workspaceId}
          }}
        ]
      }));
    } else await this.documentClient.send(new PutCommand({TableName: this.tableName, Item: persistedItem, ConditionExpression: "attribute_not_exists(PK)"}));
    await this.recordActivity(context, item.projectId, "time-entry", id, "time.created", ["durationMinutes"], `Recorded ${input.durationMinutes} minutes`);
    return itemWithoutKeys(item);
  }

  async patchTimeEntry(context, timeEntryId, patch) {
    const oldKey = {PK: `USER#${context.actorId}`, SK: `TIME#${patch.originalEntryDate}#${timeEntryId}`};
    const existing = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: oldKey, ConsistentRead: true}));
    if (!existing.Item || existing.Item.workspaceId !== context.workspaceId || existing.Item.userId !== context.actorId) throw new NotFoundError("Time entry not found");
    if (Number(existing.Item.version) !== Number(patch.version)) throw new ConflictError();
    const capabilities = await this.getWorkspaceCapabilities(context);
    if (capabilities.work?.exactTimeRequired && (!(patch.startedAt ?? existing.Item.startedAt) || !(patch.endedAt ?? existing.Item.endedAt))) throw new ValidationError("Exact start and end times are required");
    const activityId = patch.activityId ?? existing.Item.activityId ?? "general";
    if (!(capabilities.timeEntryActivities ?? []).some((item) => item.id === activityId && item.active !== false)) throw new ValidationError("Time entry activity is not active");
    if (patch.customFields !== undefined) patch.customFields = validateAndCalculateCustomFields(capabilities, "time-entry", patch.customFields, existing.Item.customFields ?? {});
    const entryDate = patch.entryDate ?? existing.Item.entryDate;
    const item = withoutUndefined({
      ...existing.Item,
      ...patch,
      SK: `TIME#${entryDate}#${timeEntryId}`,
      GSI1SK: `DATE#${entryDate}#TIME#${timeEntryId}`,
      GSI2SK: `DATE#${entryDate}#USER#${context.actorId}#TIME#${timeEntryId}`,
      entryDate,
      originalEntryDate: undefined,
      version: Number(existing.Item.version) + 1,
      updatedAt: this.now()
    });
    const delta = Number(item.durationMinutes) - Number(existing.Item.durationMinutes);
    const moved = item.SK !== oldKey.SK;
    const timeWrites = moved
      ? [
          {Delete: {TableName: this.tableName, Key: oldKey, ConditionExpression: "#version = :expectedVersion", ExpressionAttributeNames: {"#version": "version"}, ExpressionAttributeValues: {":expectedVersion": patch.version}}},
          {Put: {TableName: this.tableName, Item: item, ConditionExpression: "attribute_not_exists(PK)"}}
        ]
      : [{Put: {TableName: this.tableName, Item: item, ConditionExpression: "#version = :expectedVersion", ExpressionAttributeNames: {"#version": "version"}, ExpressionAttributeValues: {":expectedVersion": patch.version}}}];
    const workUpdate = delta && item.workItemId ? [{Update: {
      TableName: this.tableName,
      Key: {PK: `PROJECT#${item.projectId}`, SK: `WORK#${item.workItemId}`},
      UpdateExpression: "SET updatedAt = :now ADD recordedMinutes :delta, #version :one",
      ConditionExpression: "workspaceId = :workspaceId",
      ExpressionAttributeNames: {"#version": "version"},
      ExpressionAttributeValues: {":now": item.updatedAt, ":delta": delta, ":one": 1, ":workspaceId": context.workspaceId}
    }}] : [];
    try {
      await this.documentClient.send(new TransactWriteCommand({TransactItems: [...timeWrites, ...workUpdate]}));
    } catch (error) {
      if (error?.name === "TransactionCanceledException") throw new ConflictError();
      throw error;
    }
    await this.recordActivity(context, item.projectId, "time-entry", item.id, "time.updated", ["entryDate", "durationMinutes", "startedAt", "endedAt", "description", "billable"], `Updated ${item.durationMinutes} minutes`);
    return itemWithoutKeys(item);
  }

  async deleteTimeEntry(context, timeEntryId, input) {
    const key = {PK: `USER#${context.actorId}`, SK: `TIME#${input.originalEntryDate}#${timeEntryId}`};
    const existing = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: key, ConsistentRead: true}));
    if (!existing.Item || existing.Item.workspaceId !== context.workspaceId || existing.Item.userId !== context.actorId) throw new NotFoundError("Time entry not found");
    if (Number(existing.Item.version) !== Number(input.version)) throw new ConflictError();
    const workUpdate = existing.Item.workItemId ? [{Update: {
      TableName: this.tableName,
      Key: {PK: `PROJECT#${existing.Item.projectId}`, SK: `WORK#${existing.Item.workItemId}`},
      UpdateExpression: "SET updatedAt = :now ADD recordedMinutes :delta, #version :one",
      ConditionExpression: "workspaceId = :workspaceId",
      ExpressionAttributeNames: {"#version": "version"},
      ExpressionAttributeValues: {":now": this.now(), ":delta": -Number(existing.Item.durationMinutes), ":one": 1, ":workspaceId": context.workspaceId}
    }}] : [];
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {Delete: {TableName: this.tableName, Key: key, ConditionExpression: "#version = :expectedVersion", ExpressionAttributeNames: {"#version": "version"}, ExpressionAttributeValues: {":expectedVersion": input.version}}},
          ...workUpdate
        ]
      }));
    } catch (error) {
      if (error?.name === "TransactionCanceledException") throw new ConflictError();
      throw error;
    }
    await this.recordActivity(context, existing.Item.projectId, "time-entry", timeEntryId, "time.deleted", ["id"], `Deleted ${existing.Item.durationMinutes} minutes`);
    return {id: timeEntryId, deleted: true};
  }

  timerKey(context) {
    return {PK: `USER#${context.actorId}`, SK: `TIMER#${context.workspaceId}`};
  }

  async getTimer(context) {
    const result = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: this.timerKey(context), ConsistentRead: true}));
    return result.Item ? itemWithoutKeys(result.Item) : {active: false};
  }

  async startTimer(context, input) {
    if (input.projectId) await this.getProject(input.projectId, context.workspaceId, context.membership?.projectIds);
    let workItem;
    if (input.workItemId) {
      const items = await this.listPlanningWorkItems({workspaceId: context.workspaceId, allowedProjectIds: context.membership?.projectIds});
      workItem = items.find((item) => item.id === input.workItemId);
      if (!workItem) throw new NotFoundError("Task not found");
    }
    const timer = withoutUndefined({
      ...this.timerKey(context),
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
    });
    try {
      await this.documentClient.send(new PutCommand({TableName: this.tableName, Item: timer, ConditionExpression: "attribute_not_exists(PK)"}));
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") throw new ConflictError("A timer is already running");
      throw error;
    }
    return itemWithoutKeys(timer);
  }

  async stopTimer(context) {
    const key = this.timerKey(context);
    const result = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: key, ConsistentRead: true}));
    const timer = result.Item;
    if (!timer || timer.workspaceId !== context.workspaceId) throw new ConflictError("No timer is running");
    const now = this.now();
    const durationMinutes = Math.max(1, Math.min(1440, Math.ceil((new Date(now).getTime() - new Date(timer.startedAt).getTime()) / 60000)));
    const capabilities = await this.getWorkspaceCapabilities(context);
    const activityId = timer.activityId ?? "general";
    if (!(capabilities.timeEntryActivities ?? []).some((item) => item.id === activityId && item.active !== false)) throw new ValidationError("Time entry activity is not active");
    const customFields = validateAndCalculateCustomFields(capabilities, "time-entry", timer.customFields ?? {}, {});
    const id = newId();
    const entryDate = now.slice(0, 10);
    const entry = withoutUndefined({
      PK: `USER#${context.actorId}`,
      SK: `TIME#${entryDate}#${id}`,
      GSI1PK: timer.projectId ? `PROJECT#${timer.projectId}#TIME` : undefined,
      GSI1SK: `DATE#${entryDate}#TIME#${id}`,
      GSI2PK: `WORKSPACE#${context.workspaceId}#TIME`,
      GSI2SK: `DATE#${entryDate}#USER#${context.actorId}#TIME#${id}`,
      id,
      workspaceId: context.workspaceId,
      userId: context.actorId,
      projectId: timer.projectId,
      workItemId: timer.workItemId,
      entryDate,
      durationMinutes,
      startedAt: timer.startedAt,
      endedAt: now,
      description: timer.description,
      billable: timer.billable,
      activityId,
      customFields,
      version: 1,
      createdAt: now,
      updatedAt: now
    });
    const workUpdate = timer.workItemId ? [{Update: {
      TableName: this.tableName,
      Key: {PK: `PROJECT#${timer.projectId}`, SK: `WORK#${timer.workItemId}`},
      UpdateExpression: "SET updatedAt = :now ADD recordedMinutes :duration, #version :one",
      ConditionExpression: "workspaceId = :workspaceId",
      ExpressionAttributeNames: {"#version": "version"},
      ExpressionAttributeValues: {":now": now, ":duration": durationMinutes, ":one": 1, ":workspaceId": context.workspaceId}
    }}] : [];
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {Delete: {TableName: this.tableName, Key: key, ConditionExpression: "startedAt = :startedAt", ExpressionAttributeValues: {":startedAt": timer.startedAt}}},
          {Put: {TableName: this.tableName, Item: entry, ConditionExpression: "attribute_not_exists(PK)"}},
          ...workUpdate
        ]
      }));
    } catch (error) {
      if (error?.name === "TransactionCanceledException") throw new ConflictError("Timer was already stopped or changed");
      throw error;
    }
    await this.recordActivity(context, timer.projectId, "time-entry", id, "time.created", ["durationMinutes"], `Recorded ${durationMinutes} timer minutes`);
    return {timer: {active: false}, entry: itemWithoutKeys(entry)};
  }

  async listActivity(projectId, workspaceId = "", limit) {
    const activeWorkspaceId = workspaceId || this.workspaceId;
    const memberships = await this.listMemberships({workspaceId: activeWorkspaceId}).catch(() => []);
    const members = new Map(memberships.map((membership) => [membership.userId, membership]));
    const enrich = (activity) => ({
      ...activity,
      actorName: members.get(activity.actorId)?.name ?? activity.actorId,
      actorEmail: members.get(activity.actorId)?.email
    });
    if (projectId) {
      await this.getProject(projectId, activeWorkspaceId);
      return (await this.queryByPk(`PROJECT#${projectId}`, "ACTIVITY#", limit)).filter((activity) => activity.workspaceId === activeWorkspaceId).map(enrich);
    }
    const result = await dynamo.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: {":pk": `WORKSPACE#${activeWorkspaceId}#ACTIVITY`},
      Limit: limit ?? 100
    }));
    return (result.Items ?? []).map(itemWithoutKeys).map(enrich);
  }

  async getNotificationReadStates(context, activityIds = []) {
    const ids = [...new Set(activityIds)].slice(0, 100);
    if (!ids.length) return {};
    const result = await this.documentClient.send(new BatchGetCommand({
      RequestItems: {
        [this.tableName]: {
          Keys: ids.map((activityId) => notificationReadKey(context.workspaceId, context.actorId, activityId)),
          ConsistentRead: true
        }
      }
    }));
    return Object.fromEntries((result.Responses?.[this.tableName] ?? [])
      .filter((item) => item.workspaceId === context.workspaceId && item.userId === context.actorId && item.readAt)
      .map((item) => [item.activityId, item.readAt]));
  }

  async setNotificationReadStates(context, activityIds = [], read = true) {
    const ids = [...new Set(activityIds)].slice(0, 100);
    if (!ids.length) return {ids, count: 0, read: Boolean(read)};
    const readAt = this.now();
    const expiresAt = Math.floor(new Date(readAt).getTime() / 1000) + 180 * 86400;
    await this.documentClient.send(new TransactWriteCommand({
      TransactItems: ids.map((activityId) => read ? {Put: {
        TableName: this.tableName,
        Item: {
          ...notificationReadKey(context.workspaceId, context.actorId, activityId),
          workspaceId: context.workspaceId,
          userId: context.actorId,
          activityId,
          readAt,
          expiresAt
        }
      }} : {Delete: {TableName: this.tableName, Key: notificationReadKey(context.workspaceId, context.actorId, activityId)}})
    }));
    return {ids, count: ids.length, read: Boolean(read), ...(read ? {readAt} : {})};
  }

  async getNotificationPreferences(context, capabilities) {
    const result = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: notificationPreferencesKey(context.workspaceId, context.actorId),
      ConsistentRead: true
    }));
    return effectiveNotificationPreferences(capabilities ?? await this.getWorkspaceCapabilities(context), result.Item ? itemWithoutKeys(result.Item) : undefined);
  }

  async saveNotificationPreferences(context, input) {
    const key = notificationPreferencesKey(context.workspaceId, context.actorId);
    const result = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: key, ConsistentRead: true}));
    const capabilities = await this.getWorkspaceCapabilities(context);
    const current = effectiveNotificationPreferences(capabilities, result.Item ? itemWithoutKeys(result.Item) : undefined);
    if (Number(input.version) !== Number(current.version)) throw new ConflictError("Notification preferences changed; reload and try again");
    const now = this.now();
    const item = withoutUndefined({
      ...key,
      ...input,
      workspaceId: context.workspaceId,
      userId: context.actorId,
      version: Number(current.version) + 1,
      createdAt: current.createdAt ?? now,
      updatedAt: now,
      ...(input.emailDigest === "none" ? {} : {
        GSI2PK: notificationScheduleHour(input.digestHourUtc),
        GSI2SK: `ACTIVE#WORKSPACE#${context.workspaceId}#USER#${context.actorId}`
      })
    });
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: result.Item ? "#version = :version" : "attribute_not_exists(PK)",
        ...(result.Item ? {ExpressionAttributeNames: {"#version": "version"}, ExpressionAttributeValues: {":version": Number(current.version)}} : {})
      }));
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") throw new ConflictError("Notification preferences changed; reload and try again");
      throw error;
    }
    await this.recordActivity(context, undefined, "notification-preferences", context.actorId, "notification-preferences.updated", ["participationRules", "projectOverrides", "dateAlertsEnabled", "emailDigest", "deliveryWebhookId", "digestHourUtc", "weeklyDay"], "Updated notification preferences");
    return itemWithoutKeys(item);
  }

  async listScheduledNotificationPreferences(now = new Date()) {
    const items = [];
    let exclusiveStartKey;
    for (let page = 0; page < 10; page += 1) {
      const result = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI2",
        KeyConditionExpression: "GSI2PK = :pk",
        ExpressionAttributeValues: {":pk": notificationScheduleHour(now.getUTCHours())},
        Limit: 100,
        ...(exclusiveStartKey ? {ExclusiveStartKey: exclusiveStartKey} : {})
      }));
      items.push(...(result.Items ?? []).map(itemWithoutKeys));
      exclusiveStartKey = result.LastEvaluatedKey;
      if (!exclusiveStartKey) break;
    }
    return items;
  }

  async claimScheduledNotificationDigest(preferences, periodKey) {
    const now = this.now();
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          ...notificationDigestClaimKey(preferences.workspaceId, preferences.userId, periodKey),
          workspaceId: preferences.workspaceId,
          userId: preferences.userId,
          periodKey,
          status: "processing",
          createdAt: now,
          expiresAt: Math.floor(new Date(now).getTime() / 1000) + 90 * 86400
        },
        ConditionExpression: "attribute_not_exists(PK)"
      }));
      return true;
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  async getNotificationDeliveryContext(preferences) {
    const [membershipResult, workspaceResult] = await Promise.all([
      this.documentClient.send(new GetCommand({TableName: this.tableName, Key: {PK: `WORKSPACE#${preferences.workspaceId}`, SK: `MEMBER#${preferences.userId}`}, ConsistentRead: true})),
      this.documentClient.send(new GetCommand({TableName: this.tableName, Key: {PK: `WORKSPACE#${preferences.workspaceId}`, SK: "META"}}))
    ]);
    const membership = membershipResult.Item ? itemWithoutKeys(membershipResult.Item) : undefined;
    if (!workspaceResult.Item || !isActiveMembership(membership) || membership.placeholder) return undefined;
    const user = {id: preferences.userId, email: membership.email, name: membership.name ?? membership.email};
    return {workspaceId: preferences.workspaceId, actorId: preferences.userId, correlationId: `notification-digest-${newId()}`, workspace: itemWithoutKeys(workspaceResult.Item), user, membership};
  }

  async completeScheduledNotificationDigest(preferences, periodKey, result) {
    const claimKey = notificationDigestClaimKey(preferences.workspaceId, preferences.userId, periodKey);
    await this.documentClient.send(new UpdateCommand({
      TableName: this.tableName,
      Key: claimKey,
      UpdateExpression: "SET #status = :status, completedAt = :completedAt, deliveryId = :deliveryId",
      ExpressionAttributeNames: {"#status": "status"},
      ExpressionAttributeValues: {":status": result.status, ":completedAt": result.completedAt, ":deliveryId": result.deliveryId ?? ""},
      ConditionExpression: "attribute_exists(PK)"
    }));
    await this.documentClient.send(new UpdateCommand({
      TableName: this.tableName,
      Key: notificationPreferencesKey(preferences.workspaceId, preferences.userId),
      UpdateExpression: "SET lastDeliveryStatus = :status, lastDeliveredAt = :completedAt, lastDeliveryId = :deliveryId",
      ExpressionAttributeValues: {":status": result.status, ":completedAt": result.completedAt, ":deliveryId": result.deliveryId ?? ""},
      ConditionExpression: "attribute_exists(PK)"
    }));
  }

  async releaseScheduledNotificationDigest(preferences, periodKey) {
    await this.documentClient.send(new DeleteCommand({
      TableName: this.tableName,
      Key: notificationDigestClaimKey(preferences.workspaceId, preferences.userId, periodKey)
    }));
  }

  async globalSearch(context, search, limit = 50) {
    const term = String(search).trim();
    if (!term) return {items: [], query: term};
    const allowedProjectIds = context.membership?.projectIds;
    const [projects, workResult, documentResult, contentResult, activityResult] = await Promise.all([
      this.listProjects({workspaceId: context.workspaceId, allowedProjectIds, limit: 100}),
      this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: {":pk": `WORKSPACE#${context.workspaceId}#WORK`},
        ScanIndexForward: false,
        Limit: 100
      })),
      this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: {":pk": `WORKSPACE#${context.workspaceId}#DOCUMENTS`},
        ScanIndexForward: false,
        Limit: 100
      })),
      this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: {":pk": `WORKSPACE#${context.workspaceId}#CONTENT`},
        ScanIndexForward: true,
        Limit: 100
      })),
      this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: {":pk": `WORKSPACE#${context.workspaceId}#ACTIVITY`},
        Limit: 100
      }))
    ]);
    const canRead = (projectId) => hasProjectAccess(projectId, allowedProjectIds);
    const results = [
      ...projects.filter((item) => includesFolded(`${item.name} ${item.description ?? ""} ${(item.tags ?? []).join(" ")}`, term)).map((item) => ({type: "project", id: item.id, projectId: item.id, title: item.name, summary: item.description ?? "", updatedAt: item.updatedAt})),
      ...(workResult.Items ?? []).map(itemWithoutKeys).filter((item) => canRead(item.projectId) && includesFolded(`${item.title} ${item.description ?? ""} ${(item.tags ?? []).join(" ")} ${Object.values(item.customFields ?? {}).join(" ")}`, term)).map((item) => ({type: "work-item", id: item.id, projectId: item.projectId, title: item.title, summary: item.description ?? "", updatedAt: item.updatedAt})),
      ...(documentResult.Items ?? []).map(itemWithoutKeys).filter((item) => canRead(item.projectId) && includesFolded(`${item.name} ${item.filename ?? ""} ${item.description ?? ""} ${(item.tags ?? []).join(" ")} ${item.extractedText ?? ""}`, term)).map((item) => ({type: "document", id: item.id, projectId: item.projectId, title: item.name, summary: item.description ?? item.filename ?? "", updatedAt: item.updatedAt, matchedAttachmentContent: includesFolded(item.extractedText, term)})),
      ...(contentResult.Items ?? []).map(itemWithoutKeys).filter((item) => canRead(item.projectId) && includesFolded(`${item.title} ${item.body ?? ""} ${(item.tags ?? []).join(" ")}`, term)).map((item) => ({type: item.kind === "document" ? "collaborative-document" : item.kind, id: item.id, projectId: item.projectId, title: item.title, summary: item.body ?? "", updatedAt: item.updatedAt})),
      ...(activityResult.Items ?? []).map(itemWithoutKeys).filter((item) => item.entityType === "meeting" && canRead(item.projectId) && includesFolded(item.summary, term)).map((item) => ({type: "meeting", id: item.entityId, projectId: item.projectId, title: String(item.summary).replace(/^(Created|Updated) meeting\s+/i, ""), summary: item.summary, updatedAt: item.timestamp}))
    ].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);
    const unique = [...new Map(results.map((item) => [`${item.type}:${item.id}`, item])).values()].slice(0, limit);
    return {items: unique, query: term};
  }

  async getApplicationDataSummary(context = {}) {
    const workspaceId = context.workspaceId ?? this.workspaceId;
    const [memberships, portfolios, projects, documents, activities] = await Promise.all([
      this.listMemberships({workspaceId}),
      this.listPortfolios({workspaceId}),
      this.listProjects({limit: 100, workspaceId}),
      this.listDocuments({limit: 100, workspaceId}),
      this.listActivity(undefined, workspaceId)
    ]);
    let workItems = [];
    let meetings = [];
    for (const project of projects) {
      workItems.push(...await this.listWorkItems(project.id, workspaceId));
      meetings.push(...await this.queryByPk(`PROJECT#${project.id}`, "MEETING#"));
    }
    let timeEntries = [];
    let savedViews = [];
    for (const membership of memberships) {
      timeEntries.push(...await this.queryByPk(`USER#${membership.userId}`, "TIME#"));
      savedViews.push(...await this.queryByPk(`USER#${membership.userId}`, "SAVED_VIEW#"));
    }
    return {
      workspaceId,
      generatedAt: this.now(),
      records: {
        users: memberships.length,
        memberships: memberships.length,
        portfolios: portfolios.length,
        projects: projects.length,
        workItems: workItems.length,
        meetings: meetings.filter((meeting) => meeting.workspaceId === workspaceId).length,
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

  async listDocuments(filters = {}) {
    const workspaceId = filters.workspaceId ?? this.workspaceId;
    const projects = await this.listProjects({limit: 100, workspaceId, allowedProjectIds: filters.allowedProjectIds});
    const projectNames = new Map(projects.map((project) => [project.id, project.name]));
    let documents;
    if (filters.projectId) {
      await this.getProject(filters.projectId, workspaceId, filters.allowedProjectIds);
      documents = await this.queryByPk(`PROJECT#${filters.projectId}`, "DOCUMENT#", filters.limit);
    } else {
      const result = await dynamo.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: {":pk": `WORKSPACE#${workspaceId}#DOCUMENTS`},
        ScanIndexForward: false,
        Limit: filters.limit ?? 100
      }));
      documents = (result.Items ?? []).map(itemWithoutKeys);
    }
    documents = documents.filter((document) => document.workspaceId === workspaceId && hasProjectAccess(document.projectId, filters.allowedProjectIds));
    if (filters.workItemId) documents = documents.filter((document) => document.workItemId === filters.workItemId);
    if (filters.status) documents = documents.filter((document) => document.status === filters.status);
    if (filters.category) documents = documents.filter((document) => document.category === filters.category);
    if (filters.search) {
      documents = documents.filter((document) => includesFolded(document.name, filters.search) || includesFolded(document.filename, filters.search) || includesFolded(document.description, filters.search));
    }
    const workItemNames = new Map();
    for (const projectId of [...new Set(documents.map((document) => document.projectId).filter(Boolean))]) {
      for (const item of await this.listWorkItems(projectId, workspaceId, filters.allowedProjectIds)) {
        workItemNames.set(item.id, item.title);
      }
    }
    return documents.map((document) => publicDocument({
      ...document,
      projectName: projectNames.get(document.projectId) ?? document.projectId,
      workItemName: document.workItemId ? workItemNames.get(document.workItemId) ?? document.workItemId : undefined
    })).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async getDocument(documentId, projectId, workspaceId = "", allowedProjectIds = []) {
    if (!projectId) throw new ValidationError("projectId is required");
    const result = await dynamo.send(new GetCommand({TableName: this.tableName, Key: {PK: `PROJECT#${projectId}`, SK: `DOCUMENT#${documentId}`}}));
    if (!result.Item) throw new NotFoundError("Document not found");
    if (workspaceId && result.Item.workspaceId !== workspaceId) throw new NotFoundError("Document not found");
    if (!hasProjectAccess(result.Item.projectId, allowedProjectIds)) throw new NotFoundError("Document not found");
    return itemWithoutKeys(result.Item);
  }

  async createDocumentUploadIntent(context, input) {
    if (!this.attachmentBucketName) throw new ValidationError("Attachment bucket is not configured");
    if (input.sizeBytes > 25 * 1024 * 1024) throw new ValidationError("Maximum file size is 25 MB");
    await this.getProject(input.projectId, context.workspaceId, context.membership?.projectIds);
    if (input.workItemId) {
      const workItem = (await this.listWorkItems(input.projectId, context.workspaceId, context.membership?.projectIds)).find((item) => item.id === input.workItemId);
      if (!workItem) throw new ValidationError("Document task must belong to the selected project");
    }
    const now = this.now();
    const id = newId();
    const objectKey = `documents/${context.workspaceId}/${input.projectId}/${id}/object`;
    const {command, uploadHeaders} = createDocumentPutRequest({
      bucketName: this.attachmentBucketName,
      objectKey,
      documentId: id,
      input
    });
    const pendingExpiresAt = Math.floor(new Date(now).getTime() / 1000) + 24 * 60 * 60;
    const document = {
      PK: `PROJECT#${input.projectId}`,
      SK: `DOCUMENT#${id}`,
      GSI1PK: `WORKSPACE#${context.workspaceId}#DOCUMENTS`,
      GSI1SK: `UPDATED#${now}#DOCUMENT#${id}`,
      id,
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
      objectKey,
      status: "pending",
      expiresAt: pendingExpiresAt,
      uploadedBy: context.actorId,
      version: 1,
      createdAt: now,
      updatedAt: now
    };
    await dynamo.send(new PutCommand({TableName: this.tableName, Item: document}));
    await this.recordActivity(context, input.projectId, "document", id, "document.upload-intent.created", ["name", "filename"], `Prepared document ${input.name}`);
    return {
      id: newId(),
      documentId: id,
      workspaceId: context.workspaceId,
      projectId: input.projectId,
      objectKey,
      expiresAt: Math.floor(new Date(this.now()).getTime() / 1000) + 600,
      uploadUrl: await getSignedUrl(s3, command, {
        expiresIn: 600,
        signableHeaders: new Set(["content-type"])
      }),
      uploadHeaders,
      document: publicDocument(itemWithoutKeys(document))
    };
  }

  async createDocumentScanRequest(context, projectId, documentId) {
    if (!this.attachmentBucketName) throw new ValidationError("Attachment bucket is not configured");
    const document = await this.getDocument(documentId, projectId, context.workspaceId, context.membership?.projectIds);
    if (document.status !== "pending") throw new ConflictError("Only pending documents can be scanned");
    const capabilities = await this.getWorkspaceCapabilities(context);
    const webhook = capabilities.webhooks?.find((item) => item.id === capabilities.security?.scannerWebhookId && item.enabled !== false);
    if (capabilities.security?.malwareScanning === "disabled" || !webhook) return {scanRequested: false, required: false, document: publicDocument(document)};
    const head = await s3.send(new HeadObjectCommand({Bucket: this.attachmentBucketName, Key: document.objectKey, ChecksumMode: "ENABLED"}));
    assertUploadedDocument(document, head);
    const now = this.now();
    const item = withoutUndefined({
      ...document,
      PK: `PROJECT#${projectId}`,
      SK: `DOCUMENT#${documentId}`,
      GSI1PK: `WORKSPACE#${context.workspaceId}#DOCUMENTS`,
      GSI1SK: `UPDATED#${now}#DOCUMENT#${documentId}`,
      scanStatus: "queued",
      scanRequestedAt: now,
      version: Number(document.version ?? 1) + 1,
      updatedAt: now
    });
    delete item.projectName;
    delete item.workItemName;
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: "#status = :pending AND #version = :version",
        ExpressionAttributeNames: {"#status": "status", "#version": "version"},
        ExpressionAttributeValues: {":pending": "pending", ":version": Number(document.version ?? 1)}
      }));
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") throw new ConflictError("Document changed while its scan was requested");
      throw error;
    }
    const objectUrl = await getSignedUrl(s3, new GetObjectCommand({Bucket: this.attachmentBucketName, Key: document.objectKey}), {expiresIn: 900});
    await this.recordActivity(context, projectId, "document", documentId, "document.scan.requested", ["scanStatus"], `Requested malware scan for ${document.name}`);
    return {
      scanRequested: true,
      required: capabilities.security?.malwareScanning === "required",
      document: publicDocument(itemWithoutKeys(item)),
      job: {
        workspaceId: context.workspaceId,
        projectId,
        documentId,
        objectUrl,
        callbackPath: `/api/v1/documents/${encodeURIComponent(documentId)}/scan?projectId=${encodeURIComponent(projectId)}`,
        checksumSha256: document.checksumSha256,
        sizeBytes: document.sizeBytes,
        contentType: document.contentType
      }
    };
  }

  async finalizeDocument(context, input) {
    if (!this.attachmentBucketName) throw new ValidationError("Attachment bucket is not configured");
    const document = await this.getDocument(input.documentId, input.projectId, context.workspaceId, context.membership?.projectIds);
    if (document.status === "ready") return publicDocument(document);
    if (document.status !== "pending") throw new ConflictError("Only pending documents can be finalized");
    if (Number(document.expiresAt ?? 0) <= Math.floor(new Date(this.now()).getTime() / 1000)) throw new ValidationError("Upload intent has expired");
    const capabilities = await this.getWorkspaceCapabilities(context);
    if (capabilities.security?.malwareScanning === "required" && document.scanStatus !== "clean") {
      throw new ConflictError("A clean malware scan is required before finalization");
    }
    if (document.scanStatus === "infected") throw new ConflictError("An infected document cannot be finalized");
    const head = await s3.send(new HeadObjectCommand({
      Bucket: this.attachmentBucketName,
      Key: document.objectKey,
      ChecksumMode: "ENABLED"
    }));
    assertUploadedDocument(document, head);
    await s3.send(new PutObjectTaggingCommand({
      Bucket: this.attachmentBucketName,
      Key: document.objectKey,
      VersionId: head.VersionId,
      Tagging: {TagSet: [{Key: "state", Value: "ready"}]}
    }));
    const now = this.now();
    const item = {
      ...document,
      PK: `PROJECT#${document.projectId}`,
      SK: `DOCUMENT#${document.id}`,
      GSI1PK: `WORKSPACE#${document.workspaceId}#DOCUMENTS`,
      GSI1SK: `UPDATED#${now}#DOCUMENT#${document.id}`,
      status: "ready",
      objectVersionId: head.VersionId,
      etag: head.ETag,
      version: Number(document.version ?? 1) + 1,
      updatedAt: now
    };
    delete item.projectName;
    delete item.workItemName;
    delete item.expiresAt;
    try {
      await dynamo.send(new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: "#status = :pending AND #version = :expectedVersion",
        ExpressionAttributeNames: {"#status": "status", "#version": "version"},
        ExpressionAttributeValues: {":pending": "pending", ":expectedVersion": Number(document.version ?? 1)}
      }));
    } catch (error) {
      if (error?.name !== "ConditionalCheckFailedException") throw error;
      const current = await this.getDocument(document.id, document.projectId, context.workspaceId, context.membership?.projectIds);
      if (current.status === "ready") return publicDocument(current);
      throw new ConflictError("Document changed while it was being finalized");
    }
    await this.recordActivity(context, document.projectId, "document", document.id, "document.finalized", ["status"], `Finalized document ${document.name}`);
    return publicDocument(itemWithoutKeys(item));
  }

  async patchDocument(context, projectId, documentId, patch) {
    const document = await this.getDocument(documentId, projectId, context.workspaceId, context.membership?.projectIds);
    if (Number(patch.version ?? document.version) !== Number(document.version ?? 1)) throw new ConflictError();
    if (patch.status === "pending" || (document.status === "pending" && patch.status)) {
      throw new ValidationError("Pending documents must be promoted through the finalize endpoint");
    }
    if (patch.workItemId) {
      const workItem = (await this.listWorkItems(document.projectId, context.workspaceId, context.membership?.projectIds)).find((item) => item.id === patch.workItemId);
      if (!workItem) throw new ValidationError("Document task must belong to the document project");
    }
    const now = this.now();
    const item = {
      ...document,
      ...definedValues(patch),
      PK: `PROJECT#${document.projectId}`,
      SK: `DOCUMENT#${document.id}`,
      GSI1PK: `WORKSPACE#${document.workspaceId}#DOCUMENTS`,
      GSI1SK: `UPDATED#${now}#DOCUMENT#${document.id}`,
      version: Number(document.version ?? 1) + 1,
      updatedAt: now
    };
    delete item.projectName;
    try {
      await dynamo.send(new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: "#version = :expectedVersion",
        ExpressionAttributeNames: {"#version": "version"},
        ExpressionAttributeValues: {":expectedVersion": Number(document.version ?? 1)}
      }));
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") throw new ConflictError();
      throw error;
    }
    await this.recordActivity(context, document.projectId, "document", document.id, "document.updated", Object.keys(patch), `Updated document ${item.name}`);
    return publicDocument(itemWithoutKeys(item));
  }

  async createDocumentDownloadIntent(context, projectId, documentId) {
    if (!this.attachmentBucketName) throw new ValidationError("Attachment bucket is not configured");
    const document = await this.getDocument(documentId, projectId, context.workspaceId, context.membership?.projectIds);
    if (document.status === "pending") throw new ConflictError("Document upload is not finalized");
    const command = new GetObjectCommand({
      Bucket: this.attachmentBucketName,
      Key: document.objectKey,
      VersionId: document.objectVersionId,
      ResponseContentDisposition: downloadContentDisposition(document.filename)
    });
    await this.recordActivity(context, document.projectId, "document", document.id, "document.download-intent.created", [], `Created download link for ${document.name}`);
    return {
      document: publicDocument(document),
      downloadUrl: await getSignedUrl(s3, command, {expiresIn: 600}),
      expiresAt: Math.floor(new Date(this.now()).getTime() / 1000) + 600
    };
  }

  async listSavedViews(userId, workspaceId = "", limit) {
    const [personal, shared] = await Promise.all([
      this.queryByPk(`USER#${userId}`, "SAVED_VIEW#", limit),
      workspaceId ? this.queryByPk(`WORKSPACE#${workspaceId}`, "SHARED_VIEW#", limit) : []
    ]);
    return [...new Map([...personal, ...shared].filter((view) => !workspaceId || view.workspaceId === workspaceId).map((view) => [view.id, view])).values()];
  }

  async createSavedView(context, input) {
    const now = this.now();
    const id = newId();
    const item = {PK: `USER#${context.actorId}`, SK: `SAVED_VIEW#${id}`, id, userId: context.actorId, workspaceId: context.workspaceId, version: 1, createdAt: now, updatedAt: now, ...input};
    await dynamo.send(new PutCommand({TableName: this.tableName, Item: item}));
    if (input.visibility === "workspace") await dynamo.send(new PutCommand({TableName: this.tableName, Item: {...item, PK: `WORKSPACE#${context.workspaceId}`, SK: `SHARED_VIEW#${id}`}}));
    await this.recordActivity(context, undefined, "saved-view", id, "saved-view.created", ["name", "scope"], `Saved view ${input.name}`);
    return itemWithoutKeys(item);
  }

  async getPortfolioSummary(context = {}) {
    const projects = await this.listProjects({limit: 100, workspaceId: context.workspaceId, allowedProjectIds: context.membership?.projectIds});
    const workItems = [];
    for (const project of projects) workItems.push(...await this.listWorkItems(project.id, context.workspaceId, context.membership?.projectIds));
    return buildPortfolioSummary(projects, workItems, await this.getWorkConfiguration(context));
  }

  async getPlanningSummary(context = {}) {
    const [workItems, workConfiguration] = await Promise.all([
      this.listPlanningWorkItems({workspaceId: context.workspaceId, allowedProjectIds: context.membership?.projectIds}),
      this.getWorkConfiguration(context)
    ]);
    return buildPlanningSummary(workItems, workConfiguration);
  }

  async getProjectTimeline(context = {}) {
    const projects = await this.listProjects({
      limit: context.publicDemo?.pageLimit ?? 100,
      workspaceId: context.workspaceId,
      allowedProjectIds: context.membership?.projectIds
    });
    return projects.map((project) => ({
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
    const [capabilities, projects, workItems, timeResult] = await Promise.all([
      this.getWorkspaceCapabilities(context),
      this.listProjects({workspaceId: context.workspaceId, allowedProjectIds: context.membership?.projectIds, limit: 100}),
      this.listPlanningWorkItems({workspaceId: context.workspaceId, allowedProjectIds: context.membership?.projectIds}),
      this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI2",
        KeyConditionExpression: "GSI2PK = :pk",
        ExpressionAttributeValues: {":pk": `WORKSPACE#${context.workspaceId}#TIME`},
        Limit: 100
      }))
    ]);
    const projectIds = new Set(projects.map((project) => project.id));
    const timeEntries = (timeResult.Items ?? []).map(itemWithoutKeys).filter((entry) => projectIds.has(entry.projectId));
    return buildCostReport(capabilities, projects, workItems.filter((item) => projectIds.has(item.projectId)), timeEntries, options);
  }

  async getResourcePlan(context = {}, options = {}) {
    const [capabilities, memberships, projects, workItems] = await Promise.all([
      this.getWorkspaceCapabilities(context),
      this.listMemberships(context),
      this.listProjects({workspaceId: context.workspaceId, allowedProjectIds: context.membership?.projectIds, limit: 100}),
      this.listPlanningWorkItems({workspaceId: context.workspaceId, allowedProjectIds: context.membership?.projectIds})
    ]);
    const projectIds = new Set(projects.map((project) => project.id));
    const items = buildResourcePlan(capabilities, memberships, workItems.filter((item) => projectIds.has(item.projectId)), options);
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
    const [capabilities, links] = await Promise.all([
      this.getWorkspaceCapabilities(context),
      this.queryByPk(`WORKSPACE#${context.workspaceId}`, "INTEGRATION#")
    ]);
    const visibleConnectors = [];
    for (const connector of capabilities.connectors ?? []) {
      if (connector.type === "github" && connector.resourceKind === "projects") {
        try { await this.getProject(connector.projectId, context.workspaceId, context.membership?.projectIds); }
        catch (error) { if (error?.status === 404) continue; throw error; }
      }
      visibleConnectors.push(connector);
    }
    return {
      connectors: visibleConnectors.map((connector) => ({
        ...structuredClone(connector),
        adapter: this.integrationRuntime.describe(connector),
        linkedItemCount: links.filter((item) => item.connectorId === connector.id).length
      })),
      repositories: structuredClone(capabilities.repositories ?? []),
      webhooks: structuredClone(capabilities.webhooks ?? [])
    };
  }

  async listRepositories(context) {
    const capabilities = await this.getWorkspaceCapabilities(context);
    const items = [];
    for (const repository of capabilities.repositories ?? []) {
      if (repository.projectId && !hasProjectAccess(repository.projectId, context.membership?.projectIds)) continue;
      if (repository.projectId) await this.getProject(repository.projectId, context.workspaceId, context.membership?.projectIds);
      const result = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: {PK: `WORKSPACE#${context.workspaceId}`, SK: `REPOSITORY_SNAPSHOT#${repository.id}`}}));
      items.push({...structuredClone(repository), entryCount: result.Item?.entries?.length ?? 0, syncedAt: result.Item?.syncedAt, revision: result.Item?.revision});
    }
    return items;
  }

  async syncRepositorySnapshot(context, repositoryId, input) {
    const capabilities = await this.getWorkspaceCapabilities(context);
    const repository = capabilities.repositories?.find((item) => item.id === repositoryId && item.enabled !== false);
    if (!repository) throw new NotFoundError("Repository not found");
    if (repository.projectId) await this.getProject(repository.projectId, context.workspaceId, context.membership?.projectIds);
    const key = {PK: `WORKSPACE#${context.workspaceId}`, SK: `REPOSITORY_SNAPSHOT#${repositoryId}`};
    const existing = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: key, ConsistentRead: true}));
    const snapshot = withoutUndefined({...key, workspaceId: context.workspaceId, repositoryId, type: repository.type ?? "git", ...input, syncedAt: this.now(), syncedBy: context.actorId, version: Number(existing.Item?.version ?? 0) + 1});
    await this.documentClient.send(new PutCommand({TableName: this.tableName, Item: snapshot}));
    await this.recordActivity(context, repository.projectId, "repository", repositoryId, "repository.synchronized", ["ref", "revision", "entries"], `Synchronized ${snapshot.entries.length} repository entries`);
    return {...itemWithoutKeys(snapshot), entries: undefined, entryCount: snapshot.entries.length};
  }

  async browseRepository(context, repositoryId, filters = {}) {
    const repositories = await this.listRepositories(context);
    const repository = repositories.find((item) => item.id === repositoryId);
    if (!repository) throw new NotFoundError("Repository not found");
    const result = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: {PK: `WORKSPACE#${context.workspaceId}`, SK: `REPOSITORY_SNAPSHOT#${repositoryId}`}}));
    const snapshot = result.Item ? itemWithoutKeys(result.Item) : undefined;
    if (!snapshot) return {repository, ref: filters.ref ?? "main", path: filters.path ?? "", entries: []};
    if (filters.ref && filters.ref !== snapshot.ref) throw new NotFoundError("Repository ref not found in the synchronized snapshot");
    const prefix = String(filters.path ?? "").replace(/^\/+|\/+$/g, "");
    const entries = snapshot.entries.filter((entry) => !prefix || entry.path === prefix || entry.path.startsWith(`${prefix}/`)).filter((entry) => {
      const relative = prefix ? entry.path.slice(prefix.length).replace(/^\//, "") : entry.path;
      return relative && !relative.includes("/");
    });
    return {repository, ref: snapshot.ref, revision: snapshot.revision, path: prefix, syncedAt: snapshot.syncedAt, entries};
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
    const link = await this.createIntegrationLink(context, {projectId: input.projectId, connectorId, workItemId: input.workItemId, externalId: resource.id, externalUrl: resource.externalUrl, title: resource.title, linkType: "wiki", metadata: resource.metadata});
    return {resource, link};
  }

  async synchronizeIntegrationPermissions(context, connectorId, input, options = {}) {
    const connector = await this.configuredConnector(context, connectorId);
    await this.getProject(input.projectId, context.workspaceId, context.membership?.projectIds);
    const memberships = (await this.listMemberships(context)).filter((member) => member.status !== "disabled" && (!member.projectIds?.length || member.projectIds.includes(input.projectId)));
    const members = memberships.map((member) => ({email: member.email, externalId: connector.principalField ? member.customFields?.[connector.principalField] : member.email, permission: member.role === "viewer" ? "read" : "write"}));
    const result = await this.integrationRuntime.reconcilePermissions(connector, {resourceId: input.resourceId, members, ...options});
    await this.recordActivity(context, input.projectId, "integration-permissions", input.resourceId, "integration.permissions-synchronized", ["added", "removed"], `Synchronized ${result.desiredCount} provider permissions`, {connectorId});
    return result;
  }

  async receiveProviderWebhook(context, connectorId, request) {
    const connector = await this.configuredConnector(context, connectorId);
    const event = collaborationConnectorTypes.has(connector.type) ? await this.integrationRuntime.verifyCollaborationWebhook(connector, request) : await this.integrationRuntime.verifyWebhook(connector, request);
    const deliveryKey = {PK: `WORKSPACE#${context.workspaceId}`, SK: `PROVIDER_DELIVERY#${connectorId}#${event.deliveryId}`};
    try {
      await this.documentClient.send(new PutCommand({TableName: this.tableName, Item: {...deliveryKey, connectorId, deliveryId: event.deliveryId, status: "processing", createdAt: this.now(), expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400}, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"}));
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") return {accepted: true, duplicate: true, eventType: event.eventType, linkedCount: 0, links: []};
      throw error;
    }
    try {
      if (collaborationConnectorTypes.has(connector.type)) {
        if (!connectorAllowsProject(connector, event.projectId)) throw new ValidationError("Collaboration connector is not enabled for this project");
        await this.getProject(event.projectId, context.workspaceId);
        let result;
        if (event.action === "create-work-item") {
          const configuration = await this.getWorkConfiguration(context);
          const workItem = await this.createWorkItem(context, event.projectId, {title: event.title, description: event.description, type: configuration.defaultTypeId, status: configuration.defaultStatusId, priority: "medium", tags: [connector.type]});
          result = {accepted: true, action: event.action, workItem};
        } else {
          const workItems = await this.listWorkItems(event.projectId, context.workspaceId);
          if (!workItems.some((item) => item.id === event.workItemId)) throw new ValidationError("Collaboration relation task must belong to the selected project");
          if (event.action === "link") {
            const link = await this.createIntegrationLink(context, {projectId: event.projectId, connectorId, workItemId: event.workItemId, externalId: event.resourceId, externalUrl: event.externalUrl, title: event.title, linkType: event.linkType, metadata: {source: connector.type}});
            result = {accepted: true, action: event.action, link};
          } else {
            const link = (await this.listIntegrationLinks(context, {projectId: event.projectId, connectorId, workItemId: event.workItemId})).find((item) => item.externalId === event.resourceId);
            result = {accepted: true, action: event.action, removed: link ? await this.deleteIntegrationLink(context, link.id, link.version) : {deleted: false}};
          }
        }
        await this.documentClient.send(new PutCommand({TableName: this.tableName, Item: {...deliveryKey, connectorId, deliveryId: event.deliveryId, status: "complete", result, createdAt: this.now(), expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400}}));
        return result;
      }
      const projectId = connector.projectId;
      if (!projectId) throw new ValidationError("Development connector projectId is required");
      await this.getProject(projectId, context.workspaceId);
      const linked = [];
      const workItems = await this.listWorkItems(projectId, context.workspaceId);
      for (const workItemId of event.workItemIds ?? []) {
        if (!workItems.some((item) => item.id === workItemId) || !event.externalId) continue;
        linked.push(await this.createIntegrationLink(context, {projectId, connectorId, workItemId, externalId: event.externalId, externalUrl: event.externalUrl, title: event.title, linkType: "development", metadata: event.payload}));
      }
      const activity = await this.ingestIntegrationEvent(context, connectorId, {projectId, workItemId: linked[0]?.workItemId, eventType: event.eventType, externalId: event.externalId, summary: event.summary, payload: {...event.payload, deliveryId: event.deliveryId}});
      const result = {accepted: true, eventType: event.eventType, linkedCount: linked.length, links: linked, activity};
      await this.documentClient.send(new PutCommand({TableName: this.tableName, Item: {...deliveryKey, connectorId, deliveryId: event.deliveryId, status: "complete", result, createdAt: this.now(), expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400}}));
      return result;
    } catch (error) {
      await this.documentClient.send(new DeleteCommand({TableName: this.tableName, Key: deliveryKey})).catch(() => {});
      throw error;
    }
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
    return (await this.queryByPk(`WORKSPACE#${context.workspaceId}`, "INTEGRATION#"))
      .filter((item) => hasProjectAccess(item.projectId, context.membership?.projectIds))
      .filter((item) => !filters.projectId || item.projectId === filters.projectId)
      .filter((item) => !filters.workItemId || item.workItemId === filters.workItemId)
      .filter((item) => !filters.connectorId || item.connectorId === filters.connectorId)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async createIntegrationLink(context, input) {
    await this.getProject(input.projectId, context.workspaceId, context.membership?.projectIds);
    await this.configuredConnector(context, input.connectorId);
    if (input.workItemId) {
      const workItem = (await this.listWorkItems(input.projectId, context.workspaceId, context.membership?.projectIds)).find((item) => item.id === input.workItemId);
      if (!workItem) throw new ValidationError("Linked task must belong to the selected project");
    }
    const duplicate = (await this.listIntegrationLinks(context, {projectId: input.projectId, connectorId: input.connectorId}))
      .find((item) => item.externalId === input.externalId && item.workItemId === input.workItemId);
    if (duplicate) return duplicate;
    const now = this.now();
    const id = newId();
    const item = withoutUndefined({PK: `WORKSPACE#${context.workspaceId}`, SK: `INTEGRATION#${id}`, ...input, id, workspaceId: context.workspaceId, version: 1, createdAt: now, updatedAt: now, createdBy: context.actorId});
    await this.documentClient.send(new PutCommand({TableName: this.tableName, Item: item, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"}));
    await this.recordActivity(context, input.projectId, "integration-link", id, "integration.linked", ["connectorId", "externalId", "workItemId"], `Linked ${input.title}`);
    return itemWithoutKeys(item);
  }

  async deleteIntegrationLink(context, linkId, version) {
    const key = {PK: `WORKSPACE#${context.workspaceId}`, SK: `INTEGRATION#${linkId}`};
    const result = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: key, ConsistentRead: true}));
    const link = result.Item;
    if (!link || !hasProjectAccess(link.projectId, context.membership?.projectIds)) throw new NotFoundError("Integration link not found");
    try {
      await this.documentClient.send(new DeleteCommand({TableName: this.tableName, Key: key, ConditionExpression: "#version = :version", ExpressionAttributeNames: {"#version": "version"}, ExpressionAttributeValues: {":version": Number(version)}}));
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") throw new ConflictError();
      throw error;
    }
    await this.recordActivity(context, link.projectId, "integration-link", linkId, "integration.unlinked", ["connectorId", "externalId"], `Unlinked ${link.title}`);
    return {deleted: true, id: linkId};
  }

  async ingestIntegrationEvent(context, connectorId, input) {
    await this.configuredConnector(context, connectorId);
    let link;
    if (input.linkId) {
      const result = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: {PK: `WORKSPACE#${context.workspaceId}`, SK: `INTEGRATION#${input.linkId}`}}));
      link = result.Item ? itemWithoutKeys(result.Item) : undefined;
    }
    if (!link && input.externalId) link = (await this.listIntegrationLinks(context, {connectorId})).find((item) => item.externalId === input.externalId);
    const projectId = input.projectId ?? link?.projectId;
    const workItemId = input.workItemId ?? link?.workItemId;
    if (!projectId) throw new ValidationError("The event must resolve to a project");
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    if (workItemId && !(await this.listWorkItems(projectId, context.workspaceId, context.membership?.projectIds)).some((item) => item.id === workItemId)) throw new ValidationError("Event task must belong to the selected project");
    return this.recordActivity(context, projectId, "integration-event", input.externalId ?? link?.id ?? newId(), `integration.${input.eventType}`, ["summary"], input.summary, {connectorId, workItemId, externalId: input.externalId, integrationPayload: input.payload});
  }

  async importJiraIssues(context, input) {
    await this.configuredConnector(context, input.connectorId, "jira");
    await this.getProject(input.projectId, context.workspaceId, context.membership?.projectIds);
    const configuration = await this.getWorkConfiguration(context);
    const typeIds = new Set(configuration.types.filter((item) => item.active).map((item) => item.id));
    const statusIds = new Set(configuration.statuses.filter((item) => item.active).map((item) => item.id));
    const imported = [];
    for (const issue of input.issues) {
      const workItem = await this.createWorkItem(context, input.projectId, {title: issue.summary, description: issue.description, type: typeIds.has(issue.type) ? issue.type : configuration.defaultTypeId, status: statusIds.has(issue.status) ? issue.status : configuration.defaultStatusId, assigneeId: issue.assigneeId, priority: issue.priority, tags: issue.labels, customFields: {jiraKey: issue.key}});
      const link = await this.createIntegrationLink(context, {projectId: input.projectId, connectorId: input.connectorId, workItemId: workItem.id, externalId: issue.key, externalUrl: issue.externalUrl, title: issue.summary, linkType: "issue", metadata: {importedFrom: "jira"}});
      imported.push({workItem, link});
    }
    return {items: imported, importedCount: imported.length};
  }

  async listExternalShares(context) {
    return (await this.queryByPk(`WORKSPACE#${context.workspaceId}`, "SHARE_INDEX#"))
      .filter((item) => hasProjectAccess(item.projectId, context.membership?.projectIds))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async createExternalShare(context, input) {
    const capabilities = await this.getWorkspaceCapabilities(context);
    if (!capabilities.externalSharing?.enabled) throw new ForbiddenError("External sharing is not enabled");
    await this.getProject(input.projectId, context.workspaceId, context.membership?.projectIds);
    const workItem = (await this.listWorkItems(input.projectId, context.workspaceId, context.membership?.projectIds)).find((item) => item.id === input.workItemId);
    if (!workItem) throw new NotFoundError("Task not found");
    const permissions = input.permissions?.length ? [...new Set(input.permissions)] : ["read"];
    if (!permissions.includes("read")) permissions.unshift("read");
    const now = this.now();
    const defaultDays = Math.max(1, Math.min(Number(capabilities.externalSharing.defaultExpiresDays ?? 30), 365));
    const expiresAt = input.expiresAt ?? new Date(new Date(now).getTime() + defaultDays * 86400000).toISOString();
    if (expiresAt <= now) throw new ValidationError("External share expiry must be in the future");
    const token = newId();
    const share = withoutUndefined({...input, permissions, token, workspaceId: context.workspaceId, expiresAt, version: 1, createdAt: now, updatedAt: now, createdBy: context.actorId});
    await this.documentClient.send(new TransactWriteCommand({TransactItems: [
      {Put: {TableName: this.tableName, Item: {PK: `SHARE#${token}`, SK: "META", ...share}, ConditionExpression: "attribute_not_exists(PK)"}},
      {Put: {TableName: this.tableName, Item: {PK: `WORKSPACE#${context.workspaceId}`, SK: `SHARE_INDEX#${token}`, ...share}, ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)"}}
    ]}));
    await this.recordActivity(context, input.projectId, "external-share", token, "external-share.created", ["targetType", "target", "permissions", "expiresAt"], `Shared task ${workItem.title}`);
    return share;
  }

  async revokeExternalShare(context, token, version) {
    const key = {PK: `SHARE#${token}`, SK: "META"};
    const result = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: key, ConsistentRead: true}));
    const share = result.Item;
    if (!share || share.workspaceId !== context.workspaceId || !hasProjectAccess(share.projectId, context.membership?.projectIds)) throw new NotFoundError("External share not found");
    const now = this.now();
    const next = {...itemWithoutKeys(share), revokedAt: now, revokedBy: context.actorId, version: Number(share.version) + 1, updatedAt: now};
    try {
      await this.documentClient.send(new TransactWriteCommand({TransactItems: [
        {Put: {TableName: this.tableName, Item: {...key, ...next}, ConditionExpression: "#version = :version", ExpressionAttributeNames: {"#version": "version"}, ExpressionAttributeValues: {":version": Number(version)}}},
        {Put: {TableName: this.tableName, Item: {PK: `WORKSPACE#${context.workspaceId}`, SK: `SHARE_INDEX#${token}`, ...next}}}
      ]}));
    } catch (error) {
      if (error?.name === "TransactionCanceledException" || error?.name === "ConditionalCheckFailedException") throw new ConflictError();
      throw error;
    }
    await this.recordActivity(context, share.projectId, "external-share", token, "external-share.revoked", ["revokedAt"], "Revoked external share");
    return {revoked: true, token, version: next.version};
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
    const result = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: {PK: `SHARE#${token}`, SK: "META"}, ConsistentRead: true}));
    const share = result.Item ? itemWithoutKeys(result.Item) : undefined;
    if (!share || share.revokedAt || share.expiresAt <= this.now() || !(await this.externalShareRecipientAllowed(context, share))) throw new NotFoundError("External share not found or expired");
    const project = await this.getProject(share.projectId, share.workspaceId);
    const workItem = (await this.listWorkItems(share.projectId, share.workspaceId)).find((item) => item.id === share.workItemId);
    if (!workItem) throw new NotFoundError("Shared task no longer exists");
    const activity = (await this.listActivity(share.projectId, share.workspaceId)).filter((item) => item.entityType === "work-item" && item.entityId === share.workItemId && item.visibility !== "internal");
    return {share, project, workItem, activity};
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
    const id = newId();
    const navigation = {PK: `WORKSPACE#${context.workspaceId}`, SK: `OUTBOUND#${reverseTimestamp(now)}#${id}`, id, workspaceId: context.workspaceId, actorId: context.actorId, ...input, host, policy, allowedDomain, allowed, requiresConfirmation, createdAt: now};
    if (policy === "capture" || capabilities.outboundLinks?.captureEvents) await this.documentClient.send(new PutCommand({TableName: this.tableName, Item: navigation}));
    if (policy === "capture" || capabilities.outboundLinks?.captureEvents) await this.recordActivity(context, undefined, "outbound-link", id, "outbound-link.checked", ["url", "policy", "allowed"], `${allowed ? "Allowed" : "Blocked"} navigation to ${host}`);
    return itemWithoutKeys(navigation);
  }

  async listOutboundNavigations(context) {
    return this.queryByPk(`WORKSPACE#${context.workspaceId}`, "OUTBOUND#");
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
      const member = await this.upsertMembership(context, {userId: current?.userId ?? (user.externalId || undefined), email: user.email, name: user.name, role: user.role, status: user.status, groupIds: user.groupIds, department: user.department, directorySource: input.source, directoryExternalId: user.externalId, projectIds: []});
      items.push(member);
      if (user.externalId) byExternalId.set(user.externalId, member);
      byEmail.set(String(user.email).toLowerCase(), member);
    }
    await this.recordActivity(context, undefined, "directory-sync", newId(), `directory.${input.source}.synchronized`, ["users"], `Synchronized ${items.length} ${input.source.toUpperCase()} users`);
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
    await this.recordActivity(context, undefined, "directory-sync", newId(), "directory.ldap.queried-and-synchronized", ["users", "groups", "disabled"], `Queried LDAP and synchronized ${synchronized.length} users and ${ldapGroups.length} groups`);
    return {source: "ldap", items: synchronized, groups: ldapGroups, synchronizedCount: synchronized.length, disabledCount};
  }

  async deliverWebhook(context, webhookId, event) {
    const capabilities = await this.getWorkspaceCapabilities(context);
    const webhook = capabilities.webhooks?.find((item) => item.id === webhookId && item.enabled !== false);
    if (!webhook) throw new NotFoundError("Webhook not found");
    const id = newId();
    const delivery = {id, workspaceId: context.workspaceId, webhookId, eventType: event.eventType, payload: event.payload ?? {}, status: "pending", attempts: 1, createdAt: this.now(), createdBy: context.actorId};
    let timeout;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(webhook.url, {method: "POST", redirect: "error", headers: {"content-type": "application/json", "x-team-spaces-event": event.eventType, "x-team-spaces-delivery": id}, body: JSON.stringify({id, eventType: event.eventType, workspaceId: context.workspaceId, payload: delivery.payload}), signal: controller.signal});
      delivery.status = response.ok ? "delivered" : "failed";
      delivery.responseStatus = response.status;
    } catch (error) {
      delivery.status = "failed";
      delivery.error = error instanceof Error ? error.name : "DeliveryError";
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    delivery.completedAt = this.now();
    await this.documentClient.send(new PutCommand({TableName: this.tableName, Item: {PK: `WORKSPACE#${context.workspaceId}`, SK: `WEBHOOK_DELIVERY#${reverseTimestamp(delivery.createdAt)}#${id}`, ...delivery}}));
    await this.recordActivity(context, undefined, "webhook-delivery", id, `webhook.${delivery.status}`, ["status", "responseStatus"], `${delivery.status === "delivered" ? "Delivered" : "Failed"} webhook ${webhookId}`);
    return delivery;
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
      ? structuredClone(payload ?? {})
      : {truncated: true, correlationId: context.correlationId};
    const settled = await Promise.allSettled(webhooks.map((webhook) => this.deliverWebhook(context, webhook.id, {eventType, payload: safePayload})));
    return settled.map((result, index) => result.status === "fulfilled" ? result.value : {webhookId: webhooks[index].id, eventType, status: "failed"});
  }

  async listWebhookDeliveries(context) {
    return this.queryByPk(`WORKSPACE#${context.workspaceId}`, "WEBHOOK_DELIVERY#");
  }

  async recordDocumentScan(context, projectId, documentId, input) {
    const document = await this.getDocument(documentId, projectId, context.workspaceId, context.membership?.projectIds);
    if (document.status !== "pending" || document.scanStatus !== "queued") throw new ConflictError("Only queued pending documents can accept scan results");
    const now = this.now();
    const item = withoutUndefined({...document, PK: `PROJECT#${projectId}`, SK: `DOCUMENT#${documentId}`, GSI1PK: `WORKSPACE#${context.workspaceId}#DOCUMENTS`, GSI1SK: `UPDATED#${now}#DOCUMENT#${documentId}`, scanStatus: input.status, scanEngine: input.engine ?? "external", scannedAt: input.scannedAt ?? now, extractedText: input.extractedText ?? document.extractedText, version: Number(document.version ?? 1) + 1, updatedAt: now});
    delete item.projectName;
    delete item.workItemName;
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: "#version = :version AND #status = :pending AND #scanStatus = :queued",
        ExpressionAttributeNames: {"#version": "version", "#status": "status", "#scanStatus": "scanStatus"},
        ExpressionAttributeValues: {":version": Number(document.version ?? 1), ":pending": "pending", ":queued": "queued"}
      }));
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") throw new ConflictError();
      throw error;
    }
    await this.recordActivity(context, projectId, "document", documentId, `document.scan.${input.status}`, ["scanStatus", "scanEngine"], `Document scan marked ${input.status}`);
    return publicDocument(itemWithoutKeys(item));
  }

  async createUploadIntent(context, input) {
    return this.createDocumentUploadIntent(context, {...input, name: input.filename, category: "other", description: "", tags: []});
  }
}

export function createDynamoRepositoryFromEnv() {
  return new DynamoRepository({
    tableName: process.env.TABLE_NAME,
    attachmentBucketName: process.env.ATTACHMENT_BUCKET_NAME,
    workspaceId: process.env.DEFAULT_WORKSPACE_ID ?? "workspace-default",
    workIndexReady: process.env.WORK_INDEX_READY === "true"
  });
}
