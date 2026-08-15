// @ts-nocheck

import {DynamoDBClient} from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand
} from "@aws-sdk/lib-dynamodb";
import {reverseTimestamp} from "@teamspaces/domain";
import {
  createPublicDemoSeed,
  nextPublicDemoResetAt,
  publicDemoPointerKey,
  publicDemoResetCycleDate,
  publicDemoSlots,
  publicDemoWorkspaceId
} from "./public-demo.js";

const defaultDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const maxResetItems = 2500;
const maxResetPartitions = 64;
const maxBatchAttempts = 8;

function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, compact(item)]));
  }
  return value;
}

function accountIndexItem(membership) {
  return compact({
    PK: `USER#${membership.userId}`,
    SK: `ACCOUNT#${membership.workspaceId}`,
    workspaceId: membership.workspaceId,
    userId: membership.userId,
    email: membership.email,
    name: membership.name,
    title: membership.title,
    role: membership.role,
    status: membership.status,
    defaultAccount: membership.defaultAccount,
    projectIds: membership.projectIds ?? [],
    version: membership.version,
    createdAt: membership.createdAt,
    updatedAt: membership.updatedAt
  });
}

function projectIndex(project) {
  return {
    GSI1PK: `WORKSPACE#${project.workspaceId}#PROJECTS`,
    GSI1SK: `STATUS#${project.status}#UPDATED#${project.updatedAt}#PROJECT#${project.id}`
  };
}

function projectProjection(project) {
  if (!project.portfolioId) return undefined;
  return compact({
    ...project,
    PK: `WORKSPACE#${project.workspaceId}`,
    SK: `PROJECT_PORTFOLIO#${project.portfolioId}#PROJECT#${project.id}`,
    GSI1PK: `WORKSPACE#${project.workspaceId}#PORTFOLIO#${project.portfolioId}#PROJECTS`,
    GSI1SK: `STATUS#${project.status}#UPDATED#${project.updatedAt}#PROJECT#${project.id}`
  });
}

/**
 * Convert the domain-shaped demo seed to the same canonical rows maintained
 * by DynamoRepository. The reset path does not call user-facing mutations and
 * therefore creates no transient activity or random IDs.
 *
 * @param {ReturnType<typeof createPublicDemoSeed>} seed
 * @param {string} [seedVersion]
 */
