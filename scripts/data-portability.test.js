import assert from "node:assert/strict";
import {mkdtemp, open, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BatchWriteItemCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  ScanCommand
} from "@aws-sdk/client-dynamodb";
import {
  collectTableItems,
  createDataImportPlan,
  createDataExport,
  dataExportApplication,
  dataExportChecksum,
  importDataExport,
  maxPortableExportFileBytes,
  maxPortableExportItems,
  readDataImportPlan,
  validateDataExport
} from "./data-portability.mjs";

const item = (pk, sk) => ({PK: {S: pk}, SK: {S: sk}, version: {N: "1"}});

function payloadFor(items, overrides = {}) {
  return {
    schemaVersion: 1,
    format: "team-spaces.dynamodb-attribute-values",
    application: {...dataExportApplication},
    exportedAt: "2026-08-15T12:00:00.000Z",
    source: {tableName: "source", region: "us-east-1"},
    itemCount: items.length,
    payloadBytes: Buffer.byteLength(JSON.stringify(items)),
    checksum: {algorithm: "sha256", value: dataExportChecksum(items)},
    items,
    ...overrides
  };
}

const compatibleTable = {
  TableName: "target",
  TableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/target",
  TableStatus: "ACTIVE",
  AttributeDefinitions: ["PK", "SK", "GSI1PK", "GSI1SK", "GSI2PK", "GSI2SK"]
    .map((AttributeName) => ({AttributeName, AttributeType: "S"})),
  KeySchema: [
    {AttributeName: "PK", KeyType: "HASH"},
    {AttributeName: "SK", KeyType: "RANGE"}
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: "GSI1",
      IndexStatus: "ACTIVE",
      Projection: {ProjectionType: "ALL"},
      KeySchema: [
        {AttributeName: "GSI1PK", KeyType: "HASH"},
        {AttributeName: "GSI1SK", KeyType: "RANGE"}
      ]
    },
    {
      IndexName: "GSI2",
      IndexStatus: "ACTIVE",
      Projection: {ProjectionType: "ALL"},
      KeySchema: [
        {AttributeName: "GSI2PK", KeyType: "HASH"},
        {AttributeName: "GSI2SK", KeyType: "RANGE"}
      ]
    }
  ]
};

function targetPreflight(command, {count = 0} = {}) {
  if (command instanceof DescribeTableCommand) return {Table: structuredClone(compatibleTable)};
  if (command instanceof DescribeTimeToLiveCommand) {
    return {TimeToLiveDescription: {AttributeName: "expiresAt", TimeToLiveStatus: "ENABLED"}};
  }
  if (command instanceof ScanCommand) return {Count: count};
  return undefined;
}

test("exports every strongly consistent page in raw AttributeValue form", async () => {
  const commands = [];
  const client = {
    async send(command) {
      commands.push(command);
      if (commands.length === 1) return {Items: [item("WORKSPACE#a", "META")], LastEvaluatedKey: {PK: {S: "next"}, SK: {S: "next"}}};
      return {Items: [item("PROJECT#p", "META")]};
    }
  };
  const payload = await createDataExport(client, {tableName: "source", region: "us-east-1", now: new Date("2026-08-15T12:00:00Z")});
  assert.equal(commands.every((command) => command instanceof ScanCommand), true);
  assert.equal(commands.every((command) => command.input.ConsistentRead === true), true);
  assert.deepEqual(payload.items, [item("WORKSPACE#a", "META"), item("PROJECT#p", "META")]);
  assert.deepEqual(payload.application, dataExportApplication);
  assert.equal(payload.payloadBytes, Buffer.byteLength(JSON.stringify(payload.items)));
  assert.equal(payload.checksum.value, dataExportChecksum(payload.items));
  assert.equal(validateDataExport(payload), payload);
});

test("round-trips binary attributes through portable base64 JSON", async () => {
  const binaryItem = {
    ...item("BINARY", "META"),
    blob: {B: Uint8Array.from([0, 1, 2, 255])},
    nested: {M: {values: {BS: [Uint8Array.from([3, 4]), Uint8Array.from([5])]}}}
  };
  const exportClient = {send: async () => ({Items: [binaryItem]})};
  const payload = await createDataExport(exportClient, {tableName: "source"});
  assert.equal(payload.items[0].blob.B, "AAEC/w==");
  assert.deepEqual(payload.items[0].nested.M.values.BS, ["AwQ=", "BQ=="]);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(payload)));

  let writtenItem;
  const importClient = {
    async send(command) {
      const preflight = targetPreflight(command);
      if (preflight) return preflight;
      writtenItem = command.input.RequestItems.target[0].PutRequest.Item;
      return {UnprocessedItems: {}};
    }
  };
  await importDataExport(importClient, JSON.parse(JSON.stringify(payload)), {tableName: "target"});
  assert.deepEqual(writtenItem, binaryItem);
});

