import {DescribeTableCommand, DynamoDBClient} from "@aws-sdk/client-dynamodb";
import {DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand} from "@aws-sdk/lib-dynamodb";

const cursorVersion = 1;

/** @type {string[]} */
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const markReady = args.includes("--mark-ready");
if (apply && markReady) throw new Error("--apply and --mark-ready are separate operations");

/** @param {string} name @param {string | undefined} fallback */
function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

/** @param {string} name @param {string} fallback @param {number} maximum */
function integerOption(name, fallback, maximum) {
  const value = Number(option(name, fallback));
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

/** @param {string | undefined} value @param {string} tableArn */
function decodeCursor(value, tableArn) {
  if (!value) return undefined;
  try {
    const envelope = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (envelope?.v !== cursorVersion || envelope.tableArn !== tableArn) throw new Error("scope mismatch");
    const key = envelope.key;
    if (typeof key?.PK !== "string" || typeof key?.SK !== "string") throw new Error("invalid key");
    return key;
  } catch {
    throw new Error("--cursor must be emitted for this exact DynamoDB table by this script");
  }
}

/** @param {Record<string, unknown> | undefined} value @param {string} tableArn */
function encodeCursor(value, tableArn) {
  return value
    ? Buffer.from(JSON.stringify({v: cursorVersion, tableArn, key: value})).toString("base64url")
    : undefined;
}

/** @param {Record<string, any>} item */
function requiredRecordFields(item) {
  for (const field of ["id", "workspaceId", "updatedAt"]) {
    if (typeof item?.[field] !== "string" || !item[field]) throw new Error(`Record ${item?.PK}/${item?.SK} is missing ${field}`);
  }
}

const tableName = option("--table", process.env.TABLE_NAME);
if (!tableName || !/^[A-Za-z0-9_.-]{3,255}$/.test(tableName)) {
  throw new Error("Set TABLE_NAME or pass --table with the exact DynamoDB table name");
}
const pageLimit = integerOption("--page-limit", "25", 100);
const maxPages = integerOption("--max-pages", markReady ? "100000" : "1", 100000);
const baseClient = new DynamoDBClient({});
const description = await baseClient.send(new DescribeTableCommand({TableName: tableName}));
const tableArn = description.Table?.TableArn;
if (!tableArn) throw new Error(`Unable to resolve the ARN for ${tableName}`);
let exclusiveStartKey = decodeCursor(option("--cursor", ""), tableArn);
if (markReady && exclusiveStartKey) throw new Error("--mark-ready must verify from the beginning of the table");
const client = DynamoDBDocumentClient.from(baseClient);
const workCounts = new Map();
const summary = {
  mode: apply ? "apply" : markReady ? "verify-and-mark" : "dry-run",
  tableArn,
  pages: 0,
  scanned: 0,
  workRows: 0,
  projectRows: 0,
  workRepairs: 0,
  projectRepairs: 0,
  projectionRepairs: 0,
  writes: 0
};

/** @param {Record<string, any>} item */
async function repairWork(item) {
  requiredRecordFields(item);
  if (typeof item.projectId !== "string" || !item.projectId) {
    throw new Error(`Work row ${item.PK}/${item.SK} is missing projectId`);
  }
  if (item.PK !== `PROJECT#${item.projectId}` || item.SK !== `WORK#${item.id}`) {
    throw new Error(`Work row ${item.PK}/${item.SK} does not match projectId/id`);
  }
  const gsiPk = `WORKSPACE#${item.workspaceId}#WORK`;
  const gsiSk = `UPDATED#${item.updatedAt}#PROJECT#${item.projectId}#WORK#${item.id}`;
  summary.workRows += 1;
  workCounts.set(item.workspaceId, Number(workCounts.get(item.workspaceId) ?? 0) + 1);
  if (item.GSI1PK === gsiPk && item.GSI1SK === gsiSk) return;
  summary.workRepairs += 1;
  summary.writes += 1;
  if (!apply) return;
  await client.send(new UpdateCommand({
    TableName: tableName,
    Key: {PK: item.PK, SK: item.SK},
    UpdateExpression: "SET #gsiPk = :gsiPk, #gsiSk = :gsiSk",
    ConditionExpression: "#workspaceId = :workspaceId AND #projectId = :projectId AND #id = :id AND #updatedAt = :updatedAt",
    ExpressionAttributeNames: {
      "#gsiPk": "GSI1PK",
      "#gsiSk": "GSI1SK",
      "#workspaceId": "workspaceId",
      "#projectId": "projectId",
      "#id": "id",
      "#updatedAt": "updatedAt"
    },
    ExpressionAttributeValues: {
      ":gsiPk": gsiPk,
      ":gsiSk": gsiSk,
      ":workspaceId": item.workspaceId,
      ":projectId": item.projectId,
      ":id": item.id,
      ":updatedAt": item.updatedAt
    }
  }));
}

/** @param {Record<string, any>} item */
async function repairProject(item) {
  requiredRecordFields(item);
  if (item.PK !== `PROJECT#${item.id}` || item.SK !== "META") {
    throw new Error(`Project row ${item.PK}/${item.SK} does not match id`);
  }
  if (typeof item.status !== "string" || !item.status) throw new Error(`Project ${item.PK} is missing status`);
  const gsiPk = `WORKSPACE#${item.workspaceId}#PROJECTS`;
  const gsiSk = `STATUS#${item.status}#UPDATED#${item.updatedAt}#PROJECT#${item.id}`;
  /** @type {Record<string, any> | undefined} */
  const projection = item.portfolioId
    ? {
      ...item,
      PK: `WORKSPACE#${item.workspaceId}`,
      SK: `PROJECT_PORTFOLIO#${item.portfolioId}#PROJECT#${item.id}`,
      GSI1PK: `WORKSPACE#${item.workspaceId}#PORTFOLIO#${item.portfolioId}#PROJECTS`,
      GSI1SK: gsiSk
    }
    : undefined;
  const existingProjection = projection
    ? (await client.send(new GetCommand({
      TableName: tableName,
      Key: {PK: projection.PK, SK: projection.SK},
      ConsistentRead: true
    }))).Item
    : undefined;
  const projectionReady = !projection || (
    existingProjection?.id === projection.id
    && existingProjection?.workspaceId === projection.workspaceId
    && existingProjection?.portfolioId === projection.portfolioId
    && existingProjection?.status === projection.status
    && existingProjection?.updatedAt === projection.updatedAt
    && existingProjection?.GSI1PK === projection.GSI1PK
    && existingProjection?.GSI1SK === projection.GSI1SK
  );
  const projectReady = item.GSI1PK === gsiPk && item.GSI1SK === gsiSk;
  summary.projectRows += 1;
  if (projectReady && projectionReady) return;
  if (!projectReady) summary.projectRepairs += 1;
  if (!projectionReady) summary.projectionRepairs += 1;
  summary.writes += 1;
  if (!apply) return;
  const values = {
    ":gsiPk": gsiPk,
    ":gsiSk": gsiSk,
    ":workspaceId": item.workspaceId,
    ":id": item.id,
    ":updatedAt": item.updatedAt
  };
  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: tableName,
          Key: {PK: item.PK, SK: item.SK},
          UpdateExpression: "SET #gsiPk = :gsiPk, #gsiSk = :gsiSk",
          ConditionExpression: "#workspaceId = :workspaceId AND #id = :id AND #updatedAt = :updatedAt",
          ExpressionAttributeNames: {
            "#gsiPk": "GSI1PK",
            "#gsiSk": "GSI1SK",
            "#workspaceId": "workspaceId",
            "#id": "id",
            "#updatedAt": "updatedAt"
          },
          ExpressionAttributeValues: values
        }
      },
      ...(projection ? [{Put: {TableName: tableName, Item: projection}}] : [])
    ]
  }));
}

