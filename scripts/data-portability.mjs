import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {open} from "node:fs/promises";
import {
  BatchWriteItemCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  ScanCommand
} from "@aws-sdk/client-dynamodb";

export const dataExportSchemaVersion = 1;
export const dataExportFormat = "team-spaces.dynamodb-attribute-values";
// Increment when a release can no longer consume the prior persisted record
// model without a migration. The bundle-envelope version is independent.
export const dataModelVersion = 1;
export const maxPortableExportItems = 25_000;
export const maxPortableExportPayloadBytes = 64 * 1024 * 1024;
export const maxPortableExportFileBytes = maxPortableExportPayloadBytes + 1024 * 1024;

const packageMetadata = /** @type {{name?: string, version?: string}} */ (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
);
export const dataExportApplication = Object.freeze({
  id: "team-spaces",
  package: packageMetadata.name ?? "teamspaces",
  version: packageMetadata.version ?? "0.0.0",
  dataModelVersion
});

/** @param {unknown} value */
function isByteArray(value) {
  return value instanceof Uint8Array || ArrayBuffer.isView(value);
}

/** @param {unknown} value */
function encodeBinary(value) {
  if (!isByteArray(value)) throw new Error("DynamoDB binary attributes must be byte arrays");
  const view = /** @type {ArrayBufferView} */ (value);
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64");
}

/** @param {unknown} value */
function decodeBinary(value) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("DynamoDB binary attributes must contain canonical base64 text");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("DynamoDB binary attributes must contain canonical base64 text");
  }
  return Uint8Array.from(decoded);
}

/**
 * Convert the low-level SDK representation into DynamoDB's portable JSON form.
 * The SDK returns binary values as Uint8Array objects, which JSON.stringify
 * would otherwise turn into unusable numeric-key objects.
 *
 * @param {Record<string, any>} value
 * @returns {Record<string, any>}
 */
function encodeAttributeValue(value) {
  if (value.B !== undefined) return {B: encodeBinary(value.B)};
  if (value.BS !== undefined) return {BS: value.BS.map(encodeBinary)};
  if (value.M !== undefined) return {M: encodeItem(value.M)};
  if (value.L !== undefined) return {L: value.L.map(encodeAttributeValue)};
  return value;
}

/** @param {Record<string, any>} item @returns {Record<string, any>} */
function encodeItem(item) {
  return Object.fromEntries(Object.entries(item).map(([name, value]) => [name, encodeAttributeValue(value)]));
}

/** @param {Record<string, any>} value @returns {Record<string, any>} */
function decodeAttributeValue(value) {
  if (value.B !== undefined) return {B: decodeBinary(value.B)};
  if (value.BS !== undefined) return {BS: value.BS.map(decodeBinary)};
  if (value.M !== undefined) return {M: decodeItem(value.M)};
  if (value.L !== undefined) return {L: value.L.map(decodeAttributeValue)};
  return value;
}

/** @param {Record<string, any>} item @returns {Record<string, any>} */
function decodeItem(item) {
  return Object.fromEntries(Object.entries(item).map(([name, value]) => [name, decodeAttributeValue(value)]));
}

/** @param {string} serializedItems */
function checksumSerializedItems(serializedItems) {
  return createHash("sha256").update(serializedItems).digest("hex");
}

/** @param {unknown[]} items */
function serializedItems(items) {
  return JSON.stringify(items);
}

/** @param {unknown[]} items */
function assertPortablePayloadSize(items) {
  if (items.length > maxPortableExportItems) {
    throw new Error(`Portable export supports at most ${maxPortableExportItems} items; use DynamoDB Export to S3 for a larger installation`);
  }
  const serialized = serializedItems(items);
  const bytes = Buffer.byteLength(serialized);
  if (bytes > maxPortableExportPayloadBytes) {
    throw new Error(`Portable export payload exceeds ${maxPortableExportPayloadBytes} bytes; use DynamoDB Export to S3 for a larger installation`);
  }
  return {serialized, bytes};
}

