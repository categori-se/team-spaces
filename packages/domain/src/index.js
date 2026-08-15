// @ts-check

import {intakeGroups, healthStates, lifecyclePhases, projectStatuses, workStatuses} from "@teamspaces/contracts";

/**
 * @returns {string}
 */
export function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * DynamoDB activity sort keys need descending chronological order.
 * @param {string | Date} timestamp
 * @returns {string}
 */
export function reverseTimestamp(timestamp) {
  const date = typeof timestamp === "string" ? new Date(timestamp) : timestamp;
  const max = 9999999999999;
  return String(max - date.getTime()).padStart(13, "0");
}

/**
 * @param {string} phase
 * @returns {string | undefined}
 */
export function nextLifecyclePhase(phase) {
  const index = lifecyclePhases.indexOf(phase);
  if (index < 0 || index >= lifecyclePhases.length - 1) return undefined;
  return lifecyclePhases[index + 1];
}

/**
 * @param {Array<{id: string, archived?: boolean}>} portfolios
 * @param {Array<{id: string, portfolioId?: string, archived?: boolean}>} projects
 */
export function aggregateHierarchy(portfolios, projects) {
  return portfolios.map((portfolio) => {
    const portfolioProjects = projects.filter((project) => project.portfolioId === portfolio.id && !project.archived);
    return {
      ...portfolio,
      projectCount: portfolioProjects.length
    };
  });
}

/** @param {string[]} values @param {readonly string[]} allowed */
function countBy(values, allowed) {
  return Object.fromEntries(allowed.map((key) => [key, values.filter((value) => value === key).length]));
}

/**
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} getKey
 * @returns {Map<string, T[]>}
 */
function groupBy(items, getKey) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item);
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return map;
}

/** @param {Array<{effortPoints?: number, status?: string}>} items */
function sumEffortPoints(items) {
  return items.reduce((sum, item) => sum + Number(item.effortPoints ?? 0), 0);
}

/**
 * @param {Array<{acceptanceCriteria?: string, assigneeId?: string, assigneeName?: string, intakeGroup?: string, blockedBy?: string[], parentId?: string, relatedIds?: string[], milestoneName?: string, periodGoal?: string, periodId?: string, periodName?: string, status?: string, effortPoints?: number, watcherIds?: string[]}>} workItems
 * @param {{statuses?: Array<{id: string, closed?: boolean}>, defaultStatusId?: string}} options
 */
export function buildPlanningSummary(workItems = [], options = {}) {
  const configuredStatusIds = options.statuses?.map((status) => status.id) ?? [...workStatuses];
  const closedStatusIds = new Set(options.statuses?.filter((status) => status.closed).map((status) => status.id) ?? ["done"]);
  const defaultStatusId = options.defaultStatusId ?? "intake";
  /** @param {{status?: string}} item */
  const isClosed = (item) => closedStatusIds.has(item.status ?? defaultStatusId);
  const statuses = workItems.map((item) => item.status ?? defaultStatusId);
  const activeItems = workItems.filter((item) => !isClosed(item));
  const wipCount = workItems.filter((item) => item.status === "in-progress").length;
  const periodGroups = groupBy(workItems, (item) => item.periodId || item.periodName || "unscheduled");
  const byPeriod = [...periodGroups.entries()].map(([id, items]) => {
    const first = items[0] ?? {};
    const doneItems = items.filter(isClosed);
    return {
      id,
      name: first.periodName || "Unscheduled",
      goal: first.periodGoal || "",
      itemCount: items.length,
      activeCount: items.length - doneItems.length,
      completedCount: doneItems.length,
      pointsTotal: sumEffortPoints(items),
      pointsDone: sumEffortPoints(doneItems),
      pointsRemaining: sumEffortPoints(items.filter((item) => !isClosed(item)))
    };
  }).sort((a, b) => {
    if (a.id === "unscheduled") return 1;
    if (b.id === "unscheduled") return -1;
    return b.activeCount - a.activeCount || a.name.localeCompare(b.name);
  });
  const currentPeriod = byPeriod.find((period) => period.id !== "unscheduled" && period.activeCount > 0) ?? byPeriod.find((period) => period.id !== "unscheduled");
  const assigneeGroups = groupBy(workItems, (item) => item.assigneeId || "unassigned");
  const byAssignee = [...assigneeGroups.entries()].map(([assigneeId, items]) => ({
    assigneeId,
    name: items[0]?.assigneeName || (assigneeId === "unassigned" ? "Unassigned" : assigneeId),
    itemCount: items.length,
    activeCount: items.filter((item) => !isClosed(item)).length,
    blockedCount: items.filter((item) => item.status === "blocked").length,
    effortPoints: sumEffortPoints(items),
    activeEffortPoints: sumEffortPoints(items.filter((item) => !isClosed(item)))
  })).sort((a, b) => b.activeEffortPoints - a.activeEffortPoints || a.name.localeCompare(b.name));
  const milestoneGroups = groupBy(workItems, (item) => item.milestoneName || "Unplanned");
  const byMilestone = [...milestoneGroups.entries()].map(([name, items]) => ({
    name,
    itemCount: items.length,
    activeCount: items.filter((item) => !isClosed(item)).length,
    pointsTotal: sumEffortPoints(items),
    pointsDone: sumEffortPoints(items.filter(isClosed))
  })).sort((a, b) => a.name.localeCompare(b.name));
  const period = currentPeriod ?? {
    id: "unscheduled",
    name: "Unscheduled",
    goal: "",
    itemCount: 0,
    activeCount: 0,
    completedCount: 0,
    pointsTotal: 0,
    pointsDone: 0,
    pointsRemaining: 0
  };
  return {
    itemCount: workItems.length,
    intakeCount: workItems.filter((item) => (item.status ?? defaultStatusId) === defaultStatusId).length,
    blockedCount: workItems.filter((item) => item.status === "blocked").length,
    relationshipCount: workItems.filter((item) => item.parentId || item.blockedBy?.length || item.relatedIds?.length).length,
    acceptanceCriteriaCount: workItems.filter((item) => item.acceptanceCriteria).length,
    watchedCount: workItems.filter((item) => item.watcherIds?.length).length,
    wipCount,
    wipLimit: 4,
    wipOverLimit: wipCount > 4,
    effortPointsTotal: sumEffortPoints(workItems),
    effortPointsDone: sumEffortPoints(workItems.filter(isClosed)),
    effortPointsRemaining: sumEffortPoints(activeItems),
    currentPeriod: period,
    byStatus: countBy(statuses, configuredStatusIds),
    byIntakeGroup: {
      ...countBy(workItems.map((item) => item.intakeGroup ?? ""), intakeGroups),
      unbucketed: workItems.filter((item) => !item.intakeGroup).length
    },
    byPeriod,
    byAssignee,
    byMilestone
  };
}

