// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBulkWorkItemPatch,
  createBulkWorkItemPatch,
  MAX_BULK_WORK_ITEM_SELECTION
} from "../src/components/ui.js";

test("bulk patch builder keeps unchanged fields out and clears only supported fields", () => {
  assert.deepEqual(createBulkWorkItemPatch("", "ignored"), {});
  assert.deepEqual(createBulkWorkItemPatch("status", " done "), {status: "done"});
  assert.deepEqual(createBulkWorkItemPatch("periodName", "", {clear: true}), {periodName: ""});
  assert.deepEqual(createBulkWorkItemPatch("milestoneName", "", {clear: true}), {milestoneName: ""});
  assert.throws(() => createBulkWorkItemPatch("status", "", {clear: true}), /cannot be cleared/);
  assert.throws(() => createBulkWorkItemPatch("priority", ""), /Choose a value/);
});

test("bulk updates are sequential, project-scoped, versioned, and continue after an item failure", async () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const client = {
    workItems: {
      patch: async (projectId, id, body) => {
        calls.push({projectId, id, body});
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        if (id === "work-2") throw new Error("Version conflict");
        return {id, projectId, ...body, version: body.version + 1};
      }
    }
  };
  const items = [
    {id: "work-1", projectId: "project-a", title: "First", version: 3},
    {id: "work-2", projectId: "project-b", title: "Second", version: 7},
    {id: "work-3", projectId: "project-a", title: "Third", version: 2}
  ];

  const result = await applyBulkWorkItemPatch(client, items, {priority: "high"});

  assert.equal(maxActive, 1);
  assert.deepEqual(calls, [
    {projectId: "project-a", id: "work-1", body: {priority: "high", version: 3}},
    {projectId: "project-b", id: "work-2", body: {priority: "high", version: 7}},
    {projectId: "project-a", id: "work-3", body: {priority: "high", version: 2}}
  ]);
  assert.deepEqual(result.succeeded.map((entry) => entry.id), ["work-1", "work-3"]);
  assert.deepEqual(result.failed.map((entry) => ({id: entry.id, message: entry.message})), [
    {id: "work-2", message: "Version conflict"}
  ]);
});

test("bulk updates reject more than the bounded selection before issuing requests", async () => {
  let calls = 0;
  const client = {workItems: {patch: async () => { calls += 1; }}};
  const items = Array.from({length: MAX_BULK_WORK_ITEM_SELECTION + 1}, (_, index) => ({
    id: `work-${index}`,
    projectId: "project-a",
    version: 1
  }));

  await assert.rejects(
    applyBulkWorkItemPatch(client, items, {status: "done"}),
    new RegExp(`no more than ${MAX_BULK_WORK_ITEM_SELECTION}`)
  );
  assert.equal(calls, 0);
});