for (let page = 0; page < maxPages; page += 1) {
  const result = await client.send(new ScanCommand({
    TableName: tableName,
    ExclusiveStartKey: exclusiveStartKey,
    Limit: pageLimit,
    ConsistentRead: true,
    FilterExpression: "begins_with(PK, :project) AND (begins_with(SK, :work) OR SK = :meta)",
    ExpressionAttributeValues: {":project": "PROJECT#", ":work": "WORK#", ":meta": "META"}
  }));
  summary.pages += 1;
  summary.scanned += Number(result.ScannedCount ?? 0);
  for (const item of result.Items ?? []) {
    if (item.SK === "META") await repairProject(item);
    else await repairWork(item);
  }
  exclusiveStartKey = result.LastEvaluatedKey;
  if (!exclusiveStartKey) break;
}

if (markReady) {
  if (exclusiveStartKey) throw new Error("Verification did not reach the end of the table; increase --max-pages");
  if (summary.workRepairs || summary.projectRepairs || summary.projectionRepairs) {
    throw new Error("Verification found repairs; apply them and complete a new zero-repair pass before marking ready");
  }
  for (const [workspaceId, canonicalCount] of workCounts) {
    let indexedCount = 0;
    /** @type {Record<string, any> | undefined} */
    let indexCursor;
    do {
      /** @type {any} */
      const result = await client.send(new QueryCommand({
        TableName: tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: {":pk": `WORKSPACE#${workspaceId}#WORK`},
        ExclusiveStartKey: indexCursor,
        Select: "COUNT"
      }));
      indexedCount += Number(result.Count ?? 0);
      indexCursor = result.LastEvaluatedKey;
    } while (indexCursor);
    if (indexedCount !== canonicalCount) {
      throw new Error(`Workspace ${workspaceId} has ${canonicalCount} canonical work rows but ${indexedCount} indexed rows`);
    }
  }
  await client.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: "SYSTEM#MIGRATION",
      SK: "WORK_INDEX_V1",
      status: "ready",
      tableArn,
      verifiedAt: new Date().toISOString(),
      workspaceCounts: Object.fromEntries(workCounts)
    }
  }));
}

console.log(JSON.stringify({
  ...summary,
  workspaceWorkRows: Object.fromEntries(workCounts),
  migrationMarkedReady: markReady,
  nextCursor: encodeCursor(exclusiveStartKey, tableArn)
}, null, 2));
if (!apply && summary.writes) {
  console.error("Dry run only. Re-run with --apply after reviewing the table, counts, and cursor.");
}
