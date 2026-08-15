// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {marshall} from "@aws-sdk/util-dynamodb";
import {parseMeetingInput} from "@teamspaces/contracts";
import {DynamoRepository, meetingIndexAttrs, meetingKey} from "../src/repositories/dynamo.js";

class FakeDocumentClient {
  constructor(responses = []) {
    this.responses = [...responses];
    this.commands = [];
  }

  async send(command) {
    this.commands.push(command);
    const response = this.responses.shift();
    if (typeof response === "function") return response(command, this);
    if (response instanceof Error) throw response;
    return response ?? {};
  }
}

function context(overrides = {}) {
  return {
    actorId: "user-admin",
    workspaceId: "workspace-one",
    correlationId: "correlation-one",
    membership: {role: "workspace-admin", projectIds: []},
    ...overrides
  };
}

function meetingItem(overrides = {}) {
  const meeting = {
    ...meetingKey("project-one", "meeting-one"),
    id: "meeting-one",
    workspaceId: "workspace-one",
    projectId: "project-one",
    title: "Delivery review",
    description: "",
    startsAt: "2026-08-20T14:00:00.000Z",
    endsAt: "2026-08-20T15:00:00.000Z",
    status: "draft",
    location: "",
    participantIds: ["user-admin"],
    agendaItems: [],
    minutes: "",
    createdBy: "user-admin",
    updatedBy: "user-admin",
    version: 1,
    createdAt: "2026-08-14T12:00:00.000Z",
    updatedAt: "2026-08-14T12:00:00.000Z",
    ...overrides
  };
  return {...meeting, ...meetingIndexAttrs(meeting)};
}

test("meeting rows are directly addressed and reuse GSI1 for chronological pages", () => {
  assert.deepEqual(meetingKey("project-one", "meeting-one"), {
    PK: "PROJECT#project-one",
    SK: "MEETING#meeting-one"
  });
  assert.deepEqual(meetingIndexAttrs({
    projectId: "project-one",
    id: "meeting-one",
    startsAt: "2026-08-20T14:00:00.000Z"
  }), {
    GSI1PK: "PROJECT#project-one#MEETINGS",
    GSI1SK: "START#2026-08-20T14:00:00.000Z#MEETING#meeting-one"
  });
});

test("presenter-less meeting inputs marshal with the production DynamoDB defaults", () => {
  const parsed = parseMeetingInput({
    projectId: "project-one",
    title: "Presenter optional",
    startsAt: "2026-08-20T14:00:00Z",
    endsAt: "2026-08-20T15:00:00Z",
    agendaItems: [{id: "agenda-one", title: "Unassigned topic"}]
  });
  assert.equal(Object.hasOwn(parsed.agendaItems[0], "presenterId"), false);
  assert.doesNotThrow(() => marshall(parsed));
});

test("Dynamo meeting pages use bounded query-bound GSI1 keyset cursors", async () => {
  const firstItem = meetingItem();
  const secondItem = meetingItem({
    id: "meeting-two",
    SK: "MEETING#meeting-two",
    startsAt: "2026-08-21T14:00:00.000Z"
  });
  Object.assign(secondItem, meetingIndexAttrs(secondItem));
  const client = new FakeDocumentClient([
    {Items: [firstItem, secondItem]},
    {Items: [secondItem]}
  ]);
  const repository = new DynamoRepository({tableName: "table-one", documentClient: client});
  repository.getProject = async () => ({id: "project-one"});
  const query = {version: 1, projectId: "project-one", limit: 1};
  const first = await repository.listMeetingsPage(context(), query);
  assert.equal(first.items.length, 1);
  assert.equal(first.pageInfo.hasNextPage, true);
  assert.ok(first.pageInfo.endCursor);
  assert.equal(client.commands[0] instanceof QueryCommand, true);
  assert.equal(client.commands[0].input.IndexName, "GSI1");
  assert.equal(client.commands[0].input.Limit, 2);
  assert.equal(client.commands[0].input.ExpressionAttributeValues[":pk"], "PROJECT#project-one#MEETINGS");

  const second = await repository.listMeetingsPage(context(), {...query, cursor: first.pageInfo.endCursor});
  assert.equal(second.items[0].id, "meeting-two");
  assert.deepEqual(client.commands[1].input.ExclusiveStartKey, {
    PK: firstItem.PK,
    SK: firstItem.SK,
    GSI1PK: firstItem.GSI1PK,
    GSI1SK: firstItem.GSI1SK
  });
});

