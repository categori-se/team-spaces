// @ts-nocheck

import {DynamoDBClient} from "@aws-sdk/client-dynamodb";
import {GetObjectCommand, HeadObjectCommand, PutObjectCommand, PutObjectTaggingCommand, S3Client} from "@aws-sdk/client-s3";
import {BatchGetCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand} from "@aws-sdk/lib-dynamodb";
import {getSignedUrl} from "@aws-sdk/s3-request-presigner";
import {buildPlanningSummary, buildPortfolioSummary, newId, reverseTimestamp} from "@teamspaces/domain";
import {
  assertMeetingPayloadSize,
  assertMeetingUpdate,
  assertWorkConfigurationUpdate,
  assertWorkItemConfiguration,
  assertWorkQueryConfiguration,
  defaultWorkConfiguration,
  maxMeetingParticipants,
  parseWorkConfigurationInput,
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
    GSI1SK: `START#${meeting.startsAt}#MEETING#${meeting.id}`
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
    correlationId: context.correlationId
  };
}

export class DynamoRepository {
  constructor({tableName, attachmentBucketName, workspaceId = "workspace-default", workIndexReady = true, documentClient = dynamo}) {
    this.tableName = tableName;
    this.attachmentBucketName = attachmentBucketName;
    this.workspaceId = workspaceId;
    this.workIndexReady = workIndexReady;
    this.workIndexMarkerReady = undefined;
    this.documentClient = documentClient;
  }

