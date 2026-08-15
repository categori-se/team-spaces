// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {GetCommand, UpdateCommand} from "@aws-sdk/lib-dynamodb";
import {DynamoPublicDemoControl} from "../src/demo/public-demo-control.js";
import {publicDemoPointerKey, publicDemoWorkspaceId} from "../src/demo/public-demo.js";

class FakeDocumentClient {
  constructor(pointer) {
    this.pointer = pointer;
    this.commands = [];
    this.rejectUpdate = false;
  }

  async send(command) {
    this.commands.push(command);
    if (command instanceof GetCommand) return {Item: this.pointer};
    if (command instanceof UpdateCommand) {
      if (this.rejectUpdate) {
        const error = new Error("conditional conflict");
        error.name = "ConditionalCheckFailedException";
        throw error;
      }
      return {};
    }
    throw new Error(`Unsupported command ${command.constructor.name}`);
  }
}

function activePointer() {
  return {
    ...publicDemoPointerKey,
    activeSlot: "b",
    workspaceId: publicDemoWorkspaceId("b"),
    resetAt: "2026-08-14T05:00:00.000Z",
    nextResetAt: "2026-08-15T05:00:00.000Z",
    resetDate: "2026-08-14",
    seedVersion: "3",
    version: 9
  };
}

test("Dynamo demo control strongly reads the server-owned active pointer", async () => {
  const client = new FakeDocumentClient(activePointer());
  const control = new DynamoPublicDemoControl({tableName: "demo-table", documentClient: client});
  const active = await control.getActive();

  assert.equal(active.activeSlot, "b");
  assert.equal(active.workspaceId, publicDemoWorkspaceId("b"));
  assert.equal(client.commands[0] instanceof GetCommand, true);
  assert.deepEqual(client.commands[0].input.Key, publicDemoPointerKey);
  assert.equal(client.commands[0].input.ConsistentRead, true);
});

test("Dynamo demo quota atomically enforces global and create-specific daily caps", async () => {
  const pointer = activePointer();
  const client = new FakeDocumentClient(pointer);
  const control = new DynamoPublicDemoControl({
    tableName: "demo-table",
    documentClient: client,
    mutationLimit: 500,
    clock: () => new Date("2026-08-15T02:00:00.000Z")
  });

  await control.claimMutation({kind: "project", cap: 12}, pointer);
  const update = client.commands[0];
  assert.equal(update instanceof UpdateCommand, true);
  assert.deepEqual(update.input.Key, {
    PK: `WORKSPACE#${publicDemoWorkspaceId("b")}`,
    SK: "PUBLIC_DEMO_QUOTA#2026-08-14"
  });
  assert.match(update.input.ConditionExpression, /#total < :limit/);
  assert.match(update.input.ConditionExpression, /#counter < :entityLimit/);
  assert.equal(update.input.ExpressionAttributeNames["#counter"], "created_project");
  assert.equal(update.input.ExpressionAttributeValues[":limit"], 500);
  assert.equal(update.input.ExpressionAttributeValues[":entityLimit"], 12);

  client.rejectUpdate = true;
  await assert.rejects(
    control.claimMutation({kind: "project", cap: 12}, pointer),
    (error) => error?.status === 429 && /daily edit limit/.test(error.detail)
  );
});

test("demo quota stays in one bucket across midnight and advances with the 05:00 reset cycle", async () => {
  const pointer = activePointer();
  let now = new Date("2026-08-14T23:59:59.000Z");
  const client = new FakeDocumentClient(pointer);
  const control = new DynamoPublicDemoControl({
    tableName: "demo-table",
    documentClient: client,
    clock: () => now
  });

  await control.claimMutation({kind: "workItem"}, pointer);
  now = new Date("2026-08-15T04:59:59.000Z");
  await control.claimMutation({kind: "workItem"}, pointer);
  const beforeResetKeys = client.commands
    .filter((command) => command instanceof UpdateCommand)
    .map((command) => command.input.Key);
  assert.deepEqual(beforeResetKeys, [
    {PK: `WORKSPACE#${publicDemoWorkspaceId("b")}`, SK: "PUBLIC_DEMO_QUOTA#2026-08-14"},
    {PK: `WORKSPACE#${publicDemoWorkspaceId("b")}`, SK: "PUBLIC_DEMO_QUOTA#2026-08-14"}
  ]);

  now = new Date("2026-08-15T05:00:00.000Z");
  const nextPointer = {
    ...pointer,
    activeSlot: "a",
    workspaceId: publicDemoWorkspaceId("a"),
    resetDate: "2026-08-15"
  };
  await control.claimMutation({kind: "workItem"}, nextPointer);
  assert.deepEqual(client.commands.at(-1).input.Key, {
    PK: `WORKSPACE#${publicDemoWorkspaceId("a")}`,
    SK: "PUBLIC_DEMO_QUOTA#2026-08-15"
  });
});

test("Dynamo demo control fails closed for an invalid pointer", async () => {
  const client = new FakeDocumentClient({...activePointer(), activeSlot: "private"});
  const control = new DynamoPublicDemoControl({tableName: "demo-table", documentClient: client});
  await assert.rejects(
    control.getActive(),
    (error) => error?.status === 503 && /being prepared/.test(error.detail)
  );
});