export function publicDemoSeedItems(seed, seedVersion = "1") {
  const items = [];
  const workspace = seed.workspace;
  // The demo table is born fully indexed and every task write maintains the
  // workspace-work projection. Its own readiness marker lets Work Query use
  // bounded cursor pages immediately instead of the migration-only legacy
  // reader used by older authenticated installations.
  items.push(compact({
    PK: "SYSTEM#MIGRATION",
    SK: "WORK_INDEX_V1",
    status: "ready",
    source: "public-demo-reset",
    seedVersion,
    verifiedAt: workspace.updatedAt
  }));
  items.push(compact({PK: `WORKSPACE#${workspace.id}`, SK: "META", ...workspace}));

  for (const membership of seed.memberships) {
    items.push(compact({
      PK: `WORKSPACE#${membership.workspaceId}`,
      SK: `MEMBER#${membership.userId}`,
      ...membership
    }));
    items.push(accountIndexItem(membership));
  }

  for (const portfolio of seed.portfolios) {
    items.push(compact({
      PK: `WORKSPACE#${portfolio.workspaceId}`,
      SK: `PORTFOLIO#${portfolio.id}`,
      ...portfolio
    }));
  }

  const configuration = seed.workConfigurations[0];
  items.push(compact({
    PK: `WORKSPACE#${workspace.id}`,
    SK: "WORK_CONFIGURATION",
    ...configuration,
    updatedBy: seed.users[0].id
  }));

  for (const project of seed.projects) {
    const canonical = compact({PK: `PROJECT#${project.id}`, SK: "META", ...project, ...projectIndex(project)});
    items.push(canonical);
    const projection = projectProjection(project);
    if (projection) items.push(projection);
    items.push({
      PK: `WORKSPACE#${project.workspaceId}`,
      SK: `DEMO_PARTITION#PROJECT#${project.id}`,
      workspaceId: project.workspaceId,
      projectId: project.id,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    });
  }

  for (const workItem of seed.workItems) {
    items.push(compact({
      PK: `PROJECT#${workItem.projectId}`,
      SK: `WORK#${workItem.id}`,
      GSI1PK: `WORKSPACE#${workItem.workspaceId}#WORK`,
      GSI1SK: `UPDATED#${workItem.updatedAt}#PROJECT#${workItem.projectId}#WORK#${workItem.id}`,
      GSI2PK: `WORKSPACE#${workItem.workspaceId}#ASSIGNEE#${workItem.assigneeId}`,
      GSI2SK: `DUE#${workItem.dueDate ?? "9999-12-31"}#WORK#${workItem.id}`,
      ...workItem
    }));
  }

  for (const meeting of seed.meetings) {
    items.push(compact({
      PK: `PROJECT#${meeting.projectId}`,
      SK: `MEETING#${meeting.id}`,
      GSI1PK: `PROJECT#${meeting.projectId}#MEETINGS`,
      GSI1SK: `START#${meeting.startsAt}#MEETING#${meeting.id}`,
      ...meeting
    }));
  }

  for (const document of seed.documents) {
    items.push(compact({
      PK: `PROJECT#${document.projectId}`,
      SK: `DOCUMENT#${document.id}`,
      GSI1PK: `WORKSPACE#${document.workspaceId}#DOCUMENTS`,
      GSI1SK: `UPDATED#${document.updatedAt}#DOCUMENT#${document.id}`,
      ...document
    }));
  }

  for (const entry of seed.timeEntries) {
    items.push(compact({
      PK: `USER#${entry.userId}`,
      SK: `TIME#${entry.entryDate}#${entry.id}`,
      GSI1PK: entry.projectId ? `PROJECT#${entry.projectId}#TIME` : undefined,
      GSI1SK: `DATE#${entry.entryDate}#TIME#${entry.id}`,
      ...entry
    }));
  }

  for (const view of seed.savedViews) {
    items.push(compact({PK: `USER#${view.userId}`, SK: `SAVED_VIEW#${view.id}`, ...view}));
  }

  for (const activity of seed.activities) {
    const reversed = reverseTimestamp(activity.timestamp);
    items.push(compact({
      PK: activity.projectId ? `PROJECT#${activity.projectId}` : `WORKSPACE#${activity.workspaceId}`,
      SK: `ACTIVITY#${reversed}#${activity.id}`,
      GSI1PK: `WORKSPACE#${activity.workspaceId}#ACTIVITY`,
      GSI1SK: `TIME#${reversed}#${activity.id}`,
      reverseTimestamp: reversed,
      ...activity
    }));
  }

  const keys = new Set(items.map((item) => `${item.PK}\u0000${item.SK}`));
  if (keys.size !== items.length) throw new Error("Public demo seed contains duplicate DynamoDB keys");
  return items;
}

async function queryPartition(documentClient, tableName, pk, itemBudget) {
  const items = [];
  let exclusiveStartKey;
  do {
    const result = await documentClient.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: {":pk": pk},
      ConsistentRead: true,
      ExclusiveStartKey: exclusiveStartKey
    }));
    items.push(...(result.Items ?? []));
    if (items.length > itemBudget) throw new Error(`Public demo reset exceeded the ${itemBudget}-item safety ceiling`);
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

async function batchWriteAll(documentClient, tableName, requests, delay) {
  for (let offset = 0; offset < requests.length; offset += 25) {
    let pending = requests.slice(offset, offset + 25);
    for (let attempt = 0; pending.length && attempt < maxBatchAttempts; attempt += 1) {
      const result = await documentClient.send(new BatchWriteCommand({
        RequestItems: {[tableName]: pending}
      }));
      pending = result.UnprocessedItems?.[tableName] ?? [];
      if (pending.length) await delay(Math.min(1000, 25 * 2 ** attempt));
    }
    if (pending.length) throw new Error("Public demo reset could not complete all DynamoDB writes");
  }
}

