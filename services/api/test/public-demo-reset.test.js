// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand
} from "@aws-sdk/lib-dynamodb";
import {
  createPublicDemoResetHandler,
  handler as resetEntryPoint,
  publicDemoSeedItems
} from "../src/demo/reset-handler.js";
import {
  createPublicDemoSeed,
  publicDemoPointerKey,
  publicDemoWorkspaceId
} from "../src/demo/public-demo.js";

function keyString(key) {
  return `${key.PK}\u0000${key.SK}`;
}

class FakeDocumentClient {
  constructor({pageSize = 4, failSeedBatch = false, failBeforeDeletePk} = {}) {
    this.items = new Map();
    this.pageSize = pageSize;
    this.failSeedBatch = failSeedBatch;
    this.failBeforeDeletePk = failBeforeDeletePk;
    this.commands = [];
  }

  put(item) {
    this.items.set(keyString(item), structuredClone(item));
  }

  get(key) {
    return this.items.get(keyString(key));
  }

  async send(command) {
    this.commands.push(command.constructor.name);
    const input = command.input;
    if (command instanceof GetCommand) {
      const item = this.get(input.Key);
      return {Item: item ? structuredClone(item) : undefined};
    }
    if (command instanceof QueryCommand) {
      const pk = input.ExpressionAttributeValues[":pk"];
      const all = [...this.items.values()]
        .filter((item) => item.PK === pk)
        .sort((a, b) => String(a.SK).localeCompare(String(b.SK)));
      const start = input.ExclusiveStartKey
        ? all.findIndex((item) => keyString(item) === keyString(input.ExclusiveStartKey)) + 1
        : 0;
      const items = all.slice(start, start + this.pageSize).map((item) => structuredClone(item));
      const last = all[start + this.pageSize - 1];
      return {
        Items: items,
        ...(start + this.pageSize < all.length && last ? {LastEvaluatedKey: {PK: last.PK, SK: last.SK}} : {})
      };
    }
    if (command instanceof BatchWriteCommand) {
      const requests = Object.values(input.RequestItems)[0];
      if (this.failSeedBatch && requests.some((request) => request.PutRequest)) {
        throw new Error("simulated seed failure");
      }
      for (const request of requests) {
        if (request.PutRequest) this.put(request.PutRequest.Item);
        if (request.DeleteRequest) {
          if (request.DeleteRequest.Key.PK === this.failBeforeDeletePk) {
            this.failBeforeDeletePk = undefined;
            throw new Error("simulated child cleanup failure");
          }
          this.items.delete(keyString(request.DeleteRequest.Key));
        }
      }
      return {};
    }
    if (command instanceof PutCommand) {
      const current = this.get(input.Item);
      if (input.ConditionExpression?.includes("attribute_not_exists") && current) {
        const error = new Error("conditional conflict");
        error.name = "ConditionalCheckFailedException";
        throw error;
      }
      if (input.ConditionExpression?.includes("#version")) {
        const expectedVersion = input.ExpressionAttributeValues[":expectedVersion"];
        const expectedSlot = input.ExpressionAttributeValues[":expectedSlot"];
        if (!current || current.version !== expectedVersion || current.activeSlot !== expectedSlot) {
          const error = new Error("conditional conflict");
          error.name = "ConditionalCheckFailedException";
          throw error;
        }
      }
      this.put(input.Item);
      return {};
    }
    throw new Error(`Unsupported command ${command.constructor.name}`);
  }
}

