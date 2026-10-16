// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {BatchGetCommand, PutCommand, TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {defaultWorkspaceCapabilities} from "@teamspaces/contracts";
import {DynamoRepository, notificationPreferencesKey, notificationReadKey} from "../src/repositories/dynamo.js";
import {MemoryRepository} from "../src/repositories/memory.js";
import {groupNotificationEvents, notificationDigestPeriod, notificationEvents, notificationScheduleHour, processScheduledNotificationDigests, workNotificationRecipients} from "../src/repositories/notifications.js";

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

const context = {workspaceId: "workspace-one", actorId: "user-one"};

test("derives and groups participation notifications without notifying the actor about their own edits", () => {
  const recipients = workNotificationRecipients({assigneeId: "user-one", accountableId: "user-two", watcherIds: ["user-one", "user-three"]});
  assert.deepEqual(recipients, [
    {userId: "user-one", reason: "assigned"},
    {userId: "user-two", reason: "accountable"},
    {userId: "user-one", reason: "watching"},
    {userId: "user-three", reason: "watching"}
  ]);
  const events = notificationEvents([
    {id: "activity-two", actorId: "user-two", projectId: "project-one", entityType: "work-item", entityId: "work-one", timestamp: "2026-08-27T12:01:00.000Z", summary: "Mentioned and updated", mentions: ["user-one"], notificationRecipients: recipients},
    {id: "activity-one", actorId: "user-one", projectId: "project-one", entityType: "work-item", entityId: "work-one", timestamp: "2026-08-27T12:00:00.000Z", summary: "Own update", notificationRecipients: recipients}
  ], {...context, allowedProjectIds: ["project-one"]}, {notifications: {participationRules: ["assigned", "watching"]}});
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].reasons, ["mention", "assigned", "watching"]);
  const grouped = groupNotificationEvents(events, {"activity-two": "2026-08-27T13:00:00.000Z"}, "read");
  assert.equal(grouped.groups.length, 1);
  assert.equal(grouped.groups[0].unreadCount, 0);
  assert.equal(grouped.summary.readCount, 1);
});

test("DynamoDB read markers are strongly read and tenant-user scoped", async () => {
  const marker = {
    ...notificationReadKey("workspace-one", "user-one", "activity-one"),
    workspaceId: "workspace-one",
    userId: "user-one",
    activityId: "activity-one",
    readAt: "2026-08-27T13:00:00.000Z"
  };
  const client = new FakeDocumentClient([{Responses: {notifications: [marker]}}, {}]);
  const repository = new DynamoRepository({tableName: "notifications", documentClient: client});
  repository.now = () => "2026-08-27T14:00:00.000Z";

  const states = await repository.getNotificationReadStates(context, ["activity-one"]);
  assert.deepEqual(states, {"activity-one": marker.readAt});
  assert.equal(client.commands[0] instanceof BatchGetCommand, true);
  assert.equal(client.commands[0].input.RequestItems.notifications.ConsistentRead, true);
  assert.deepEqual(client.commands[0].input.RequestItems.notifications.Keys[0], notificationReadKey("workspace-one", "user-one", "activity-one"));

  const saved = await repository.setNotificationReadStates(context, ["activity-one", "activity-two"], true);
  assert.equal(saved.count, 2);
  assert.equal(client.commands[1] instanceof TransactWriteCommand, true);
  assert.equal(client.commands[1].input.TransactItems.length, 2);
  assert.equal(client.commands[1].input.TransactItems[0].Put.Item.workspaceId, "workspace-one");
  assert.equal(client.commands[1].input.TransactItems[0].Put.Item.userId, "user-one");
  assert.equal(client.commands[1].input.TransactItems[0].Put.Item.expiresAt > 0, true);
});

test("DynamoDB unread mutations delete only the caller's markers", async () => {
  const client = new FakeDocumentClient([{}]);
  const repository = new DynamoRepository({tableName: "notifications", documentClient: client});
  await repository.setNotificationReadStates(context, ["activity-one"], false);
  assert.equal(client.commands[0] instanceof TransactWriteCommand, true);
  assert.deepEqual(client.commands[0].input.TransactItems[0].Delete.Key, notificationReadKey("workspace-one", "user-one", "activity-one"));
});