function groupedKeys(items) {
  const groups = new Map();
  for (const item of items) {
    const group = groups.get(item.PK) ?? [];
    group.push({PK: item.PK, SK: item.SK});
    groups.set(item.PK, group);
  }
  return groups;
}

async function verifySeed(documentClient, tableName, seedItems) {
  const expectedByPartition = groupedKeys(seedItems);
  if (expectedByPartition.size > maxResetPartitions) throw new Error("Public demo seed has too many partitions");
  for (const [pk, expected] of expectedByPartition) {
    const actual = await queryPartition(documentClient, tableName, pk, maxResetItems);
    const actualKeys = new Set(actual.map((item) => `${item.PK}\u0000${item.SK}`));
    if (actualKeys.size !== expected.length) {
      throw new Error(`Public demo seed verification found an unexpected item count in ${pk}`);
    }
    for (const key of expected) {
      if (!actualKeys.has(`${key.PK}\u0000${key.SK}`)) {
        throw new Error(`Public demo seed verification failed for ${key.PK} / ${key.SK}`);
      }
    }
  }
}

/**
 * @param {{tableName: string, documentClient?: any, clock?: () => Date, seedVersion?: string, resetHourUtc?: number, delay?: (milliseconds: number) => Promise<void>}} options
 */
export function createPublicDemoResetHandler(options) {
  if (!options?.tableName) throw new Error("A public demo table name is required");
  const documentClient = options.documentClient ?? defaultDocumentClient;
  const tableName = options.tableName;
  const clock = options.clock ?? (() => new Date());
  const seedVersion = String(options.seedVersion ?? process.env.PUBLIC_DEMO_SEED_VERSION ?? "1");
  const resetHourUtc = Number(options.resetHourUtc ?? process.env.PUBLIC_DEMO_RESET_HOUR_UTC ?? 5);
  const delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  return async function reset(event = {}) {
    const now = clock();
    const resetCycle = publicDemoResetCycleDate(now, resetHourUtc);
    const pointerResult = await documentClient.send(new GetCommand({
      TableName: tableName,
      Key: publicDemoPointerKey,
      ConsistentRead: true
    }));
    const current = pointerResult.Item;
    if (!event.force && current?.resetDate === resetCycle && String(current.seedVersion) === seedVersion) {
      return {ok: true, changed: false, activeSlot: current.activeSlot, workspaceId: current.workspaceId, resetAt: current.resetAt};
    }

    const activeSlot = publicDemoSlots.includes(current?.activeSlot) ? current.activeSlot : undefined;
    const targetSlot = activeSlot === "a" ? "b" : "a";
    const targetSeed = createPublicDemoSeed(targetSlot, now);
    const seedItems = publicDemoSeedItems(targetSeed, seedVersion);
    if (seedItems.length > maxResetItems) throw new Error("Public demo seed exceeded its item safety ceiling");
    const workspacePk = `WORKSPACE#${publicDemoWorkspaceId(targetSlot)}`;

    // Read the workspace first because its registry and membership rows name
    // every other mutable partition. No GSI or table Scan is used.
    const workspaceItems = await queryPartition(documentClient, tableName, workspacePk, maxResetItems);
    const registeredProjectIds = workspaceItems
      .filter((item) => String(item.SK).startsWith("DEMO_PARTITION#PROJECT#"))
      .map((item) => item.projectId ?? String(item.SK).slice("DEMO_PARTITION#PROJECT#".length));
    const priorUserIds = workspaceItems
      .filter((item) => String(item.SK).startsWith("MEMBER#"))
      .map((item) => item.userId ?? String(item.SK).slice("MEMBER#".length));
    const projectIds = [...new Set([...registeredProjectIds, ...targetSeed.projects.map((project) => project.id)])];
    const userIds = [...new Set([...priorUserIds, ...targetSeed.users.map((user) => user.id)])];
    const partitionKeys = [
      workspacePk,
      ...projectIds.map((projectId) => `PROJECT#${projectId}`),
      ...userIds.map((userId) => `USER#${userId}`)
    ];
    if (partitionKeys.length > maxResetPartitions) throw new Error("Public demo reset discovered too many partitions");

    const childItems = [];
    for (const pk of partitionKeys.slice(1)) {
      childItems.push(...await queryPartition(
        documentClient,
        tableName,
        pk,
        maxResetItems - workspaceItems.length - childItems.length
      ));
    }
    if (workspaceItems.length + childItems.length > maxResetItems) {
      throw new Error("Public demo reset exceeded its item safety ceiling");
    }

    // Child partitions must be deleted before the workspace registry that
    // names them. If a batch fails, the registry remains available so the
    // next invocation can discover and finish every visitor-created child.
    await batchWriteAll(documentClient, tableName, childItems.map((item) => ({
      DeleteRequest: {Key: {PK: item.PK, SK: item.SK}}
    })), delay);
    await batchWriteAll(documentClient, tableName, workspaceItems.map((item) => ({
      DeleteRequest: {Key: {PK: item.PK, SK: item.SK}}
    })), delay);
    await batchWriteAll(documentClient, tableName, seedItems.map((item) => ({PutRequest: {Item: item}})), delay);
    await verifySeed(documentClient, tableName, seedItems);

    const nextPointer = {
      ...publicDemoPointerKey,
      activeSlot: targetSlot,
      workspaceId: targetSeed.workspace.id,
      resetAt: now.toISOString(),
      nextResetAt: nextPublicDemoResetAt(now, resetHourUtc),
      resetDate: resetCycle,
      seedVersion,
      version: Number(current?.version ?? 0) + 1
    };
    const put = {
      TableName: tableName,
      Item: nextPointer,
      ConditionExpression: current
        ? "#version = :expectedVersion AND #activeSlot = :expectedSlot"
        : "attribute_not_exists(PK) AND attribute_not_exists(SK)",
      ...(current ? {
        ExpressionAttributeNames: {"#version": "version", "#activeSlot": "activeSlot"},
        ExpressionAttributeValues: {":expectedVersion": Number(current.version ?? 1), ":expectedSlot": current.activeSlot}
      } : {})
    };
    try {
      await documentClient.send(new PutCommand(put));
    } catch (error) {
      if (error?.name !== "ConditionalCheckFailedException") throw error;
      const winner = await documentClient.send(new GetCommand({TableName: tableName, Key: publicDemoPointerKey, ConsistentRead: true}));
      if (winner.Item?.resetDate === resetCycle && String(winner.Item.seedVersion) === seedVersion) {
        return {ok: true, changed: false, activeSlot: winner.Item.activeSlot, workspaceId: winner.Item.workspaceId, resetAt: winner.Item.resetAt};
      }
      throw error;
    }
    return {
      ok: true,
      changed: true,
      activeSlot: targetSlot,
      workspaceId: targetSeed.workspace.id,
      resetAt: nextPointer.resetAt,
      nextResetAt: nextPointer.nextResetAt,
      itemCount: seedItems.length
    };
  };
}

export async function handler(event) {
  const physicalResourceId = event?.PhysicalResourceId ?? "team-spaces-public-demo-seed";
  if (event?.RequestType === "Delete") {
    return {PhysicalResourceId: physicalResourceId};
  }
  const result = await createPublicDemoResetHandler({
    tableName: process.env.TABLE_NAME,
    seedVersion: event?.ResourceProperties?.seedVersion ?? process.env.PUBLIC_DEMO_SEED_VERSION,
    resetHourUtc: Number(process.env.PUBLIC_DEMO_RESET_HOUR_UTC ?? 5)
  })(event);
  if (event?.RequestType === "Create" || event?.RequestType === "Update") {
    return {PhysicalResourceId: physicalResourceId, Data: result};
  }
  return result;
}
