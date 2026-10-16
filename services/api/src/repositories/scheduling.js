// @ts-nocheck

function dateOnly(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function asDate(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function calendarValues(calendar = {}) {
  return {
    workingDays: new Set(Array.isArray(calendar.workingDays) && calendar.workingDays.length ? calendar.workingDays : [1, 2, 3, 4, 5]),
    holidays: new Set(calendar.holidays ?? []),
    hoursPerDay: Math.max(1, Number(calendar.hoursPerDay ?? 8))
  };
}

function isWorkingDate(date, calendar) {
  return calendar.workingDays.has(date.getUTCDay()) && !calendar.holidays.has(formatDate(date));
}

function nextWorkingDate(value, calendar, includeCurrent = true) {
  const date = asDate(value);
  if (!includeCurrent) date.setUTCDate(date.getUTCDate() + 1);
  for (let attempts = 0; attempts < 3700; attempts += 1) {
    if (isWorkingDate(date, calendar)) return formatDate(date);
    date.setUTCDate(date.getUTCDate() + 1);
  }
  throw new Error("Unable to find a working day in the configured calendar");
}

function addWorkingDays(value, count, calendar) {
  let current = nextWorkingDate(value, calendar, true);
  for (let remaining = Math.max(0, count); remaining > 0; remaining -= 1) {
    current = nextWorkingDate(current, calendar, false);
  }
  return current;
}

function latestDate(values) {
  return values.filter(Boolean).sort().at(-1);
}

function dependencyIds(item) {
  return [...new Set([
    ...(item.blockedBy ?? []),
    ...(item.relations ?? []).filter((relation) => ["predecessor", "blocked-by"].includes(relation.type)).map((relation) => relation.targetId)
  ])];
}

/**
 * Calculate automatic dates without mutating repository records. Manual work
 * anchors dependent tasks, and configured non-working days are always skipped.
 * Parent totals are derived after task dates settle.
 *
 * @param {Array<Record<string, any>>} workItems
 * @param {Record<string, any>} calendar
 * @param {{projectStartDate?: string, today?: string}} [options]
 */
export function calculateProjectSchedule(workItems, calendar = {}, options = {}) {
  const calendarConfig = calendarValues(calendar);
  const today = dateOnly(options.today) ?? new Date().toISOString().slice(0, 10);
  const projectStart = nextWorkingDate(dateOnly(options.projectStartDate) ?? today, calendarConfig, true);
  const byId = new Map(workItems.map((item) => [item.id, {...item}]));
  const changedIds = new Set();
  const warnings = [];

  for (let pass = 0; pass < Math.max(1, workItems.length); pass += 1) {
    let changed = false;
    for (const item of byId.values()) {
      if (item.schedulingMode !== "automatic") continue;
      const dependencies = dependencyIds(item).map((id) => byId.get(id)).filter(Boolean);
      const dependencyStarts = dependencies.map((dependency) => {
        if (!dependency.dueDate) return undefined;
        const relation = (item.relations ?? []).find((candidate) => candidate.targetId === dependency.id
          && ["predecessor", "blocked-by"].includes(candidate.type));
        return addWorkingDays(dependency.dueDate, Math.max(0, Number(relation?.lagDays ?? 0)) + 1, calendarConfig);
      });
      const requestedStart = latestDate([projectStart, dateOnly(item.startDate), ...dependencyStarts]) ?? projectStart;
      const startDate = nextWorkingDate(requestedStart, calendarConfig, true);
      const durationDays = Math.max(1, Math.ceil(Number(item.estimateMinutes ?? item.remainingMinutes ?? 0) / (calendarConfig.hoursPerDay * 60)));
      const dueDate = addWorkingDays(startDate, durationDays - 1, calendarConfig);
      if (item.startDate !== startDate || item.dueDate !== dueDate) {
        item.startDate = startDate;
        item.dueDate = dueDate;
        changedIds.add(item.id);
        changed = true;
      }
    }
    if (!changed) break;
    if (pass === workItems.length - 1) warnings.push("Dependency dates did not converge; check for a relation cycle.");
  }

  const childrenByParent = new Map();
  for (const item of byId.values()) {
    if (!item.parentId) continue;
    const children = childrenByParent.get(item.parentId) ?? [];
    children.push(item);
    childrenByParent.set(item.parentId, children);
  }
  for (let pass = 0; pass < workItems.length; pass += 1) {
    let changed = false;
    for (const [parentId, children] of childrenByParent) {
      const parent = byId.get(parentId);
      if (!parent || !children.length) continue;
      const estimateMinutes = children.reduce((sum, child) => sum + Number(child.estimateMinutes ?? 0), 0);
      const remainingMinutes = children.reduce((sum, child) => sum + Number(child.remainingMinutes ?? 0), 0);
      const recordedMinutes = children.reduce((sum, child) => sum + Number(child.recordedMinutes ?? 0), 0);
      const percentComplete = estimateMinutes
        ? Math.round(children.reduce((sum, child) => sum + Number(child.percentComplete ?? 0) * Number(child.estimateMinutes ?? 0), 0) / estimateMinutes)
        : Math.round(children.reduce((sum, child) => sum + Number(child.percentComplete ?? 0), 0) / children.length);
      const startDate = children.map((child) => child.startDate).filter(Boolean).sort()[0];
      const dueDate = children.map((child) => child.dueDate).filter(Boolean).sort().at(-1);
      const totals = {estimateMinutes, remainingMinutes, recordedMinutes, percentComplete, startDate, dueDate};
      if (Object.entries(totals).some(([field, value]) => value !== undefined && parent[field] !== value)) {
        Object.assign(parent, totals);
        changedIds.add(parentId);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return {
    items: [...byId.values()],
    updates: [...changedIds].map((id) => {
      const item = byId.get(id);
      return {
        id,
        version: item.version,
        startDate: item.startDate,
        dueDate: item.dueDate,
        estimateMinutes: item.estimateMinutes,
        remainingMinutes: item.remainingMinutes,
        recordedMinutes: item.recordedMinutes,
        percentComplete: item.percentComplete
      };
    }),
    warnings,
    calendar: {
      workingDays: [...calendarConfig.workingDays].sort(),
      holidays: [...calendarConfig.holidays].sort(),
      hoursPerDay: calendarConfig.hoursPerDay
    }
  };
}

/** @param {Array<Record<string, any>>} workItems @param {Record<string, any>} baseline */
export function compareProjectBaseline(workItems, baseline) {
  const currentById = new Map(workItems.map((item) => [item.id, item]));
  const snapshot = baseline.snapshot ?? [];
  const items = snapshot.map((previous) => {
    const current = currentById.get(previous.id);
    if (!current) return {...previous, change: "removed"};
    currentById.delete(previous.id);
    const changes = ["title", "startDate", "dueDate", "status", "percentComplete", "estimateMinutes", "remainingMinutes"]
      .filter((field) => JSON.stringify(previous[field]) !== JSON.stringify(current[field]));
    return {id: previous.id, title: current.title, previous, current, changes, change: changes.length ? "changed" : "unchanged"};
  });
  for (const current of currentById.values()) items.push({id: current.id, title: current.title, current, changes: [], change: "added"});
  return {
    baselineId: baseline.id,
    baselineName: baseline.name,
    capturedAt: baseline.capturedAt ?? baseline.createdAt,
    items,
    summary: Object.fromEntries(["added", "removed", "changed", "unchanged"].map((change) => [change, items.filter((item) => item.change === change).length]))
  };
}

const baselineFields = ["id", "projectId", "title", "startDate", "dueDate", "status", "percentComplete", "estimateMinutes", "remainingMinutes", "createdAt", "updatedAt"];

export function workBaselineSnapshot(item = {}) {
  return Object.fromEntries(baselineFields.map((field) => [field, item[field]]).filter(([, value]) => value !== undefined));
}

function endOfDay(value) {
  return `${value}T23:59:59.999Z`;
}

/** Rewind current state through immutable work activity snapshots. */
export function projectSnapshotAt(workItems, activity, date) {
  const timestamp = endOfDay(date);
  const byId = new Map(workItems.map((item) => [item.id, workBaselineSnapshot(item)]));
  for (const item of workItems) {
    if (item.createdAt && item.createdAt > timestamp) byId.delete(item.id);
  }
  const relevant = activity.filter((event) => event.entityType === "work-item" && event.timestamp > timestamp)
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)) || String(b.id).localeCompare(String(a.id)));
  const incompleteEventIds = [];
  for (const event of relevant) {
    if (["work.created", "work.copied"].includes(event.eventType)) {
      byId.delete(event.entityId);
    } else if (event.eventType === "work.updated") {
      if (event.previousSnapshot) byId.set(event.entityId, event.previousSnapshot);
      else incompleteEventIds.push(event.id);
    } else if (event.eventType === "work.moved") {
      byId.delete(event.entityId);
    } else if (event.eventType === "work.moved-out") {
      if (event.previousSnapshot) byId.set(event.entityId, event.previousSnapshot);
      else incompleteEventIds.push(event.id);
    } else if (event.eventType === "work.deleted") {
      if (event.previousSnapshot) byId.set(event.entityId, event.previousSnapshot);
      else incompleteEventIds.push(event.id);
    }
  }
  return {date, items: [...byId.values()], complete: incompleteEventIds.length === 0, incompleteEventIds};
}

export function compareProjectHistory(workItems, activity, from, to) {
  const previous = projectSnapshotAt(workItems, activity, from);
  const current = projectSnapshotAt(workItems, activity, to);
  return {
    ...compareProjectBaseline(current.items, {id: `history:${from}`, name: `History at ${from}`, capturedAt: endOfDay(from), snapshot: previous.items}),
    range: {from, to},
    historyComplete: previous.complete && current.complete,
    incompleteEventIds: [...new Set([...previous.incompleteEventIds, ...current.incompleteEventIds])]
  };
}