/**
 * @param {Array<{acceptanceCriteria?: string, assigneeId?: string, assigneeName?: string, intakeGroup?: string, blockedBy?: string[], parentId?: string, relatedIds?: string[], milestoneName?: string, periodGoal?: string, periodId?: string, periodName?: string, status?: string, effortPoints?: number, watcherIds?: string[]}>} workItems
 */
export function buildLegacyPlanningSummary(workItems = []) {
  return buildPlanningSummary(workItems);
}

/**
 * @param {Array<{status: string, health: string, phase: string, percentComplete?: number, targetDate?: string}>} projects
 * @param {Array<{type?: string, title?: string, dueDate?: string, status?: string, effortPoints?: number}>} workItems
 * @param {{asOfDate?: string, statuses?: Array<{id: string, closed?: boolean}>, defaultStatusId?: string}} options
 */
export function buildPortfolioSummary(projects, workItems = [], options = {}) {
  const today = options.asOfDate ?? new Date().toISOString().slice(0, 10);
  const closedStatusIds = new Set(options.statuses?.filter((status) => status.closed).map((status) => status.id) ?? ["done"]);
  const configuredStatusIds = options.statuses?.map((status) => status.id) ?? [...workStatuses];
  const activeProjects = projects.filter((project) => !["archived", "complete"].includes(project.status));
  const overdueProjects = activeProjects.filter((project) => project.targetDate && project.targetDate < today).length;
  const upcomingMilestones = workItems
    .filter((item) => item.type === "milestone" && item.dueDate && item.dueDate >= today && !closedStatusIds.has(item.status ?? options.defaultStatusId ?? "intake"))
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
    .slice(0, 10);
  const averageProgress = activeProjects.length
    ? Math.round(activeProjects.reduce((sum, project) => sum + Number(project.percentComplete ?? 0), 0) / activeProjects.length)
    : 0;
  const planning = buildPlanningSummary(workItems, options);
  return {
    totalActiveProjects: activeProjects.length,
    byHealth: countBy(projects.map((project) => project.health), healthStates),
    byStatus: countBy(projects.map((project) => project.status), projectStatuses),
    byPhase: countBy(projects.map((project) => project.phase), lifecyclePhases),
    atRiskProjects: projects.filter((project) => ["at-risk", "blocked"].includes(project.health)).length,
    overdueProjects,
    upcomingMilestones,
    averageProgress,
    byWorkStatus: countBy(workItems.map((item) => item.status ?? options.defaultStatusId ?? "intake"), configuredStatusIds),
    planning
  };
}
