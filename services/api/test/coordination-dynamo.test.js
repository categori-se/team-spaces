// @ts-nocheck

import assert from "node:assert/strict";
import test from "node:test";
import {GetCommand, PutCommand, TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {parseProjectInput, parseWorkItemInput, parseWorkItemPatchInput, roles} from "@teamspaces/contracts";
import {DynamoRepository} from "../src/repositories/dynamo.js";

const now = "2026-10-15T14:00:00.000Z";
const itemKey = ({PK, SK}) => JSON.stringify([PK, SK]);

function conditionalFailure(name) {
  return Object.assign(new Error("Conditional write lost a race"), {name});
}

/** A local Dynamo stand-in that enforces the conditions used by these paths. */
class ConditionalDocumentClient {
  constructor() {
    this.items = new Map();
    this.commands = [];
    this.beforePut = undefined;
    this.beforeTransaction = undefined;
  }

  stored(key) {
    return this.items.get(itemKey(key));
  }

  set(item) {
    this.items.set(itemKey(item), structuredClone(item));
  }

  conditionFails(input) {
    const stored = this.stored(input.Item);
    if (input.ConditionExpression?.includes("attribute_not_exists(PK)")) return Boolean(stored);
    if (input.ConditionExpression === "#version = :expectedVersion") return stored?.version !== input.ExpressionAttributeValues[":expectedVersion"];
    return false;
  }

  async send(command) {
    this.commands.push(command);
    if (command instanceof GetCommand) {
      const item = this.stored(command.input.Key);
      return item ? {Item: structuredClone(item)} : {};
    }
    if (command instanceof PutCommand) {
      if (this.beforePut) await this.beforePut(command.input, this);
      if (this.conditionFails(command.input)) throw conditionalFailure("ConditionalCheckFailedException");
      this.set(command.input.Item);
      return {};
    }
    if (command instanceof TransactWriteCommand) {
      if (this.beforeTransaction) await this.beforeTransaction(command.input, this);
      if (command.input.TransactItems.some((operation) => operation.Put && this.conditionFails(operation.Put))) throw conditionalFailure("TransactionCanceledException");
      for (const operation of command.input.TransactItems) {
        if (operation.Put) this.set(operation.Put.Item);
        else if (operation.Delete) this.items.delete(itemKey(operation.Delete.Key));
        else throw new Error("Unsupported transaction operation");
      }
      return {};
    }
    throw new Error(`Unexpected command: ${command.constructor.name}`);
  }
}

function context(overrides = {}) {
  return {actorId: "user-owner", workspaceId: "workspace-private", correlationId: "coordination-test", membership: {role: roles.admin}, ...overrides};
}

function harness() {
  const client = new ConditionalDocumentClient();
  const repository = new DynamoRepository({tableName: "local-test-table", documentClient: client});
  repository.now = () => now;
  for (const [id, workspaceId] of [["project-one", "workspace-private"], ["project-two", "workspace-private"], ["project-other", "workspace-other"]]) {
    client.set({PK: `PROJECT#${id}`, SK: "META", id, workspaceId, name: "Private build", version: 1});
  }
  return {client, repository};
}

function taskInput(overrides = {}) {
  return parseWorkItemInput({title: "Deliver the comparison workflow", status: "ready", coordination: {roleId: "feature-delivery", sourceId: "studio-opengeo", taskKey: "comparison", nextAction: "Produce a reviewable result."}, ...overrides});
}

function taskWrites(client) {
  return client.commands.filter((command) => command instanceof PutCommand && command.input.Item.SK.startsWith("WORK#"));
}

function activities(client, eventType) {
  return [...client.items.values()].filter((item) => item.eventType === eventType);
}

test("Dynamo synchronization task create is conditional, scoped, and replay-safe", async () => {
  const {repository, client} = harness();
  const first = await repository.createWorkItem(context(), "project-one", taskInput());
  const replay = await repository.createWorkItem(context(), "project-one", taskInput());
  assert.match(first.id, /^task-[a-f0-9]{32}$/);
  assert.deepEqual(replay, first);
  assert.equal(taskWrites(client).length, 1);
  assert.equal(taskWrites(client)[0].input.ConditionExpression, "attribute_not_exists(PK)");
  assert.equal(activities(client, "work.created").length, 1);
  assert.equal(first.projectId, "project-one");
  assert.equal(first.workspaceId, "workspace-private");
  assert.equal(first.version, 1);
  assert.ok(client.commands.some((command) => command instanceof GetCommand && command.input.Key.SK === `WORK#${first.id}` && command.input.ConsistentRead === true));
  const otherProject = await repository.createWorkItem(context(), "project-two", taskInput());
  const otherWorkspace = await repository.createWorkItem(context({workspaceId: "workspace-other"}), "project-other", taskInput());
  assert.equal(new Set([first.id, otherProject.id, otherWorkspace.id]).size, 3);
});

test("Dynamo rejects conflicting source-key creates and source-key changes while preserving current task", async () => {
  const {repository, client} = harness();
  const first = await repository.createWorkItem(context(), "project-one", taskInput());
  await assert.rejects(repository.createWorkItem(context(), "project-one", taskInput({title: "A different original task"})), {status: 409});
  await assert.rejects(repository.patchWorkItem(context(), "project-one", first.id, parseWorkItemPatchInput({
    version: first.version,
    coordination: {...first.coordination, taskKey: "replacement"}
  })), {status: 409});
  assert.equal(client.stored({PK: "PROJECT#project-one", SK: `WORK#${first.id}`}).title, first.title);
  assert.equal(taskWrites(client).length, 1);
});

test("Dynamo concurrent source-key creation replays the winning conditional create", async () => {
  const {repository, client} = harness();
  client.beforePut = (input, state) => {
    if (!input.Item.SK.startsWith("WORK#")) return;
    state.beforePut = undefined;
    state.set(input.Item);
  };
  const replay = await repository.createWorkItem(context(), "project-one", taskInput());
  assert.equal(replay.version, 1);
  assert.equal(taskWrites(client).length, 1);
  assert.equal(activities(client, "work.created").length, 0);
  const last = client.commands.at(-1);
  assert.ok(last instanceof GetCommand);
  assert.equal(last.input.ConsistentRead, true);
  assert.equal(last.input.Key.SK, `WORK#${replay.id}`);
});

test("Dynamo concurrent source-key creation fails when the winning content differs", async () => {
  const {repository, client} = harness();
  client.beforePut = (input, state) => {
    if (!input.Item.SK.startsWith("WORK#")) return;
    state.beforePut = undefined;
    state.set({...input.Item, title: "Another writer's task", coordinationCreateDigest: "another-digest"});
  };
  await assert.rejects(repository.createWorkItem(context(), "project-one", taskInput()), {status: 409});
  assert.equal(activities(client, "work.created").length, 0);
});

test("Dynamo task patches enforce both supplied and concurrently changed versions", async () => {
  const {repository, client} = harness();
  const first = await repository.createWorkItem(context(), "project-one", taskInput());
  const updated = await repository.patchWorkItem(context(), "project-one", first.id, parseWorkItemPatchInput({version: 1, title: "Reviewed title"}));
  assert.equal(updated.version, 2);
  assert.equal(taskWrites(client).at(-1).input.ConditionExpression, "#version = :expectedVersion");
  assert.equal(taskWrites(client).at(-1).input.ExpressionAttributeValues[":expectedVersion"], 1);
  await assert.rejects(repository.patchWorkItem(context(), "project-one", first.id, parseWorkItemPatchInput({version: 1, title: "Stale update"})), {status: 409});
  client.beforePut = (input, state) => {
    if (!input.Item.SK.startsWith("WORK#")) return;
    state.beforePut = undefined;
    state.set({...state.stored(input.Item), version: 3, title: "Concurrent writer"});
  };
  await assert.rejects(repository.patchWorkItem(context(), "project-one", first.id, parseWorkItemPatchInput({version: 2, title: "Losing update"})), {status: 409});
  assert.equal(client.stored({PK: "PROJECT#project-one", SK: `WORK#${first.id}`}).title, "Concurrent writer");
  assert.equal(activities(client, "work.updated").length, 1);
});

test("Dynamo synchronization mutations enforce workspace and project restrictions on real read paths", async () => {
  const {repository, client} = harness();
  const first = await repository.createWorkItem(context(), "project-one", taskInput());
  const restricted = context({membership: {role: roles.projectManager, projectIds: ["project-two"]}});
  await assert.rejects(repository.createWorkItem(restricted, "project-one", taskInput()), {status: 404});
  await assert.rejects(repository.patchWorkItem(restricted, "project-one", first.id, parseWorkItemPatchInput({version: 1, title: "Forbidden update"})), {status: 404});
  await assert.rejects(repository.createWorkItem(context({workspaceId: "workspace-other"}), "project-one", taskInput()), {status: 404});
  await assert.rejects(repository.patchWorkItem(context({workspaceId: "workspace-other"}), "project-one", first.id, parseWorkItemPatchInput({version: 1, title: "Forbidden update"})), {status: 404});
  assert.equal(taskWrites(client).length, 1);
});

test("Dynamo coordination acceptance requires a closed status and evidence, including when reopening", async () => {
  const {repository, client} = harness();
  const evidence = [{label: "Private acceptance review", url: "https://example.com/private-review", visibility: "private"}];
  await assert.rejects(repository.createWorkItem(context(), "project-one", taskInput({coordination: {roleId: "feature-delivery", acceptanceState: "accepted", evidence}})), {status: 400});
  const first = await repository.createWorkItem(context(), "project-one", taskInput());
  await assert.rejects(repository.patchWorkItem(context(), "project-one", first.id, parseWorkItemPatchInput({version: 1, coordination: {...first.coordination, acceptanceState: "accepted", evidence}})), {status: 400});
  const accepted = await repository.patchWorkItem(context(), "project-one", first.id, parseWorkItemPatchInput({version: 1, status: "done", coordination: {...first.coordination, acceptanceState: "accepted", evidence}}));
  assert.equal(accepted.coordination.acceptanceState, "accepted");
  await assert.rejects(repository.patchWorkItem(context(), "project-one", first.id, parseWorkItemPatchInput({version: 2, status: "in-progress"})), {status: 400});
  const reopened = await repository.patchWorkItem(context(), "project-one", first.id, parseWorkItemPatchInput({version: 2, status: "in-progress", coordination: {...accepted.coordination, acceptanceState: "pending"}}));
  assert.equal(reopened.status, "in-progress");
  assert.equal(reopened.version, 3);
  assert.equal(activities(client, "work.updated").length, 2);
});

test("Dynamo source-task replay preserves later versioned edits and ordinary creates remain distinct", async () => {
  const {repository} = harness();
  const first = await repository.createWorkItem(context(), "project-one", taskInput());
  const updated = await repository.patchWorkItem(context(), "project-one", first.id, parseWorkItemPatchInput({version: 1, title: "A human refined the outcome"}));
  assert.deepEqual(await repository.createWorkItem(context(), "project-one", taskInput()), updated);
  const ordinary = parseWorkItemInput({title: "An ordinary task"});
  const one = await repository.createWorkItem(context(), "project-one", structuredClone(ordinary));
  const two = await repository.createWorkItem(context(), "project-one", structuredClone(ordinary));
  assert.notEqual(one.id, two.id);
  assert.equal(one.type, "task");
  assert.equal(one.status, "intake");
});

test("Dynamo keyed coordination projects use conditional transactions and replay the original project", async () => {
  const {repository, client} = harness();
  const input = () => parseProjectInput({name: "OpenGeo private delivery", coordination: {initiativeId: "opengeo", facet: "internal", key: "build"}});
  const first = await repository.createProject(context(), input());
  assert.match(first.id, /^coord-[a-f0-9]{32}$/);
  assert.deepEqual(await repository.createProject(context(), input()), first);
  assert.equal(activities(client, "project.created").length, 1);
  const transactions = client.commands.filter((command) => command instanceof TransactWriteCommand);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].input.TransactItems[0].Put.ConditionExpression, "attribute_not_exists(PK)");
  await assert.rejects(repository.createProject(context(), {...input(), name: "Conflicting project title"}), {status: 409});
  await assert.rejects(repository.createProject(context({membership: {role: roles.projectManager, projectIds: ["project-two"]}}), input()), {status: 404});
  const other = await repository.createProject(context({workspaceId: "workspace-other"}), input());
  assert.notEqual(other.id, first.id);
});