test("public demo seed is rich, relative, and has unique DynamoDB keys", () => {
  const seed = createPublicDemoSeed("a", new Date("2026-08-14T12:00:00.000Z"));
  assert.equal(seed.users.length, 5);
  assert.equal(seed.memberships.length, 5);
  assert.equal(seed.portfolios.length, 2);
  assert.equal(seed.projects.length, 3);
  assert.equal(seed.workItems.length, 15);
  assert.deepEqual([...new Set(seed.workItems.map((item) => item.status))].sort(), ["blocked", "done", "in-progress", "intake", "ready"]);
  assert.equal(seed.meetings.length, 3);
  assert.equal(seed.documents.length, 4);
  assert.equal(seed.timeEntries.length >= 6, true);
  assert.equal(seed.savedViews.length, 2);
  assert.equal(seed.activities.length >= 10, true);
  assert.equal(seed.projects[0].targetDate, "2026-09-01");
  assert.equal(seed.users.every((user) => user.email.endsWith("@demo.example")), true);
  assert.equal(seed.memberships.filter((membership) => membership.projectIds?.length).length, 4);
  assert.equal(new Set(seed.memberships.map((membership) => JSON.stringify(membership.projectIds ?? []))).size > 1, true);

  const membershipByUserId = new Map(seed.memberships.map((membership) => [membership.userId, membership]));
  const canAccessProject = (userId, projectId) => {
    const membership = membershipByUserId.get(userId);
    return membership?.status === "active"
      && (!membership.projectIds?.length || membership.projectIds.includes(projectId));
  };
  for (const workItem of seed.workItems) {
    assert.equal(canAccessProject(workItem.assigneeId, workItem.projectId), true, `${workItem.assigneeId} cannot access assigned task ${workItem.id}`);
  }
  for (const meeting of seed.meetings) {
    for (const participantId of meeting.participantIds) {
      assert.equal(canAccessProject(participantId, meeting.projectId), true, `${participantId} cannot access meeting ${meeting.id}`);
    }
    for (const agendaItem of meeting.agendaItems) {
      if (!agendaItem.presenterId) continue;
      assert.equal(meeting.participantIds.includes(agendaItem.presenterId), true, `${agendaItem.presenterId} does not participate in meeting ${meeting.id}`);
      assert.equal(canAccessProject(agendaItem.presenterId, meeting.projectId), true, `${agendaItem.presenterId} cannot present in meeting ${meeting.id}`);
    }
    const scheduledMinutes = (Date.parse(meeting.endsAt) - Date.parse(meeting.startsAt)) / 60_000;
    const agendaMinutes = meeting.agendaItems.reduce((total, agendaItem) => total + Number(agendaItem.durationMinutes ?? 0), 0);
    assert.equal(agendaMinutes <= scheduledMinutes, true, `${meeting.id} agenda exceeds its scheduled duration`);
  }

  const featuredMeeting = seed.meetings.find((meeting) => meeting.title === "Activation design decision review");
  assert.ok(featuredMeeting);
  assert.equal(featuredMeeting.agendaItems.length, 3);
  assert.equal(featuredMeeting.agendaItems.every((item) => item.outcome.trim()), true);
  assert.match(featuredMeeting.minutes, /Decision:/);
  const linkedFollowUps = featuredMeeting.agendaItems.flatMap((item) => item.workItemIds ?? []);
  assert.equal(new Set(linkedFollowUps).size, 4);
  assert.equal(linkedFollowUps.every((id) => seed.workItems.some((item) => item.id === id && item.projectId === featuredMeeting.projectId)), true);
  assert.equal(seed.activities.some((activity) => activity.entityType === "meeting" && activity.entityId === featuredMeeting.id), true);
  assert.equal(seed.activities.some((activity) => activity.entityType === "time-entry" && activity.eventType === "time.created"), true);

  assert.equal(seed.documents.every((document) => document.sampleOnly === true), true);
  assert.equal(seed.documents.every((document) => document.samplePreview.length > 40 && document.samplePreview.length < 750), true);
  assert.equal(seed.documents.every((document) => document.objectKey === undefined), true);
  assert.deepEqual(seed.documents.map((document) => document.contentType), [
    "application/pdf",
    "application/octet-stream",
    "text/csv",
    "text/markdown"
  ]);

  const items = publicDemoSeedItems(seed);
  assert.equal(new Set(items.map((item) => keyString(item))).size, items.length);
  assert.deepEqual(
    items.find((item) => item.PK === "SYSTEM#MIGRATION" && item.SK === "WORK_INDEX_V1"),
    {
      PK: "SYSTEM#MIGRATION",
      SK: "WORK_INDEX_V1",
      status: "ready",
      source: "public-demo-reset",
      seedVersion: "1",
      verifiedAt: seed.workspace.updatedAt
    }
  );
  const duplicate = structuredClone(seed);
  duplicate.workItems.push(structuredClone(duplicate.workItems[0]));
  assert.throws(() => publicDemoSeedItems(duplicate), /duplicate DynamoDB keys/);
});

