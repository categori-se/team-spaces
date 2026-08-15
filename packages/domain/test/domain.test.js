// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {buildPlanningSummary, buildPortfolioSummary, nextLifecyclePhase, reverseTimestamp} from "../src/index.js";

test("computes lifecycle progression", () => {
  assert.equal(nextLifecyclePhase("Planning"), "Execution");
  assert.equal(nextLifecyclePhase("Closed"), undefined);
});

test("reverse timestamps sort newest first lexicographically", () => {
  const older = reverseTimestamp("2026-07-10T10:00:00.000Z");
  const newer = reverseTimestamp("2026-07-10T11:00:00.000Z");
  assert.equal(newer < older, true);
});

test("builds portfolio summary", () => {
  const summary = buildPortfolioSummary([
    {status: "active", health: "on-track", phase: "Execution", percentComplete: 50, targetDate: "2026-08-01"},
    {status: "active", health: "at-risk", phase: "Planning", percentComplete: 10, targetDate: "2020-01-01"}
  ], [
    {type: "milestone", dueDate: "2026-08-01", status: "ready", title: "Gate"}
  ], {asOfDate: "2026-07-15"});
  assert.equal(summary.totalActiveProjects, 2);
  assert.equal(summary.atRiskProjects, 1);
  assert.equal(summary.overdueProjects, 1);
  assert.equal(summary.averageProgress, 30);
  assert.equal(summary.planning.byStatus.ready, 1);
});

test("builds planning summary", () => {
  const summary = buildPlanningSummary([
    {status: "in-progress", effortPoints: 5, periodId: "period-1", periodName: "Period 1", periodGoal: "Ship", intakeGroup: "ready", assigneeId: "u1", assigneeName: "User One", milestoneName: "Beta", parentId: "milestone-1", blockedBy: ["setup"], acceptanceCriteria: "User can sign in.", watcherIds: ["u2"]},
    {status: "blocked", effortPoints: 3, periodId: "period-1", periodName: "Period 1", periodGoal: "Ship", intakeGroup: "bugs", assigneeId: "u2", milestoneName: "Beta"},
    {status: "done", effortPoints: 2, periodId: "period-1", periodName: "Period 1", periodGoal: "Ship", intakeGroup: "maintenance", assigneeId: "u1", milestoneName: "Beta"}
  ]);
  assert.equal(summary.currentPeriod.name, "Period 1");
  assert.equal(summary.currentPeriod.pointsTotal, 10);
  assert.equal(summary.currentPeriod.pointsDone, 2);
  assert.equal(summary.effortPointsTotal, 10);
  assert.equal(summary.blockedCount, 1);
  assert.equal(summary.relationshipCount, 1);
  assert.equal(summary.acceptanceCriteriaCount, 1);
  assert.equal(summary.watchedCount, 1);
  assert.equal(summary.byIntakeGroup.bugs, 1);
  assert.equal(summary.byAssignee[0].assigneeId, "u1");
});
