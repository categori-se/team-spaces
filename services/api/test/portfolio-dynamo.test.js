// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {GetCommand, PutCommand} from "@aws-sdk/lib-dynamodb";
import {roles} from "@teamspaces/contracts";
import {DynamoRepository} from "../src/repositories/dynamo.js";
import {route} from "../src/routes/router.js";

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

const context = {
  actorId: "demo-visitor",
  workspaceId: "public-demo-a",
  correlationId: "correlation-one",
  membership: {role: roles.admin}
};

test("portfolio routes discard server-owned fields before calling the repository", async () => {
  let receivedPatch;
  const result = await route({
    method: "PATCH",
    path: "/api/v1/demo/portfolios/portfolio-one",
    searchParams: new URLSearchParams(),
    context,
    body: {
      version: 3,
      name: "  Updated portfolio  ",
      PK: "SYSTEM#PUBLIC_DEMO",
      SK: "ACTIVE",
      workspaceId: "private-workspace",
      GSI1PK: "ATTACKER",
      GSI1SK: "ATTACKER"
    },
    repository: {
      async patchPortfolio(_context, portfolioId, patch) {
        receivedPatch = patch;
        return {id: portfolioId, ...patch};
      }
    }
  });

  assert.deepEqual(receivedPatch, {version: 3, name: "Updated portfolio"});
  assert.deepEqual(result, {id: "portfolio-one", version: 3, name: "Updated portfolio"});
});

test("portfolio patches preserve tenant keys and server-managed metadata", async () => {
  const existing = {
    PK: "WORKSPACE#public-demo-a",
    SK: "PORTFOLIO#portfolio-one",
    id: "portfolio-one",
    workspaceId: "public-demo-a",
    name: "Original portfolio",
    description: "Original description",
    archived: false,
    version: 3,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z"
  };
  const client = new FakeDocumentClient([{Item: existing}, {}]);
  const repository = new DynamoRepository({tableName: "demo-table", documentClient: client});
  repository.now = () => "2026-08-14T12:00:00.000Z";
  repository.recordActivity = async () => {};

  const updated = await repository.patchPortfolio(context, "portfolio-one", {
    version: 3,
    name: "Updated portfolio",
    description: "Updated description",
    archived: true,
    PK: "SYSTEM#PUBLIC_DEMO",
    SK: "ACTIVE",
    id: "active-pointer",
    workspaceId: "private-workspace",
    createdAt: "attacker-controlled",
    updatedAt: "attacker-controlled",
    GSI1PK: "ATTACKER",
    GSI1SK: "ATTACKER",
    GSI2PK: "ATTACKER",
    GSI2SK: "ATTACKER",
    activeSlot: "private-workspace",
    resetDate: "never"
  });

  assert.equal(client.commands[0] instanceof GetCommand, true);
  assert.deepEqual(client.commands[0].input.Key, {
    PK: "WORKSPACE#public-demo-a",
    SK: "PORTFOLIO#portfolio-one"
  });
  assert.equal(client.commands[1] instanceof PutCommand, true);
  assert.deepEqual(client.commands[1].input.Item, {
    PK: "WORKSPACE#public-demo-a",
    SK: "PORTFOLIO#portfolio-one",
    id: "portfolio-one",
    workspaceId: "public-demo-a",
    name: "Updated portfolio",
    description: "Updated description",
    archived: true,
    version: 4,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-14T12:00:00.000Z"
  });
  assert.equal(client.commands[1].input.ConditionExpression, "#version = :expectedVersion");
  assert.equal(client.commands[1].input.ExpressionAttributeValues[":expectedVersion"], 3);
  assert.deepEqual(updated, {
    id: "portfolio-one",
    workspaceId: "public-demo-a",
    name: "Updated portfolio",
    description: "Updated description",
    archived: true,
    version: 4,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-14T12:00:00.000Z"
  });
});