  now() {
    return new Date().toISOString();
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

  async recordActivity(context, projectId, entityType, entityId, eventType, fields, summary) {
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
      id
    });
    await this.documentClient.send(new PutCommand({TableName: this.tableName, Item: item}));
  }

  async queryByPk(pk, skPrefix, limit) {
    const result = await dynamo.send(new QueryCommand({
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

  async upsertMembership(context, input) {
    const now = this.now();
    const userId = input.userId ?? userIdFromEmail(input.email);
    const key = {PK: `WORKSPACE#${context.workspaceId}`, SK: `MEMBER#${userId}`};
    const existing = await dynamo.send(new GetCommand({TableName: this.tableName, Key: key}));
    const item = {
      ...key,
      workspaceId: context.workspaceId,
      userId,
      email: input.email,
      name: input.name,
      role: input.role,
      status: input.status,
      projectIds: input.projectIds ?? [],
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
    const item = {...existing.Item, ...definedValues(patch), version: Number(existing.Item.version ?? 1) + 1, updatedAt: this.now()};
    await dynamo.send(new PutCommand({TableName: this.tableName, Item: item}));
    await dynamo.send(new PutCommand({TableName: this.tableName, Item: accountIndexItem(item)}));
    await this.recordActivity(context, undefined, "membership", userId, "membership.updated", Object.keys(patch), `Updated member ${item.email}`);
    return {...itemWithoutKeys(item), user: {id: userId, email: item.email, name: item.name}};
  }

  async updateCurrentUserProfile(context, input) {
    const key = {PK: `WORKSPACE#${context.workspaceId}`, SK: `MEMBER#${context.actorId}`};
    const existing = await dynamo.send(new GetCommand({TableName: this.tableName, Key: key}));
    if (!existing.Item) throw new NotFoundError("Membership not found");
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
    const result = await dynamo.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: {":pk": gsiPk},
      ScanIndexForward: false,
      Limit: filters.limit ?? 100
    }));
    let projects = (result.Items ?? []).map(itemWithoutKeys);
    if (Array.isArray(filters.allowedProjectIds) && filters.allowedProjectIds.length) projects = projects.filter((project) => filters.allowedProjectIds.includes(project.id));
    for (const field of ["status", "health", "ownerId", "priority", "phase"]) {
      if (filters[field]) projects = projects.filter((project) => project[field] === filters[field]);
    }
    if (filters.search) {
      const needle = String(filters.search).toLowerCase();
      projects = projects.filter((project) => `${project.name} ${project.description ?? ""}`.toLowerCase().includes(needle));
    }
    return projects;
  }

  async getProject(id, workspaceId = "", allowedProjectIds = []) {
    const result = await dynamo.send(new GetCommand({TableName: this.tableName, Key: {PK: `PROJECT#${id}`, SK: "META"}}));
    if (!result.Item) throw new NotFoundError("Project not found");
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
    if (input.portfolioId) {
      const portfolio = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: {PK: `WORKSPACE#${context.workspaceId}`, SK: `PORTFOLIO#${input.portfolioId}`}}));
      if (!portfolio.Item) throw new ValidationError("portfolioId does not exist");
    }
    const now = this.now();
    const id = context.publicDemo?.projectIdPrefix
      ? `${context.publicDemo.projectIdPrefix}${newId()}`
      : newId();
    const item = {
      PK: `PROJECT#${id}`,
      SK: "META",
      id,
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
    await this.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        {Put: {TableName: this.tableName, Item: item, ConditionExpression: "attribute_not_exists(PK)"}},
        ...(projection ? [{Put: {TableName: this.tableName, Item: projection, ConditionExpression: "attribute_not_exists(PK)"}}] : []),
        ...(demoRegistry ? [{Put: {TableName: this.tableName, Item: demoRegistry, ConditionExpression: "attribute_not_exists(PK)"}}] : [])
      ]
    }));
    await this.recordActivity(context, id, "project", id, "project.created", ["name"], `Created project ${item.name}`);
    return itemWithoutKeys(item);
  }

  async patchProject(context, projectId, patch) {
    const existing = await dynamo.send(new GetCommand({TableName: this.tableName, Key: {PK: `PROJECT#${projectId}`, SK: "META"}}));
    if (!existing.Item) throw new NotFoundError("Project not found");
    if (existing.Item.workspaceId !== context.workspaceId) throw new NotFoundError("Project not found");
    const expectedVersion = Number(patch.version ?? existing.Item.version);
    if (expectedVersion !== Number(existing.Item.version)) throw new ConflictError();
    const item = {...existing.Item, ...patch, version: existing.Item.version + 1, updatedAt: this.now()};
    if (item.portfolioId) {
      const portfolio = await dynamo.send(new GetCommand({TableName: this.tableName, Key: {PK: `WORKSPACE#${context.workspaceId}`, SK: `PORTFOLIO#${item.portfolioId}`}}));
      if (!portfolio.Item) throw new ValidationError("portfolioId does not exist");
    }
    Object.assign(item, this.projectIndexAttrs(item));
    const oldProjectionKey = this.projectPortfolioProjectionKey(existing.Item);
    const projection = this.projectPortfolioProjection(item);
    const projectionMoved = oldProjectionKey && (!projection || oldProjectionKey.SK !== projection.SK);
    try {
      await dynamo.send(new TransactWriteCommand({
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
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const configuration = await this.getWorkConfiguration(context);
    const configuredInput = {
      ...input,
      type: input.type ?? configuration.defaultTypeId,
      status: input.status ?? configuration.defaultStatusId
    };
    assertWorkItemConfiguration(configuration, {
      type: configuredInput.type,
      status: configuredInput.status,
      role: context.membership?.role,
      creating: true
    });
    const now = this.now();
    const id = newId();
    const item = {
      PK: `PROJECT#${projectId}`,
      SK: `WORK#${id}`,
      GSI2PK: `WORKSPACE#${context.workspaceId}#ASSIGNEE#${configuredInput.assigneeId ?? context.actorId}`,
      GSI2SK: `DUE#${configuredInput.dueDate ?? "9999-12-31"}#WORK#${id}`,
      id,
      workspaceId: context.workspaceId,
      projectId,
      recordedMinutes: 0,
      rank: Date.now(),
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...configuredInput,
      reporterId: configuredInput.reporterId ?? context.actorId,
      assigneeId: configuredInput.assigneeId ?? context.actorId
    };
    item.GSI2PK = `WORKSPACE#${context.workspaceId}#ASSIGNEE#${item.assigneeId}`;
    Object.assign(item, this.workIndexAttrs(item));
    await this.documentClient.send(new PutCommand({TableName: this.tableName, Item: item}));
    await this.recordActivity(context, projectId, "work-item", id, "work.created", ["title"], `Created task ${item.title}`);
    return itemWithoutKeys(item);
  }

  async patchWorkItem(context, projectId, workItemId, patch) {
    await this.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    const key = {PK: `PROJECT#${projectId}`, SK: `WORK#${workItemId}`};
    const existing = await this.documentClient.send(new GetCommand({TableName: this.tableName, Key: key}));
    if (!existing.Item || existing.Item.workspaceId !== context.workspaceId) throw new NotFoundError("Task not found");
    const expectedVersion = Number(patch.version ?? existing.Item.version);
    if (expectedVersion !== Number(existing.Item.version)) throw new ConflictError();
    const item = {...existing.Item, ...patch, version: Number(existing.Item.version) + 1, updatedAt: this.now()};
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
    item.GSI2PK = `WORKSPACE#${context.workspaceId}#ASSIGNEE#${item.assigneeId}`;
    item.GSI2SK = `DUE#${item.dueDate ?? "9999-12-31"}#WORK#${item.id}`;
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
    await this.recordActivity(context, projectId, "work-item", workItemId, "work.updated", Object.keys(patch), `Updated task ${item.title}`);
    return itemWithoutKeys(item);
  }

  /** @param {Array<{PK: string, SK: string}>} keys */
  async batchGetExact(keys) {
    if (!keys.length) return [];
    let remaining = keys;
    const items = [];
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
    if (remaining.length) throw new Error("DynamoDB did not process all meeting reference checks");
    return items;
  }

  /**
   * @param {{workspaceId: string, membership?: {projectIds?: string[]}}} context
   * @param {{version: number, projectId: string, limit: number, cursor?: string}} query
   */
  async listMeetingsPage(context, query) {
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
    Object.assign(item, meetingIndexAttrs(item));
    assertMeetingPayloadSize(item);
    await this.assertMeetingParticipants(context, input.projectId, participantIds);
    assertMeetingPresenters(item);
    await this.assertMeetingWorkItems(context, input.projectId, item);
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
    if (patch.participantIds !== undefined || patch.agendaItems !== undefined) assertMeetingPresenters(item);
    if (patch.agendaItems !== undefined) await this.assertMeetingWorkItems(context, projectId, item);
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
    if (input.projectId) await this.getProject(input.projectId, context.workspaceId, context.membership?.projectIds);
    if (input.workItemId) {
      const items = await this.listPlanningWorkItems({workspaceId: context.workspaceId, allowedProjectIds: context.membership?.projectIds});
      if (!items.some((item) => item.id === input.workItemId)) throw new NotFoundError("Task not found");
    }
    const now = this.now();
    const id = newId();
    const item = {
      PK: `USER#${context.actorId}`,
      SK: `TIME#${input.entryDate}#${id}`,
      GSI1PK: input.projectId ? `PROJECT#${input.projectId}#TIME` : undefined,
      GSI1SK: `DATE#${input.entryDate}#TIME#${id}`,
      id,
      workspaceId: context.workspaceId,
      userId: context.actorId,
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...input
    };
    await dynamo.send(new PutCommand({TableName: this.tableName, Item: item}));
    await this.recordActivity(context, input.projectId, "time-entry", id, "time.created", ["durationMinutes"], `Recorded ${input.durationMinutes} minutes`);
    return itemWithoutKeys(item);
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
    return documents.map((document) => ({
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
    const pendingExpiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
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
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      uploadUrl: await getSignedUrl(s3, command, {
        expiresIn: 600,
        signableHeaders: new Set(["content-type"])
      }),
      uploadHeaders,
      document: itemWithoutKeys(document)
    };
  }

  async finalizeDocument(context, input) {
    if (!this.attachmentBucketName) throw new ValidationError("Attachment bucket is not configured");
    const document = await this.getDocument(input.documentId, input.projectId, context.workspaceId, context.membership?.projectIds);
    if (document.status === "ready") return document;
    if (document.status !== "pending") throw new ConflictError("Only pending documents can be finalized");
    if (Number(document.expiresAt ?? 0) <= Math.floor(Date.now() / 1000)) throw new ValidationError("Upload intent has expired");
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
      if (current.status === "ready") return current;
      throw new ConflictError("Document changed while it was being finalized");
    }
    await this.recordActivity(context, document.projectId, "document", document.id, "document.finalized", ["status"], `Finalized document ${document.name}`);
    return itemWithoutKeys(item);
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
    return itemWithoutKeys(item);
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
      document,
      downloadUrl: await getSignedUrl(s3, command, {expiresIn: 600}),
      expiresAt: Math.floor(Date.now() / 1000) + 600
    };
  }

  async listSavedViews(userId, workspaceId = "", limit) {
    return (await this.queryByPk(`USER#${userId}`, "SAVED_VIEW#", limit))
      .filter((view) => !workspaceId || view.workspaceId === workspaceId);
  }

  async createSavedView(context, input) {
    const now = this.now();
    const id = newId();
    const item = {PK: `USER#${context.actorId}`, SK: `SAVED_VIEW#${id}`, id, userId: context.actorId, workspaceId: context.workspaceId, version: 1, createdAt: now, updatedAt: now, ...input};
    await dynamo.send(new PutCommand({TableName: this.tableName, Item: item}));
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
