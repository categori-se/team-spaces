// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {roles} from "@teamspaces/contracts";
import {demoUser} from "@teamspaces/test-fixtures";
import {MemoryRepository} from "../src/repositories/memory.js";

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

async function repositoryContext(repository, role = roles.admin) {
  const bootstrap = await repository.getOrBootstrap(demoUser);
  return {
    actorId: bootstrap.user.id,
    user: bootstrap.user,
    workspace: bootstrap.workspace,
    workspaceId: bootstrap.workspace.id,
    membership: {...bootstrap.membership, role},
    correlationId: "work-configuration-test"
  };
}

test("memory work configuration falls back without migration and applies configured defaults", async () => {
  const repository = new MemoryRepository();
  const context = await repositoryContext(repository);
  const fallback = await repository.getWorkConfiguration(context);
  assert.equal(fallback.version, 1);
  assert.equal(fallback.defaultTypeId, "task");
  assert.equal(fallback.statuses.some((status) => status.id === "done" && status.closed), true);

  const replacement = copy(fallback);
  replacement.types.push({id: "user-story", label: "User story", active: true});
  replacement.statuses.push({id: "quality-review", label: "Quality review", active: true, closed: false});
  replacement.defaultTypeId = "user-story";
  replacement.defaultStatusId = "quality-review";
  replacement.transitions.push({
    fromStatusId: "quality-review",
    toStatusId: "done",
    roles: [roles.admin]
  });
  const configured = await repository.patchWorkConfiguration(context, replacement);
  assert.equal(configured.version, 2);

  const item = await repository.createWorkItem(context, "project-pilot", {
    title: "Use workspace defaults",
    description: "",
    priority: "medium",
    estimateMinutes: 0,
    effortPoints: 0,
    blockedBy: [],
    relatedIds: [],
    watcherIds: [],
    acceptanceCriteria: "",
    customFields: {},
    tags: []
  });
  assert.equal(item.type, "user-story");
  assert.equal(item.status, "quality-review");
  assert.equal(repository.activities.at(-2).eventType, "work-configuration.updated");

  const memberContext = {...context, membership: {...context.membership, role: roles.member}};
  await assert.rejects(
    repository.patchWorkItem(memberContext, item.projectId, item.id, {version: item.version, status: "done"}),
    /not allowed for this role/
  );
  const completed = await repository.patchWorkItem(context, item.projectId, item.id, {version: item.version, status: "done"});
  assert.equal(completed.status, "done");

  await assert.rejects(repository.patchWorkConfiguration(context, replacement), /submitted version is stale/i);
});

test("memory work configuration preserves IDs and lets existing work leave inactive values", async () => {
  const repository = new MemoryRepository();
  const context = await repositoryContext(repository);
  const fallback = await repository.getWorkConfiguration(context);
  const existing = await repository.createWorkItem(context, "project-pilot", {
    title: "Legacy bug",
    type: "bug",
    status: "ready",
    description: "",
    priority: "medium",
    estimateMinutes: 0,
    effortPoints: 0,
    blockedBy: [],
    relatedIds: [],
    watcherIds: [],
    acceptanceCriteria: "",
    customFields: {},
    tags: []
  });

  const deactivated = copy(fallback);
  deactivated.types.find((type) => type.id === "bug").active = false;
  const configured = await repository.patchWorkConfiguration(context, deactivated);
  assert.equal(configured.types.find((type) => type.id === "bug").active, false);

  const edited = await repository.patchWorkItem(context, existing.projectId, existing.id, {
    version: existing.version,
    description: "Still editable after its type is retired"
  });
  assert.match(edited.description, /Still editable/);
  await assert.rejects(repository.createWorkItem(context, "project-pilot", {
    title: "Invalid new bug",
    type: "bug",
    status: "ready"
  }), /inactive/);

  const removed = copy(configured);
  removed.types = removed.types.filter((type) => type.id !== "bug");
  await assert.rejects(repository.patchWorkConfiguration(context, removed), /cannot be removed/);
});

test("memory work configuration allows only one concurrent writer for a version", async () => {
  const repository = new MemoryRepository();
  const context = await repositoryContext(repository);
  const first = await repository.getWorkConfiguration(context);
  const second = copy(first);
  first.types[0].label = "First writer";
  second.types[0].label = "Second writer";
  const results = await Promise.allSettled([
    repository.patchWorkConfiguration(context, first),
    repository.patchWorkConfiguration(context, second)
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await repository.getWorkConfiguration(context)).version, 2);
});