test("Dynamo meeting creation validates project-scoped references and atomically writes activity", async () => {
  const membership = {
    PK: "WORKSPACE#workspace-one",
    SK: "MEMBER#user-admin",
    workspaceId: "workspace-one",
    userId: "user-admin",
    role: "workspace-admin",
    status: "active",
    projectIds: []
  };
  const workItem = {
    PK: "PROJECT#project-one",
    SK: "WORK#work-one",
    workspaceId: "workspace-one",
    projectId: "project-one",
    id: "work-one"
  };
  const client = new FakeDocumentClient([
    {Responses: {"table-one": [membership]}},
    {Responses: {"table-one": [workItem]}},
    {}
  ]);
  const repository = new DynamoRepository({tableName: "table-one", documentClient: client});
  repository.getProject = async () => ({id: "project-one"});
  const input = parseMeetingInput({
    projectId: "project-one",
    title: "Delivery review",
    startsAt: "2026-08-20T14:00:00Z",
    endsAt: "2026-08-20T15:00:00Z",
    participantIds: [],
    agendaItems: [{id: "agenda-one", title: "Plan", workItemIds: ["work-one"]}]
  });
  const created = await repository.createMeeting(context(), input);
  assert.equal(created.participantIds.includes("user-admin"), true);
  assert.equal(client.commands[0] instanceof BatchGetCommand, true);
  assert.deepEqual(client.commands[0].input.RequestItems["table-one"].Keys, [{
    PK: "WORKSPACE#workspace-one",
    SK: "MEMBER#user-admin"
  }]);
  assert.equal(client.commands[1] instanceof BatchGetCommand, true);
  assert.deepEqual(client.commands[1].input.RequestItems["table-one"].Keys, [{
    PK: "PROJECT#project-one",
    SK: "WORK#work-one"
  }]);
  assert.equal(client.commands[2] instanceof TransactWriteCommand, true);
  assert.equal(client.commands[2].input.TransactItems.length, 2);
  const [meetingWrite, activityWrite] = client.commands[2].input.TransactItems;
  assert.equal(meetingWrite.Put.ConditionExpression, "attribute_not_exists(PK) AND attribute_not_exists(SK)");
  assert.equal(meetingWrite.Put.Item.id, created.id);
  assert.equal(activityWrite.Put.Item.entityType, "meeting");
  assert.equal(activityWrite.Put.Item.entityId, created.id);
  assert.equal(activityWrite.Put.Item.eventType, "meeting.created");
});

test("Dynamo start-time patches rewrite GSI1SK and condition on the expected version", async () => {
  const current = meetingItem();
  const client = new FakeDocumentClient([{Item: current}, {}]);
  const repository = new DynamoRepository({tableName: "table-one", documentClient: client});
  repository.getProject = async () => ({id: "project-one"});
  const updated = await repository.patchMeeting(context(), "project-one", "meeting-one", {
    projectId: "project-one",
    version: 1,
    startsAt: "2026-08-20T14:30:00.000Z"
  });
  assert.equal(updated.version, 2);
  assert.equal(client.commands[0] instanceof GetCommand, true);
  assert.equal(client.commands[0].input.ConsistentRead, true);
  assert.equal(client.commands[1] instanceof TransactWriteCommand, true);
  const [meetingWrite, activityWrite] = client.commands[1].input.TransactItems;
  assert.equal(meetingWrite.Put.Item.GSI1SK, "START#2026-08-20T14:30:00.000Z#MEETING#meeting-one");
  assert.equal(meetingWrite.Put.ConditionExpression, "#version = :expectedVersion AND workspaceId = :workspaceId");
  assert.equal(meetingWrite.Put.ExpressionAttributeValues[":expectedVersion"], 1);
  assert.equal(activityWrite.Put.Item.entityType, "meeting");
  assert.equal(activityWrite.Put.Item.eventType, "meeting.updated");
});

test("Dynamo meeting patches reject stale versions before writing", async () => {
  const client = new FakeDocumentClient([{Item: meetingItem({version: 3})}]);
  const repository = new DynamoRepository({tableName: "table-one", documentClient: client});
  repository.getProject = async () => ({id: "project-one"});
  await assert.rejects(
    repository.patchMeeting(context(), "project-one", "meeting-one", {
      projectId: "project-one",
      version: 2,
      title: "Stale"
    }),
    /stale/
  );
  assert.equal(client.commands.some((command) => command instanceof TransactWriteCommand), false);
});