/** @param {unknown[]} items */
export function dataExportChecksum(items) {
  return checksumSerializedItems(serializedItems(items));
}

/** @param {unknown} value */
function isAttributeMap(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const attributeTypes = new Set(["S", "N", "B", "SS", "NS", "BS", "M", "L", "NULL", "BOOL"]);
const dynamoNumber = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?$/;

/** @param {unknown} value @param {string} path */
function validateAttributeValue(value, path) {
  if (!isAttributeMap(value)) throw new Error(`${path} must be a DynamoDB AttributeValue object`);
  const attribute = /** @type {Record<string, any>} */ (value);
  const keys = Object.keys(attribute);
  if (keys.length !== 1 || !attributeTypes.has(keys[0])) {
    throw new Error(`${path} must contain exactly one supported DynamoDB AttributeValue type`);
  }
  const type = keys[0];
  const data = attribute[type];
  if (type === "S" && typeof data !== "string") throw new Error(`${path}.S must be a string`);
  if (type === "N" && (typeof data !== "string" || !dynamoNumber.test(data))) throw new Error(`${path}.N must be a DynamoDB number string`);
  if (type === "B") decodeBinary(data);
  if (type === "BOOL" && typeof data !== "boolean") throw new Error(`${path}.BOOL must be a boolean`);
  if (type === "NULL" && data !== true) throw new Error(`${path}.NULL must be true`);
  if (type === "L") {
    if (!Array.isArray(data)) throw new Error(`${path}.L must be an array`);
    data.forEach((entry, index) => validateAttributeValue(entry, `${path}.L[${index}]`));
  }
  if (type === "M") {
    if (!isAttributeMap(data)) throw new Error(`${path}.M must be an object`);
    for (const [name, entry] of Object.entries(data)) validateAttributeValue(entry, `${path}.M.${name}`);
  }
  if (type === "SS" || type === "NS" || type === "BS") {
    if (!Array.isArray(data) || data.length === 0) throw new Error(`${path}.${type} must be a non-empty array`);
    const normalized = data.map((entry, index) => {
      if (type === "SS" && typeof entry !== "string") throw new Error(`${path}.SS[${index}] must be a string`);
      if (type === "NS" && (typeof entry !== "string" || !dynamoNumber.test(entry))) throw new Error(`${path}.NS[${index}] must be a DynamoDB number string`);
      if (type === "BS") decodeBinary(entry);
      return String(entry);
    });
    if (new Set(normalized).size !== normalized.length) throw new Error(`${path}.${type} must not contain duplicates`);
  }
}

/**
 * Validate a portable export without converting DynamoDB AttributeValue data.
 * Keeping the low-level representation preserves numbers, binary values, sets,
 * and future fields exactly across export and import.
 *
 * @param {unknown} value
 */
export function validateDataExport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Export must be a JSON object");
  const payload = /** @type {Record<string, any>} */ (value);
  if (payload.schemaVersion !== dataExportSchemaVersion) throw new Error(`Unsupported export schemaVersion: ${payload.schemaVersion}`);
  if (payload.format !== dataExportFormat) throw new Error(`Unsupported export format: ${payload.format}`);
  if (payload.application?.id !== dataExportApplication.id) throw new Error(`Unsupported export application: ${payload.application?.id}`);
  if (payload.application?.dataModelVersion !== dataModelVersion) {
    throw new Error(`Unsupported dataModelVersion: ${payload.application?.dataModelVersion}`);
  }
  if (typeof payload.application?.version !== "string" || !payload.application.version) {
    throw new Error("Export application.version must be a non-empty string");
  }
  if (payload.application.release !== undefined && (typeof payload.application.release !== "string" || !payload.application.release)) {
    throw new Error("Export application.release must be a non-empty string when supplied");
  }
  const exportedAtTime = typeof payload.exportedAt === "string" ? Date.parse(payload.exportedAt) : Number.NaN;
  if (!Number.isFinite(exportedAtTime) || new Date(exportedAtTime).toISOString() !== payload.exportedAt) {
    throw new Error("Export exportedAt must be an ISO timestamp");
  }
  if (typeof payload.source?.tableName !== "string" || !payload.source.tableName) {
    throw new Error("Export source.tableName must be a non-empty string");
  }
  if (payload.source.region !== undefined && (typeof payload.source.region !== "string" || !payload.source.region)) {
    throw new Error("Export source.region must be a non-empty string when supplied");
  }
  if (!Array.isArray(payload.items)) throw new Error("Export items must be an array");
  if (!Number.isSafeInteger(payload.itemCount) || payload.itemCount !== payload.items.length) {
    throw new Error("Export itemCount does not match its item payload");
  }
  const {serialized, bytes} = assertPortablePayloadSize(payload.items);
  if (!Number.isSafeInteger(payload.payloadBytes) || payload.payloadBytes !== bytes) {
    throw new Error("Export payloadBytes does not match its item payload");
  }
  const keys = new Set();
  for (const [index, item] of payload.items.entries()) {
    if (!isAttributeMap(item) || typeof item.PK?.S !== "string" || typeof item.SK?.S !== "string") {
      throw new Error(`Export item ${index + 1} must contain string PK and SK attributes`);
    }
    const key = JSON.stringify([item.PK.S, item.SK.S]);
    if (!item.PK.S || !item.SK.S) throw new Error(`Export item ${index + 1} must contain non-empty PK and SK attributes`);
    if (keys.has(key)) throw new Error(`Export contains duplicate key ${item.PK.S} / ${item.SK.S}`);
    keys.add(key);
    for (const [name, attribute] of Object.entries(item)) {
      validateAttributeValue(attribute, `Export item ${index + 1}.${name}`);
    }
  }
  const expectedChecksum = checksumSerializedItems(serialized);
  if (payload.checksum?.algorithm !== "sha256" || payload.checksum?.value !== expectedChecksum) {
    throw new Error("Export checksum does not match its item payload");
  }
  return payload;
}

