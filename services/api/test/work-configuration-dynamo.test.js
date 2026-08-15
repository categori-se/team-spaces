// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {GetCommand, PutCommand} from "@aws-sdk/lib-dynamodb";
import {defaultWorkConfiguration, roles} from "@teamspaces/contracts";
import {
  defaultWorkConfigurationItem,
  DynamoRepository,
  workConfigurationItem,
  workConfigurationKey
} from "../src/repositories/dynamo.js";

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

function context(role = roles.admin) {
  return {
    actorId: "user-admin",
    workspaceId: "workspace-one",
    correlationId: "correlation-one",
    membership: {role}
  };
}

test("builds stable work configuration keys and server-managed items", () => {
  assert.deepEqual(workConfigurationKey("workspace-one"), {
    PK: "WORKSPACE#workspace-one",
    SK: "WORK_CONFIGURATION"
  });
  const item = workConfigurationItem("workspace-one", {
    ...structuredClone(defaultWorkConfiguration),
    PK: "untrusted",
    SK: "untrusted",
    workspaceId: "untrusted",
    version: 99
  }, {
    version: 2,
    now: "2026-08-13T12:00:00.000Z",
    actorId: "user-admin"
  });
  assert.equal(item.PK, "WORKSPACE#workspace-one");
  assert.equal(item.SK, "WORK_CONFIGURATION");
  assert.equal(item.workspaceId, "workspace-one");
  assert.equal(item.version, 2);
  assert.equal(item.updatedBy, "user-admin");
});

test("strongly reads configuration and falls back without persisting", async () => {
  const client = new FakeDocumentClient([{}]);
  const repository = new DynamoRepository({tableName: "table-one", documentClient: client});
  const configuration = await repository.getWorkConfiguration(context());
  assert.equal(configuration.version, defaultWorkConfiguration.version);
  assert.equal(configuration.workspaceId, "workspace-one");
  assert.equal(client.commands.length, 1);
  assert.equal(client.commands[0] instanceof GetCommand, true);
  assert.equal(client.commands[0].input.ConsistentRead, true);
  assert.deepEqual(client.commands[0].input.Key, workConfigurationKey("workspace-one"));
});

test("first customization conditionally creates the version after the virtual default", async () => {
  const client = new FakeDocumentClient([{}, {}]);
  const repository = new DynamoRepository({tableName: "table-one", documentClient: client});
  const activities = [];
  repository.recordActivity = async (...args) => activities.push(args);
  const input = structuredClone(defaultWorkConfiguration);
  input.types[0].label = `${input.types[0].label} updated`;

  const saved = await repository.patchWorkConfiguration(context(), input);
  assert.equal(saved.version, defaultWorkConfiguration.version + 1);
  assert.equal(client.commands[1] instanceof PutCommand, true);
  assert.equal(client.commands[1].input.ConditionExpression, "attribute_not_exists(PK)");
  assert.equal(client.commands[1].input.Item.version, defaultWorkConfiguration.version + 1);
  assert.equal(activities.length, 1);
  assert.equal(activities[0][4], "work-configuration.updated");
});

test("persisted configuration updates condition on the stored version", async () => {
  const existing = workConfigurationItem("workspace-one", defaultWorkConfiguration, {
    version: 4,
    now: "2026-08-12T12:00:00.000Z",
    actorId: "user-admin"
  });
  const client = new FakeDocumentClient([{Item: existing}, {}]);
  const repository = new DynamoRepository({tableName: "table-one", documentClient: client});
  repository.recordActivity = async () => {};
  const input = {...structuredClone(defaultWorkConfiguration), version: 4};

  const saved = await repository.patchWorkConfiguration(context(), input);
  assert.equal(saved.version, 5);
  assert.equal(client.commands[1].input.ConditionExpression, "#version = :expectedVersion");
  assert.equal(client.commands[1].input.ExpressionAttributeValues[":expectedVersion"], 4);
  assert.equal(client.commands[1].input.Item.createdAt, existing.createdAt);
});

test("repository updates preserve existing taxonomy identifiers", async () => {
  const client = new FakeDocumentClient([{}]);
  const repository = new DynamoRepository({tableName: "table-one", documentClient: client});
  const input = structuredClone(defaultWorkConfiguration);
  const removed = input.types.pop();
  assert.ok(removed);
  repository.recordActivity = async () => {};

  await assert.rejects(
    repository.patchWorkConfiguration(context(), input),
    new RegExp(`${removed.id} cannot be removed`)
  );
  assert.equal(client.commands.length, 1);
  assert.equal(client.commands[0] instanceof GetCommand, true);
});

test("configuration enforcement applies defaults and rejects role-forbidden transitions", async () => {
  const createClient = new FakeDocumentClient([{}, {}]);
  const createRepository = new DynamoRepository({tableName: "table-one", documentClient: createClient});
  createRepository.getProject = async () => ({id: "project-one"});
  createRepository.recordActivity = async () => {};
  const created = await createRepository.createWorkItem(context(), "project-one", {title: "Configured task"});
  assert.equal(created.type, defaultWorkConfiguration.defaultTypeId);
  assert.equal(created.status, defaultWorkConfiguration.defaultStatusId);

  const existingWork = {
    PK: "PROJECT#project-one",
    SK: "WORK#work-one",
    id: "work-one",
    workspaceId: "workspace-one",
    projectId: "project-one",
    title: "Configured task",
    type: defaultWorkConfiguration.defaultTypeId,
    status: defaultWorkConfiguration.defaultStatusId,
    assigneeId: "user-admin",
    version: 1,
    updatedAt: "2026-08-13T12:00:00.000Z"
  };
  const targetStatus = defaultWorkConfiguration.statuses.find((status) => status.id !== existingWork.status && status.active)?.id;
  assert.ok(targetStatus);
  const patchClient = new FakeDocumentClient([{Item: existingWork}, {}]);
  const patchRepository = new DynamoRepository({tableName: "table-one", documentClient: patchClient});
  patchRepository.getProject = async () => ({id: "project-one"});
  patchRepository.recordActivity = async () => {};
  await assert.rejects(
    patchRepository.patchWorkItem(context(roles.viewer), "project-one", "work-one", {version: 1, status: targetStatus}),
    /transition|role|allowed/i
  );
  assert.equal(patchClient.commands.some((command) => command instanceof PutCommand), false);
});

test("work queries reject taxonomy IDs missing from the workspace configuration", async () => {
  const client = new FakeDocumentClient([{}]);
  const repository = new DynamoRepository({tableName: "table-one", documentClient: client});
  await assert.rejects(
    repository.listWorkItemsPage({
      workspaceId: "workspace-one",
      type: "not-a-type",
      sort: "updated-desc",
      limit: 25
    }),
    /Expected one of/
  );
  assert.equal(client.commands.length, 1);
  assert.equal(client.commands[0].input.ConsistentRead, true);
});

test("default fallback is an isolated copy", () => {
  const first = defaultWorkConfigurationItem("workspace-one");
  const second = defaultWorkConfigurationItem("workspace-one");
  first.types[0].label = "Changed locally";
  assert.notEqual(first.types[0].label, second.types[0].label);
});
