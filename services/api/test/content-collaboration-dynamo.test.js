// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {GetCommand, QueryCommand, TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {DynamoRepository} from "../src/repositories/dynamo.js";

class FakeDocumentClient {
  constructor(responses = []) {
    this.responses = [...responses];
    this.commands = [];
  }

  async send(command) {
    this.commands.push(command);
    return this.responses.shift() ?? {};
  }
}

test("Dynamo collaboration transforms a stale edit and commits content, revision, and activity atomically", async () => {
  const current = {
    PK: "PROJECT#project-one",
    SK: "CONTENT#content-one",
    id: "content-one",
    workspaceId: "workspace-one",
    projectId: "project-one",
    kind: "wiki-page",
    title: "Shared note",
    body: "A base",
    format: "markdown",
    status: "published",
    tags: [],
    version: 2,
    createdAt: "2026-08-27T10:00:00.000Z",
    updatedAt: "2026-08-27T10:01:00.000Z"
  };
  const revisions = [
    {...current, PK: "CONTENT#content-one", SK: "REVISION#0000000002", collaborationOperation: [{insert: "A "}, {retain: 4}], collaborationKey: "browser-a:change-a"},
    {...current, PK: "CONTENT#content-one", SK: "REVISION#0000000001", body: "base", version: 1}
  ];
  const client = new FakeDocumentClient([{Item: current}, {Items: revisions}, {}]);
  const repository = new DynamoRepository({tableName: "table-one", documentClient: client});
  repository.getProject = async () => ({id: "project-one"});
  repository.now = () => "2026-08-27T10:02:00.000Z";

  const saved = await repository.applyProjectContentOperations({workspaceId: "workspace-one", actorId: "user-two", correlationId: "correlation-one"}, "project-one", "content-one", {
    version: 1,
    clientId: "browser-b",
    changeId: "change-b",
    operations: [{type: "insert", index: 0, text: "B "}]
  });

  assert.equal(saved.body, "A B base");
  assert.equal(saved.version, 3);
  assert.equal(saved.collaboration.merged, true);
  assert.equal(client.commands[0] instanceof GetCommand, true);
  assert.equal(client.commands[1] instanceof QueryCommand, true);
  assert.equal(client.commands[1].input.ConsistentRead, true);
  assert.equal(client.commands[2] instanceof TransactWriteCommand, true);
  const writes = client.commands[2].input.TransactItems;
  assert.equal(writes.length, 3);
  assert.equal(writes[0].Put.Item.body, "A B base");
  assert.equal(writes[0].Put.ExpressionAttributeValues[":version"], 2);
  assert.equal(writes[1].Put.Item.collaborationKey, "browser-b:change-b");
  assert.deepEqual(writes[1].Put.Item.collaborationOperation, [{retain: 2}, {insert: "B "}, {retain: 4}]);
  assert.equal(writes[2].Put.Item.eventType, "content.operations.applied");
});
