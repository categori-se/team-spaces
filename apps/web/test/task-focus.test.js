// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {filterAssignedWorkItems} from "../src/components/ui.js";

const tasks = [
  {id: "done", title: "Completed", status: "done", priority: "low", dueDate: "2026-08-01"},
  {id: "later", title: "Later", status: "ready", priority: "medium", dueDate: "2026-09-30", projectName: "Launch"},
  {id: "blocked", title: "Resolve blocker", status: "blocked", priority: "high", dueDate: "2026-08-25", tags: ["release"]},
  {id: "overdue", title: "Overdue evidence", status: "in-progress", priority: "critical", dueDate: "2026-08-10"}
];

test("assigned work defaults to open attention order and supports bounded filters", () => {
  const today = "2026-08-14";
  assert.deepEqual(
    filterAssignedWorkItems(tasks, {today}).map((item) => item.id),
    ["blocked", "overdue", "later"]
  );
  assert.deepEqual(
    filterAssignedWorkItems(tasks, {scope: "due", today}).map((item) => item.id),
    ["blocked", "overdue"]
  );
  assert.deepEqual(
    filterAssignedWorkItems(tasks, {scope: "all", search: "launch", today}).map((item) => item.id),
    ["later"]
  );
});