test("rejects corrupt and duplicate exports before writing", () => {
  const duplicateItems = [item("A", "B"), item("A", "B")];
  const payload = payloadFor(duplicateItems);
  assert.throws(() => validateDataExport(payload), /duplicate key/);
  const corrupt = payloadFor([item("A", "B")]);
  assert.throws(() => validateDataExport({...corrupt, checksum: {algorithm: "sha256", value: "0".repeat(64)}}), /checksum/);
});

test("rejects malformed AttributeValues before any target write", async () => {
  const items = [{...item("A", "B"), bad: {B: {0: 1, 1: 2}}}];
  const payload = payloadFor(items);
  let calls = 0;
  const client = {send: async () => { calls += 1; return {Count: 0}; }};
  await assert.rejects(importDataExport(client, payload, {tableName: "target"}), /base64/);
  assert.equal(calls, 0);
});

test("imports in 25-item batches and retries only unprocessed requests", async () => {
  const items = Array.from({length: 27}, (_, index) => item(`PK#${index}`, "META"));
  const payload = payloadFor(items);
  const writes = [];
  const client = {
    async send(command) {
      const preflight = targetPreflight(command);
      if (preflight) return preflight;
      assert.ok(command instanceof BatchWriteItemCommand);
      writes.push(command.input.RequestItems.target);
      if (writes.length === 1) return {UnprocessedItems: {target: [writes[0][0]]}};
      return {UnprocessedItems: {}};
    }
  };
  const result = await importDataExport(client, payload, {tableName: "target", pause: async () => undefined});
  assert.equal(result.written, 27);
  assert.equal(result.sourceItemCount, 27);
  assert.equal(result.importableItemCount, 27);
  assert.equal(result.sourceChecksum, payload.checksum.value);
  assert.equal(result.targetTableArn, compatibleTable.TableArn);
  assert.deepEqual(writes.map((batch) => batch.length), [25, 1, 2]);
});

test("refuses a nonempty target unless the operator explicitly opts in", async () => {
  const items = [item("A", "B")];
  const payload = payloadFor(items);
  const client = {send: async (command) => targetPreflight(command, {count: 1}) ?? {}};
  await assert.rejects(importDataExport(client, payload, {tableName: "target"}), /Target table is not empty/);
});

test("does not carry the source table work-index readiness marker into a target", async () => {
  const items = [
    item("PROJECT#p", "META"),
    {...item("SYSTEM#MIGRATION", "WORK_INDEX_V1"), status: {S: "ready"}, tableArn: {S: "source"}}
  ];
  const payload = payloadFor(items);
  const writes = [];
  const client = {
    async send(command) {
      const preflight = targetPreflight(command);
      if (preflight) return preflight;
      writes.push(...command.input.RequestItems.target.map((request) => request.PutRequest.Item));
      return {UnprocessedItems: {}};
    }
  };
  const result = await importDataExport(client, payload, {tableName: "target"});
  assert.equal(result.written, 1);
  assert.equal(result.sourceItemCount, 2);
  assert.equal(result.importableItemCount, 1);
  assert.equal(result.skippedTargetMarkers, 1);
  assert.equal(result.sourceChecksum, payload.checksum.value);
  assert.equal("checksum" in result, false);
  assert.deepEqual(writes, [item("PROJECT#p", "META")]);
});

test("round-trips every current DynamoDB AttributeValue variant", async () => {
  const bytes = Uint8Array.from([0, 127, 255]);
  const source = {
    PK: {S: "ALL-TYPES"},
    SK: {S: "META"},
    string: {S: "text"},
    number: {N: "-1.2300E+4"},
    binary: {B: bytes},
    strings: {SS: ["a", "b"]},
    numbers: {NS: ["1", "-2.00"]},
    binaries: {BS: [bytes, Uint8Array.from([4])]},
    map: {M: {enabled: {BOOL: true}}},
    list: {L: [{NULL: true}, {S: "value"}]},
    null: {NULL: true},
    boolean: {BOOL: false}
  };
  const exported = await createDataExport({send: async () => ({Items: [source]})}, {tableName: "source"});
  let written;
  const client = {
    async send(command) {
      const preflight = targetPreflight(command);
      if (preflight) return preflight;
      written = command.input.RequestItems.target[0].PutRequest.Item;
      return {UnprocessedItems: {}};
    }
  };
  await importDataExport(client, JSON.parse(JSON.stringify(exported)), {tableName: "target"});
  assert.deepEqual(written, source);
});