test("Dynamo racing keyed-project creation replays the winning transaction without duplicate activity", async () => {
  const {repository, client} = harness();
  client.beforeTransaction = (input, state) => {
    state.beforeTransaction = undefined;
    state.set(input.TransactItems[0].Put.Item);
  };
  const input = parseProjectInput({name: "OpenGeo private delivery", coordination: {initiativeId: "opengeo", facet: "internal", key: "build"}});
  const result = await repository.createProject(context(), input);
  assert.equal(result.version, 1);
  assert.equal(activities(client, "project.created").length, 0);
  assert.ok(client.commands.at(-1) instanceof GetCommand);
  assert.ok(client.commands.some((command) => command instanceof GetCommand && command.input.ConsistentRead === true && command.input.Key.PK === `PROJECT#${result.id}`));
});

test("Dynamo project patches and keyed-project race recovery preserve project-scoped authorization", async () => {
  const {repository, client} = harness();
  const restricted = context({membership: {role: roles.projectManager, projectIds: ["project-two"]}});
  await assert.rejects(repository.patchProject(restricted, "project-one", {version: 1, name: "Forbidden project edit"}), {status: 404});
  assert.equal(client.stored({PK: "PROJECT#project-one", SK: "META"}).name, "Private build");
  client.beforeTransaction = (input, state) => {
    state.beforeTransaction = undefined;
    state.set(input.TransactItems[0].Put.Item);
  };
  const input = parseProjectInput({name: "OpenGeo private delivery", coordination: {initiativeId: "opengeo", facet: "internal", key: "restricted-race"}});
  await assert.rejects(repository.createProject(restricted, input), {status: 404});
  assert.equal(activities(client, "project.updated").length, 0);
  assert.equal(activities(client, "project.created").length, 0);
});