test("reset seeds and verifies an inactive slot without Scan, then is idempotent for the day", async () => {
  const client = new FakeDocumentClient({pageSize: 3});
  const now = new Date("2026-08-14T12:00:00.000Z");
  const reset = createPublicDemoResetHandler({
    tableName: "demo-table",
    documentClient: client,
    clock: () => now,
    seedVersion: "7",
    resetHourUtc: 5,
    delay: async () => {}
  });
  const first = await reset();
  assert.equal(first.changed, true);
  assert.equal(first.activeSlot, "a");
  assert.equal(first.workspaceId, publicDemoWorkspaceId("a"));
  assert.equal(first.nextResetAt, "2026-08-15T05:00:00.000Z");
  const pointer = client.get(publicDemoPointerKey);
  assert.equal(pointer.activeSlot, "a");
  assert.equal(pointer.seedVersion, "7");
  assert.equal(client.commands.includes("ScanCommand"), false);
  assert.equal(client.commands.filter((name) => name === "QueryCommand").length > 10, true, "verification should paginate/query exact partitions");

  const commandCount = client.commands.length;
  const second = await reset();
  assert.equal(second.changed, false);
  assert.equal(second.activeSlot, "a");
  assert.equal(client.commands.length, commandCount + 1, "same-day reset should only read the pointer");
});

test("reset idempotency follows the configured reset boundary instead of midnight", async () => {
  const client = new FakeDocumentClient();
  let now = new Date("2026-08-14T02:00:00.000Z");
  const reset = createPublicDemoResetHandler({
    tableName: "demo-table",
    documentClient: client,
    clock: () => now,
    seedVersion: "1",
    resetHourUtc: 5,
    delay: async () => {}
  });

  const initial = await reset();
  assert.equal(initial.changed, true);
  assert.equal(client.get(publicDemoPointerKey).resetDate, "2026-08-13");
  assert.equal(initial.nextResetAt, "2026-08-14T05:00:00.000Z");

  now = new Date("2026-08-14T04:59:59.999Z");
  assert.equal((await reset()).changed, false);

  now = new Date("2026-08-14T05:00:00.000Z");
  const scheduled = await reset();
  assert.equal(scheduled.changed, true);
  assert.equal(scheduled.activeSlot, "b");
  assert.equal(client.get(publicDemoPointerKey).resetDate, "2026-08-14");
  assert.equal(scheduled.nextResetAt, "2026-08-15T05:00:00.000Z");

  now = new Date("2026-08-14T23:59:59.999Z");
  assert.equal((await reset()).changed, false);
});

test("reset cleans only the inactive demo slot, including registry-discovered projects", async () => {
  const client = new FakeDocumentClient({pageSize: 2});
  const dayOne = new Date("2026-08-14T12:00:00.000Z");
  let now = dayOne;
  const reset = createPublicDemoResetHandler({
    tableName: "demo-table",
    documentClient: client,
    clock: () => now,
    seedVersion: "1",
    delay: async () => {}
  });
  await reset();
  const activeAKey = {PK: `PROJECT#public-demo-a-project-customer-portal`, SK: "META"};
  const activeABefore = structuredClone(client.get(activeAKey));

  client.put({PK: "WORKSPACE#public-demo-b", SK: "DEMO_PARTITION#PROJECT#public-demo-b-project-visitor", projectId: "public-demo-b-project-visitor"});
  client.put({PK: "PROJECT#public-demo-b-project-visitor", SK: "META", marker: "stale"});
  client.put({PK: "PROJECT#public-demo-b-project-visitor", SK: "WORK#stale", marker: "stale"});
  client.put({PK: "WORKSPACE#private", SK: "META", marker: "private"});
  client.put({PK: "PROJECT#private-project", SK: "META", marker: "private"});

  now = new Date("2026-08-15T12:00:00.000Z");
  const result = await reset();
  assert.equal(result.activeSlot, "b");
  assert.equal(client.get({PK: "PROJECT#public-demo-b-project-visitor", SK: "META"}), undefined);
  assert.equal(client.get({PK: "PROJECT#public-demo-b-project-visitor", SK: "WORK#stale"}), undefined);
  assert.deepEqual(client.get(activeAKey), activeABefore, "previous active slot must remain untouched during the flip");
  assert.equal(client.get({PK: "WORKSPACE#private", SK: "META"}).marker, "private");
  assert.equal(client.get({PK: "PROJECT#private-project", SK: "META"}).marker, "private");
  assert.equal(client.get({PK: "SYSTEM#MIGRATION", SK: "WORK_INDEX_V1"}).status, "ready");
});

