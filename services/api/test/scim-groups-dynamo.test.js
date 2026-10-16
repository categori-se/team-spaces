// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {GetCommand, QueryCommand, TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {defaultWorkspaceCapabilities} from "@teamspaces/contracts";
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

test("atomically persists a SCIM group and membership projection", async () => {
  const capabilities = {
    PK: "WORKSPACE#workspace-one",
    SK: "CAPABILITIES",
    ...structuredClone(defaultWorkspaceCapabilities),
    workspaceId: "workspace-one",
    version: 1,
    createdAt: "2026-08-26T00:00:00.000Z"
  };
  capabilities.customFields.push({id: "region", name: "Region", type: "string", entityType: "group", required: true});
  const membership = {
    PK: "WORKSPACE#workspace-one",
    SK: "MEMBER#user-one",
    workspaceId: "workspace-one",
    userId: "user-one",
    email: "one@example.test",
    name: "User One",
    role: "viewer",
    status: "active",
    groupIds: [],
    version: 1
  };
  const client = new FakeDocumentClient([{Item: capabilities}, {Items: [membership]}, {}, {}]);
  const repository = new DynamoRepository({tableName: "table-one", documentClient: client});
  repository.now = () => "2026-08-27T12:00:00.000Z";
  const saved = await repository.saveScimGroup({workspaceId: "workspace-one", actorId: "scim-service", correlationId: "correlation-one"}, {
    id: "scim-team-one",
    externalId: "team-one",
    name: "Team One",
    memberIds: ["user-one"],
    customFields: {region: "NA"}
  });
  assert.equal(saved.group.id, "scim-team-one");
  assert.equal(client.commands[0] instanceof GetCommand, true);
  assert.equal(client.commands[1] instanceof QueryCommand, true);
  assert.equal(client.commands[2] instanceof TransactWriteCommand, true);
  assert.equal(client.commands[2].input.TransactItems.length, 2);
  assert.equal(client.commands[2].input.TransactItems[0].Put.Item.groups[0].managedBy, "scim");
  assert.deepEqual(client.commands[2].input.TransactItems[0].Put.Item.groups[0].customFields, {region: "NA"});
  assert.deepEqual(client.commands[2].input.TransactItems[1].Put.Item.groupIds, ["scim-team-one"]);
});