test("Dynamo copied coordination work drops synchronization identity, run metadata, and acceptance", async () => {
  const {repository} = harness();
  const evidence = [{label: "Acceptance review", url: "https://example.com/review", visibility: "private"}];
  const first = await repository.createWorkItem(context(), "project-one", taskInput({status: "done", coordination: {
    roleId: "feature-delivery", sourceId: "studio-opengeo", taskKey: "comparison", nextAction: "Integrate the accepted work.", acceptanceState: "accepted", evidence,
    run: {id: "run-1", state: "succeeded", updatedAt: now, sourceRevision: "reviewed-sha"}
  }}));
  const copy = await repository.copyWorkItem(context(), "project-one", first.id, {targetProjectId: "project-two"});
  assert.notEqual(copy.id, first.id);
  assert.equal(copy.coordination.roleId, "feature-delivery");
  assert.equal(copy.coordination.nextAction, first.coordination.nextAction);
  assert.equal(copy.coordination.acceptanceState, "pending");
  assert.deepEqual(copy.coordination.evidence, []);
  assert.equal(copy.coordination.sourceId, undefined);
  assert.equal(copy.coordination.taskKey, undefined);
  assert.equal(copy.coordination.run, undefined);
  assert.equal(copy.coordinationCreateDigest, undefined);
  const replay = await repository.createWorkItem(context(), "project-one", taskInput({status: "done", coordination: {
    roleId: "feature-delivery", sourceId: "studio-opengeo", taskKey: "comparison", nextAction: "Integrate the accepted work.", acceptanceState: "accepted", evidence,
    run: {id: "run-1", state: "succeeded", updatedAt: now, sourceRevision: "reviewed-sha"}
  }}));
  assert.equal(replay.coordination.acceptanceState, "accepted");
});

test("Dynamo synchronized work cannot move away from its scoped stable source identity", async () => {
  const {repository, client} = harness();
  const first = await repository.createWorkItem(context(), "project-one", taskInput());
  await assert.rejects(repository.moveWorkItem(context(), "project-one", first.id, {version: 1, targetProjectId: "project-two"}), {status: 409});
  assert.equal(client.stored({PK: "PROJECT#project-one", SK: `WORK#${first.id}`}).projectId, "project-one");
  assert.equal(client.stored({PK: "PROJECT#project-two", SK: `WORK#${first.id}`}), undefined);
  assert.equal(activities(client, "work.moved").length, 0);
});