test("a failed child cleanup preserves the registry so a retry removes orphan-prone partitions", async () => {
  const staleProjectId = "public-demo-b-project-visitor-created";
  const client = new FakeDocumentClient({
    pageSize: 2,
    failBeforeDeletePk: `PROJECT#${staleProjectId}`
  });
  client.put({
    ...publicDemoPointerKey,
    activeSlot: "a",
    workspaceId: publicDemoWorkspaceId("a"),
    resetAt: "2026-08-14T05:00:00.000Z",
    nextResetAt: "2026-08-15T05:00:00.000Z",
    resetDate: "2026-08-14",
    seedVersion: "1",
    version: 1
  });
  const registryKey = {
    PK: `WORKSPACE#${publicDemoWorkspaceId("b")}`,
    SK: `DEMO_PARTITION#PROJECT#${staleProjectId}`
  };
  client.put({...registryKey, projectId: staleProjectId});
  client.put({PK: `PROJECT#${staleProjectId}`, SK: "META", marker: "stale"});
  client.put({PK: `PROJECT#${staleProjectId}`, SK: "WORK#stale", marker: "stale"});
  const reset = createPublicDemoResetHandler({
    tableName: "demo-table",
    documentClient: client,
    clock: () => new Date("2026-08-15T05:00:00.000Z"),
    seedVersion: "1",
    delay: async () => {}
  });

  await assert.rejects(reset(), /simulated child cleanup failure/);
  assert.ok(client.get(registryKey), "the retry must still be able to discover the child partition");

  const retried = await reset();
  assert.equal(retried.changed, true);
  assert.equal(retried.activeSlot, "b");
  assert.equal(client.get({PK: `PROJECT#${staleProjectId}`, SK: "META"}), undefined);
  assert.equal(client.get({PK: `PROJECT#${staleProjectId}`, SK: "WORK#stale"}), undefined);
});

test("a failed inactive-slot seed never changes the active pointer", async () => {
  const client = new FakeDocumentClient();
  const pointer = {
    ...publicDemoPointerKey,
    activeSlot: "a",
    workspaceId: publicDemoWorkspaceId("a"),
    resetAt: "2026-08-14T12:00:00.000Z",
    resetDate: "2026-08-14",
    seedVersion: "1",
    version: 1
  };
  client.put(pointer);
  client.failSeedBatch = true;
  const reset = createPublicDemoResetHandler({
    tableName: "demo-table",
    documentClient: client,
    clock: () => new Date("2026-08-15T12:00:00.000Z"),
    seedVersion: "1",
    delay: async () => {}
  });
  await assert.rejects(reset(), /simulated seed failure/);
  assert.deepEqual(client.get(publicDemoPointerKey), pointer);
});

test("the reset custom resource treats stack deletion as a stable no-op", async () => {
  const result = await resetEntryPoint({
    RequestType: "Delete",
    PhysicalResourceId: "existing-public-demo-seed"
  });
  assert.deepEqual(result, {PhysicalResourceId: "existing-public-demo-seed"});
});