test("DynamoDB persists scheduled preferences on the sparse due-hour index", async () => {
  const capabilities = {...JSON.parse(JSON.stringify(defaultWorkspaceCapabilities)), PK: "WORKSPACE#workspace-one", SK: "CAPABILITIES", workspaceId: "workspace-one"};
  const client = new FakeDocumentClient([{}, {Item: capabilities}, {}, {}]);
  const repository = new DynamoRepository({tableName: "notifications", documentClient: client});
  repository.now = () => "2026-08-27T12:00:00.000Z";
  const saved = await repository.saveNotificationPreferences(context, {
    version: 1,
    participationRules: ["assigned"],
    projectOverrides: [],
    dateAlertsEnabled: true,
    emailDigest: "weekly",
    deliveryWebhookId: "mail",
    digestHourUtc: 13,
    weeklyDay: 5
  });
  assert.equal(saved.version, 2);
  assert.deepEqual(client.commands[0].input.Key, notificationPreferencesKey("workspace-one", "user-one"));
  assert.equal(client.commands[2] instanceof PutCommand, true);
  assert.equal(client.commands[2].input.Item.GSI2PK, "NOTIFICATION_SCHEDULE#HOUR#13");
  assert.equal(client.commands[2].input.Item.GSI2SK, "ACTIVE#WORKSPACE#workspace-one#USER#user-one");
  assert.equal(client.commands[2].input.ConditionExpression, "attribute_not_exists(PK)");
});

test("project-specific rules can mute participation without muting mentions", () => {
  const events = notificationEvents([{
    id: "activity-one",
    actorId: "user-two",
    projectId: "project-one",
    entityType: "work-item",
    entityId: "work-one",
    timestamp: "2026-08-27T12:00:00.000Z",
    mentions: ["user-one"],
    notificationRecipients: [{userId: "user-one", reason: "assigned"}]
  }], {...context, notificationPreferences: {participationRules: ["assigned"], projectOverrides: [{projectId: "project-one", participationRules: []}]}}, {});
  assert.deepEqual(events[0].reasons, ["mention"]);
});

test("scheduled digests use due-hour indexes and exactly-once period claims", async () => {
  const repository = new MemoryRepository();
  const bootstrap = await repository.getOrBootstrap({id: "user-demo-admin", email: "admin@team-spaces.example", name: "Admin"}, "workspace-default");
  const admin = {workspaceId: bootstrap.workspace.id, workspace: bootstrap.workspace, actorId: bootstrap.user.id, user: bootstrap.user, membership: bootstrap.membership, correlationId: "notification-test"};
  const capabilities = JSON.parse(JSON.stringify(defaultWorkspaceCapabilities));
  capabilities.webhooks = [{id: "mail-gateway", name: "Mail gateway", url: "https://mail.example.test/digests", enabled: true, eventTypes: ["notification.digest"]}];
  await repository.patchWorkspaceCapabilities(admin, capabilities);
  await repository.saveNotificationPreferences(admin, {
    version: 1,
    participationRules: ["assigned"],
    projectOverrides: [],
    dateAlertsEnabled: false,
    emailDigest: "daily",
    deliveryWebhookId: "mail-gateway",
    digestHourUtc: 13,
    weeklyDay: 1
  });
  repository.recordActivity({...admin, actorId: "user-product-engineer"}, "project-pilot", "work-item", "work-cognito", "work.updated", ["status"], "A participating task changed", {notificationRecipients: [{userId: admin.actorId, reason: "assigned"}]});
  const originalFetch = globalThis.fetch;
  const events = [];
  globalThis.fetch = async (_url, request) => {
    events.push({event: request.headers["x-team-spaces-event"], body: JSON.parse(request.body)});
    return {ok: true, status: 202};
  };
  try {
    const now = new Date("2026-08-27T13:05:00.000Z");
    assert.equal(notificationScheduleHour(now.getUTCHours()), "NOTIFICATION_SCHEDULE#HOUR#13");
    assert.equal(notificationDigestPeriod(await repository.getNotificationPreferences(admin), now), "daily#2026-08-27");
    const delivered = await processScheduledNotificationDigests(repository, now);
    assert.equal(delivered.results[0].status, "delivered");
    assert.equal(events[0].event, "notification.digest");
    assert.equal(events[0].body.payload.summary.notificationCount, 1);
    const replay = await processScheduledNotificationDigests(repository, now);
    assert.equal(replay.results[0].status, "already-processed");
    assert.equal(events.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