test("Dynamo idempotent creates store only a hashed claim and strongly replay the exact result", async () => {
  const membership = {
    PK: "WORKSPACE#workspace-one",
    SK: "MEMBER#user-admin",
    workspaceId: "workspace-one",
    userId: "user-admin",
    status: "active",
    projectIds: []
  };
  const client = new FakeDocumentClient([
    {},
    {Responses: {"table-one": [membership]}},
    {}
  ]);
  const repository = new DynamoRepository({tableName: "table-one", documentClient: client});
  repository.getProject = async () => ({id: "project-one"});
  const idempotencyKey = "meeting.create:secure-0001";
  const requestContext = context({idempotencyKey});
  const input = parseMeetingInput({
    projectId: "project-one",
    title: "Idempotent review",
    startsAt: "2026-08-20T14:00:00Z",
    endsAt: "2026-08-20T15:00:00Z"
  });
  const created = await repository.createMeeting(requestContext, input);
  assert.equal(client.commands[0] instanceof GetCommand, true);
  assert.equal(client.commands[0].input.ConsistentRead, true);
  assert.equal(client.commands[2] instanceof TransactWriteCommand, true);
  assert.equal(client.commands[2].input.TransactItems.length, 3);
  const claim = client.commands[2].input.TransactItems[2].Put.Item;
  assert.match(claim.SK, /^IDEMPOTENCY#MEETING_CREATE#[a-f0-9]{64}$/);
  assert.match(claim.keyHash, /^[a-f0-9]{64}$/);
  assert.match(claim.requestHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(claim).includes(idempotencyKey), false);
  assert.deepEqual(claim.result, created);
  assert.equal(Number.isInteger(claim.expiresAt), true);
  assert.equal(claim.expiresAt > Math.floor(Date.now() / 1000), true);

  client.responses.push({Item: claim});
  const replayed = await repository.createMeeting(requestContext, input);
  assert.deepEqual(replayed, created);
  assert.equal(client.commands.at(-1) instanceof GetCommand, true);
  assert.equal(client.commands.at(-1).input.ConsistentRead, true);
  assert.equal(client.commands.filter((command) => command instanceof TransactWriteCommand).length, 1);

  client.responses.push({Item: claim});
  await assert.rejects(
    repository.createMeeting(requestContext, {...input, title: "Different request"}),
    /different meeting request/
  );
  assert.equal(client.commands.filter((command) => command instanceof TransactWriteCommand).length, 1);
});

test("Dynamo idempotent create resolves a conditional transaction race by strongly replaying the winner", async () => {
  const membership = {
    PK: "WORKSPACE#workspace-one",
    SK: "MEMBER#user-admin",
    workspaceId: "workspace-one",
    userId: "user-admin",
    status: "active",
    projectIds: []
  };
  const transactionCancelled = Object.assign(new Error("conditional race"), {name: "TransactionCanceledException"});
  const client = new FakeDocumentClient([
    {},
    {Responses: {"table-one": [membership]}},
    (command, fake) => {
      const claim = command.input.TransactItems[2].Put.Item;
      fake.responses.unshift({Item: claim});
      throw transactionCancelled;
    }
  ]);
  const repository = new DynamoRepository({tableName: "table-one", documentClient: client});
  repository.getProject = async () => ({id: "project-one"});
  const input = parseMeetingInput({
    projectId: "project-one",
    title: "Racing review",
    startsAt: "2026-08-20T14:00:00Z",
    endsAt: "2026-08-20T15:00:00Z"
  });
  const replayed = await repository.createMeeting(context({idempotencyKey: "meeting.race:0001"}), input);
  assert.equal(replayed.title, "Racing review");
  assert.equal(client.commands.length, 4);
  assert.equal(client.commands[2] instanceof TransactWriteCommand, true);
  assert.equal(client.commands[3] instanceof GetCommand, true);
  assert.equal(client.commands[3].input.ConsistentRead, true);
});

test("Dynamo meeting update transaction failures preserve conflict mapping with no separate audit write", async () => {
  const transactionCancelled = Object.assign(new Error("entity condition failed"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{Code: "ConditionalCheckFailed"}, {Code: "None"}]
  });
  const client = new FakeDocumentClient([{Item: meetingItem()}, transactionCancelled]);
  const repository = new DynamoRepository({tableName: "table-one", documentClient: client});
  repository.getProject = async () => ({id: "project-one"});
  await assert.rejects(
    repository.patchMeeting(context(), "project-one", "meeting-one", {
      projectId: "project-one",
      version: 1,
      startsAt: "2026-08-20T14:30:00.000Z"
    }),
    /stale/
  );
  assert.equal(client.commands.length, 2);
  assert.equal(client.commands[1] instanceof TransactWriteCommand, true);
  assert.equal(client.commands[1].input.TransactItems.length, 2);
});

test("Dynamo meeting transactions do not misclassify capacity cancellation as a version conflict", async () => {
  const capacityFailure = Object.assign(new Error("capacity unavailable"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{Code: "ProvisionedThroughputExceeded"}, {Code: "None"}]
  });
  const client = new FakeDocumentClient([{Item: meetingItem()}, capacityFailure]);
  const repository = new DynamoRepository({tableName: "table-one", documentClient: client});
  repository.getProject = async () => ({id: "project-one"});
  await assert.rejects(
    repository.patchMeeting(context(), "project-one", "meeting-one", {
      projectId: "project-one",
      version: 1,
      startsAt: "2026-08-20T14:30:00.000Z"
    }),
    (error) => error === capacityFailure
  );
  assert.equal(client.commands[1] instanceof TransactWriteCommand, true);
});