/**
 * @param {{send(command: unknown): Promise<any>}} client
 * @param {string} tableName
 * @param {{maxItems?: number, maxBytes?: number}} [options]
 */
export async function collectTableItems(client, tableName, {
  maxItems = maxPortableExportItems,
  maxBytes = maxPortableExportPayloadBytes
} = {}) {
  if (!tableName) throw new Error("TABLE_NAME is required");
  const items = [];
  let payloadBytes = 2; // Opening and closing JSON array brackets.
  let exclusiveStartKey;
  do {
    const page = await client.send(new ScanCommand({
      TableName: tableName,
      ConsistentRead: true,
      ...(exclusiveStartKey ? {ExclusiveStartKey: exclusiveStartKey} : {})
    }));
    const pageItems = (page.Items ?? []).map(encodeItem);
    if (items.length + pageItems.length > maxItems) {
      throw new Error(`Portable export supports at most ${maxItems} items; use DynamoDB Export to S3 for a larger installation`);
    }
    for (const item of pageItems) {
      const itemBytes = Buffer.byteLength(JSON.stringify(item)) + (items.length ? 1 : 0);
      if (payloadBytes + itemBytes > maxBytes) {
        throw new Error(`Portable export payload exceeds ${maxBytes} bytes; use DynamoDB Export to S3 for a larger installation`);
      }
      payloadBytes += itemBytes;
      items.push(item);
    }
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

/**
 * @param {{send(command: unknown): Promise<any>}} client
 * @param {{tableName: string, region?: string, now?: Date, release?: string}} options
 */
export async function createDataExport(client, {tableName, region = "", now = new Date(), release = ""}) {
  const items = await collectTableItems(client, tableName);
  const {serialized, bytes} = assertPortablePayloadSize(items);
  const payload = {
    schemaVersion: dataExportSchemaVersion,
    format: dataExportFormat,
    application: {
      ...dataExportApplication,
      ...(release ? {release} : {})
    },
    exportedAt: now.toISOString(),
    source: {tableName, ...(region ? {region} : {})},
    itemCount: items.length,
    payloadBytes: bytes,
    checksum: {algorithm: "sha256", value: checksumSerializedItems(serialized)},
    items
  };
  return validateDataExport(payload);
}

const expectedTableKeys = Object.freeze({PK: "HASH", SK: "RANGE"});
const expectedIndexes = Object.freeze({
  GSI1: Object.freeze({GSI1PK: "HASH", GSI1SK: "RANGE"}),
  GSI2: Object.freeze({GSI2PK: "HASH", GSI2SK: "RANGE"})
});

/** @param {any[] | undefined} actual @param {Record<string, string>} expected @param {string} label */
function assertKeySchema(actual, expected, label) {
  const entries = new Map((actual ?? []).map((entry) => [entry.AttributeName, entry.KeyType]));
  if (entries.size !== Object.keys(expected).length
    || Object.entries(expected).some(([name, type]) => entries.get(name) !== type)) {
    throw new Error(`Target table ${label} key schema is incompatible with Team Spaces`);
  }
}

/**
 * Confirm that an apply target has the physical table shape expected by the
 * current data-model version. This is deliberately read-only and runs before
 * the emptiness check or any BatchWriteItem request.
 *
 * @param {{send(command: unknown): Promise<any>}} client
 * @param {string} tableName
 */
export async function validateTargetTable(client, tableName) {
  if (!tableName) throw new Error("TABLE_NAME is required for target preflight");
  const described = await client.send(new DescribeTableCommand({TableName: tableName}));
  const table = /** @type {import("@aws-sdk/client-dynamodb").TableDescription | undefined} */ (described.Table);
  if (!table || table.TableStatus !== "ACTIVE") throw new Error("Target table must exist and be ACTIVE");

  const attributeTypes = new Map((table.AttributeDefinitions ?? []).map((entry) => [entry.AttributeName, entry.AttributeType]));
  for (const name of ["PK", "SK", "GSI1PK", "GSI1SK", "GSI2PK", "GSI2SK"]) {
    if (attributeTypes.get(name) !== "S") throw new Error(`Target table attribute ${name} must be defined as a string`);
  }
  assertKeySchema(table.KeySchema, expectedTableKeys, "primary");
  const indexes = new Map((table.GlobalSecondaryIndexes ?? []).map((index) => [index.IndexName, index]));
  for (const [indexName, expected] of Object.entries(expectedIndexes)) {
    const index = indexes.get(indexName);
    if (!index || index.IndexStatus !== "ACTIVE") throw new Error(`Target table index ${indexName} must exist and be ACTIVE`);
    assertKeySchema(index.KeySchema, expected, indexName);
    if (index.Projection?.ProjectionType !== "ALL") throw new Error(`Target table index ${indexName} must project ALL attributes`);
  }

  const ttlResult = await client.send(new DescribeTimeToLiveCommand({TableName: tableName}));
  const ttl = ttlResult.TimeToLiveDescription;
  if (ttl?.AttributeName !== "expiresAt" || !new Set(["ENABLED", "ENABLING"]).has(ttl.TimeToLiveStatus)) {
    throw new Error("Target table TTL must use expiresAt and be ENABLED or ENABLING");
  }
  return {tableArn: table.TableArn ?? "", tableName: table.TableName ?? tableName};
}

/**
 * @param {{send(command: unknown): Promise<any>}} client
 * @param {string} tableName
 */
export async function tableHasItems(client, tableName) {
  const result = await client.send(new ScanCommand({
    TableName: tableName,
    ConsistentRead: true,
    Limit: 1,
    Select: "COUNT"
  }));
  return Number(result.Count ?? 0) > 0;
}

/** @template T @param {T[]} values @param {number} size @returns {T[][]} */
function chunks(values, size) {
  /** @type {T[][]} */
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

/** @param {Record<string, any>} item */
function isTargetSpecificReadinessMarker(item) {
  return item.PK?.S === "SYSTEM#MIGRATION" && item.SK?.S === "WORK_INDEX_V1";
}

/** @param {unknown} value */
export function createDataImportPlan(value) {
  const payload = validateDataExport(value);
  const importableItems = /** @type {Record<string, any>[]} */ (payload.items)
    .filter((item) => !isTargetSpecificReadinessMarker(item));
  return {
    payload,
    importableItems,
    sourceItemCount: payload.items.length,
    importableItemCount: importableItems.length,
    skippedTargetMarkers: payload.items.length - importableItems.length,
    sourceChecksum: payload.checksum.value
  };
}

/** @param {string} inputPath */
export async function readDataImportPlan(inputPath) {
  if (!inputPath) throw new Error("Set IMPORT_PATH or pass an export file path");
  const handle = await open(inputPath, "r");
  try {
    const inputStats = await handle.stat();
    if (!inputStats.isFile()) throw new Error("Import path must be a regular file");
    if (inputStats.size > maxPortableExportFileBytes) {
      throw new Error(`Portable import file exceeds ${maxPortableExportFileBytes} bytes; use a table-scale DynamoDB migration for a larger installation`);
    }
    const contents = Buffer.alloc(inputStats.size);
    let offset = 0;
    while (offset < contents.length) {
      const {bytesRead} = await handle.read(contents, offset, contents.length - offset, offset);
      if (!bytesRead) throw new Error("Import file changed while it was being read");
      offset += bytesRead;
    }
    if ((await handle.stat()).size !== inputStats.size) throw new Error("Import file changed while it was being read");
    return createDataImportPlan(JSON.parse(contents.toString("utf8")));
  } finally {
    await handle.close();
  }
}

/**
 * Import an export into an empty table. Partial AWS failures remain visible: an
 * operator can recreate the target table and rerun, or explicitly opt into a
 * resume with allowNonEmpty after reviewing the already-written keys.
 *
 * @param {{send(command: unknown): Promise<any>}} client
 * @param {unknown} value
 * @param {{tableName: string, allowNonEmpty?: boolean, maxRetries?: number, pause?: (milliseconds: number) => Promise<void>}} options
 */
export async function importDataExport(client, value, {
  tableName,
  allowNonEmpty = false,
  maxRetries = 8,
  pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
}) {
  if (!tableName) throw new Error("TABLE_NAME is required for import");
  const plan = createDataImportPlan(value);
  const target = await validateTargetTable(client, tableName);
  if (!allowNonEmpty && await tableHasItems(client, tableName)) {
    throw new Error("Target table is not empty; import refused. Restore into a new table or pass --allow-nonempty after review");
  }

  let written = 0;
  for (const batch of chunks(plan.importableItems, 25)) {
    let pending = batch.map((Item) => ({PutRequest: {Item: decodeItem(Item)}}));
    for (let attempt = 0; pending.length; attempt += 1) {
      const result = await client.send(new BatchWriteItemCommand({RequestItems: {[tableName]: pending}}));
      pending = result.UnprocessedItems?.[tableName] ?? [];
      if (!pending.length) break;
      if (attempt >= maxRetries) throw new Error(`Import stopped with ${pending.length} unprocessed items after ${maxRetries + 1} attempts`);
      await pause(Math.min(1000, 25 * (2 ** attempt)));
    }
    written += batch.length;
  }
  return {
    written,
    sourceItemCount: plan.sourceItemCount,
    importableItemCount: plan.importableItemCount,
    skippedTargetMarkers: plan.skippedTargetMarkers,
    sourceChecksum: plan.sourceChecksum,
    targetTableArn: target.tableArn
  };
}