test("uses a structured composite identity when checking duplicate keys", () => {
  const items = [
    item("a\u0000b", "c"),
    item("a", "b\u0000c")
  ];
  assert.doesNotThrow(() => validateDataExport(payloadFor(items)));
});

test("requires compatible application metadata and canonical binary text", () => {
  const valid = payloadFor([item("A", "B")]);
  assert.throws(
    () => validateDataExport({...valid, application: {...valid.application, dataModelVersion: 999}}),
    /dataModelVersion/
  );
  const noncanonical = [{...item("A", "B"), binary: {B: "AB=="}}];
  assert.throws(() => validateDataExport(payloadFor(noncanonical)), /canonical base64/);
});

test("builds a local import plan with explicit source and importable semantics", () => {
  const payload = payloadFor([
    item("PROJECT#p", "META"),
    item("SYSTEM#MIGRATION", "WORK_INDEX_V1")
  ]);
  const plan = createDataImportPlan(payload);
  assert.deepEqual({
    sourceItemCount: plan.sourceItemCount,
    importableItemCount: plan.importableItemCount,
    skippedTargetMarkers: plan.skippedTargetMarkers,
    sourceChecksum: plan.sourceChecksum
  }, {
    sourceItemCount: 2,
    importableItemCount: 1,
    skippedTargetMarkers: 1,
    sourceChecksum: payload.checksum.value
  });
});

test("stops an oversized portable export at the item ceiling", async () => {
  const tooMany = Array.from({length: maxPortableExportItems + 1}, () => item("A", "B"));
  const client = {send: async () => ({Items: tooMany})};
  await assert.rejects(createDataExport(client, {tableName: "source"}), /DynamoDB Export to S3/);
});

test("stops collection as soon as the portable byte ceiling is crossed", async () => {
  const client = {send: async () => ({Items: [{...item("A", "B"), text: {S: "x".repeat(100)}}]})};
  await assert.rejects(
    collectTableItems(client, "source", {maxBytes: 64}),
    /payload exceeds 64 bytes/
  );
});

test("rejects an incompatible target before the emptiness check or a write", async () => {
  const payload = payloadFor([item("A", "B")]);
  const commands = [];
  const client = {
    async send(command) {
      commands.push(command);
      if (command instanceof DescribeTableCommand) {
        const incompatible = structuredClone(compatibleTable);
        incompatible.GlobalSecondaryIndexes = incompatible.GlobalSecondaryIndexes.filter((index) => index.IndexName !== "GSI2");
        return {Table: incompatible};
      }
      throw new Error("No command may follow a failed table-schema preflight");
    }
  };
  await assert.rejects(importDataExport(client, payload, {tableName: "target"}), /GSI2/);
  assert.equal(commands.length, 1);
  assert.ok(commands[0] instanceof DescribeTableCommand);
});

test("rejects an incompatible TTL before the emptiness check or a write", async () => {
  const payload = payloadFor([item("A", "B")]);
  const commands = [];
  const client = {
    async send(command) {
      commands.push(command);
      if (command instanceof DescribeTableCommand) return {Table: structuredClone(compatibleTable)};
      if (command instanceof DescribeTimeToLiveCommand) {
        return {TimeToLiveDescription: {AttributeName: "other", TimeToLiveStatus: "ENABLED"}};
      }
      throw new Error("No command may follow a failed TTL preflight");
    }
  };
  await assert.rejects(importDataExport(client, payload, {tableName: "target"}), /TTL/);
  assert.deepEqual(commands.map((command) => command.constructor), [DescribeTableCommand, DescribeTimeToLiveCommand]);
});

test("reads a bounded import file into the same local dry-run plan", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "team-spaces-portability-"));
  try {
    const inputPath = path.join(directory, "records.json");
    const payload = payloadFor([
      item("PROJECT#p", "META"),
      item("SYSTEM#MIGRATION", "WORK_INDEX_V1")
    ]);
    await writeFile(inputPath, JSON.stringify(payload));
    const plan = await readDataImportPlan(inputPath);
    assert.equal(plan.sourceItemCount, 2);
    assert.equal(plan.importableItemCount, 1);
    assert.equal(plan.skippedTargetMarkers, 1);
    assert.equal(plan.sourceChecksum, payload.checksum.value);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test("rejects an oversized import file before reading its contents", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "team-spaces-portability-"));
  try {
    const inputPath = path.join(directory, "oversized.json");
    const handle = await open(inputPath, "w");
    try {
      await handle.truncate(maxPortableExportFileBytes + 1);
    } finally {
      await handle.close();
    }
    await assert.rejects(readDataImportPlan(inputPath), /Portable import file exceeds/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
