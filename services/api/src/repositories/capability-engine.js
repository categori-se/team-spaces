// @ts-nocheck

import {ValidationError} from "../errors.js";

function fieldDefinitions(capabilities, entityType) {
  return (capabilities.customFields ?? []).filter((field) => (field.entityType ?? "work-item") === entityType);
}

function numeric(value, fieldId) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ValidationError(`Custom field ${fieldId} must be numeric`);
  return parsed;
}

function expressionTokens(expression) {
  const tokens = String(expression ?? "").match(/[A-Za-z][A-Za-z0-9_-]*|\d+(?:\.\d+)?|[()+\-*/]/g) ?? [];
  if (tokens.join("") !== String(expression ?? "").replaceAll(/\s/g, "")) throw new ValidationError("Calculated field formula contains unsupported syntax");
  return tokens;
}

function calculateExpression(expression, values) {
  const tokens = expressionTokens(expression);
  let index = 0;
  const primary = () => {
    const token = tokens[index++];
    if (token === "(") {
      const value = addition();
      if (tokens[index++] !== ")") throw new ValidationError("Calculated field formula has unbalanced parentheses");
      return value;
    }
    if (token === "-") return -primary();
    if (/^\d/.test(token ?? "")) return Number(token);
    if (/^[A-Za-z]/.test(token ?? "")) return numeric(values[token] ?? 0, token);
    throw new ValidationError("Calculated field formula is invalid");
  };
  const multiplication = () => {
    let value = primary();
    while (["*", "/"].includes(tokens[index])) {
      const operator = tokens[index++];
      const right = primary();
      value = operator === "*" ? value * right : right === 0 ? 0 : value / right;
    }
    return value;
  };
  const addition = () => {
    let value = multiplication();
    while (["+", "-"].includes(tokens[index])) {
      const operator = tokens[index++];
      const right = multiplication();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  };
  const result = addition();
  if (index !== tokens.length || !Number.isFinite(result)) throw new ValidationError("Calculated field formula is invalid");
  return Math.round(result * 10000) / 10000;
}

export function validateAndCalculateCustomFields(capabilities, entityType, submitted = {}, current = {}) {
  const definitions = fieldDefinitions(capabilities, entityType);
  const knownIds = new Set(definitions.map((field) => field.id));
  const defaults = Object.fromEntries(definitions.flatMap((field) => field.defaultValue === undefined ? [] : [[field.id, structuredClone(field.defaultValue)]]));
  const values = {...defaults, ...current, ...submitted};
  for (const key of Object.keys(submitted)) {
    if (definitions.length && !knownIds.has(key) && !key.endsWith("__score")) throw new ValidationError(`Unknown custom field: ${key}`);
  }
  for (const field of definitions) {
    const value = values[field.id];
    if (field.required && (value === undefined || value === null || value === "" || Array.isArray(value) && !value.length)) {
      throw new ValidationError(`Custom field ${field.id} is required`);
    }
    if (value === undefined || value === null || value === "" || field.type === "calculated") continue;
    if (field.type === "integer" && !Number.isInteger(Number(value))) throw new ValidationError(`Custom field ${field.id} must be an integer`);
    if (["decimal", "weighted"].includes(field.type) && field.type !== "weighted") numeric(value, field.id);
    if (["integer", "decimal"].includes(field.type)) {
      const number = numeric(value, field.id);
      if (field.minValue !== undefined && number < Number(field.minValue)) throw new ValidationError(`Custom field ${field.id} is below its minimum`);
      if (field.maxValue !== undefined && number > Number(field.maxValue)) throw new ValidationError(`Custom field ${field.id} is above its maximum`);
    }
    if (field.type === "boolean" && typeof value !== "boolean") throw new ValidationError(`Custom field ${field.id} must be a boolean`);
    if (field.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new ValidationError(`Custom field ${field.id} must be a date`);
    if (["string", "long-text"].includes(field.type)) {
      if (typeof value !== "string") throw new ValidationError(`Custom field ${field.id} must be text`);
      if (field.minLength !== undefined && value.length < Number(field.minLength)) throw new ValidationError(`Custom field ${field.id} is too short`);
      const maximum = Math.min(Number(field.maxLength ?? (field.type === "long-text" ? 100000 : 2000)), field.type === "long-text" ? 100000 : 2000);
      if (value.length > maximum) throw new ValidationError(`Custom field ${field.id} is too long`);
    }
    if (field.type === "link") {
      try {
        const parsed = new URL(String(value));
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("unsafe URL");
      } catch {
        throw new ValidationError(`Custom field ${field.id} must be an HTTP(S) URL without embedded credentials`);
      }
    }
    if (["user", "version"].includes(field.type) && !(field.multiSelect ? Array.isArray(value) && value.every((item) => typeof item === "string") : typeof value === "string")) {
      throw new ValidationError(`Custom field ${field.id} must contain identifier values`);
    }
    const optionIds = (options = []) => options.flatMap((option) => [option.id ?? option.value ?? option, ...optionIds(option.children ?? [])]);
    const allowedOptions = new Set(optionIds(field.options ?? []));
    if (field.type === "select" && !field.multiSelect && allowedOptions.size && !allowedOptions.has(value)) throw new ValidationError(`Custom field ${field.id} has an invalid option`);
    if (["multi-select", "hierarchy"].includes(field.type) || field.type === "select" && field.multiSelect) {
      if (!Array.isArray(value)) throw new ValidationError(`Custom field ${field.id} must be an array`);
      if (allowedOptions.size && value.some((option) => !allowedOptions.has(option))) throw new ValidationError(`Custom field ${field.id} has an invalid option`);
    }
    if (field.type === "weighted") {
      const option = (field.options ?? []).find((candidate) => (candidate.id ?? candidate.value) === value);
      if (!option) throw new ValidationError(`Custom field ${field.id} has an invalid weighted option`);
      values[`${field.id}__score`] = numeric(option.weight ?? 0, field.id);
    }
  }
  for (const field of definitions.filter((candidate) => candidate.type === "calculated")) {
    values[field.id] = calculateExpression(field.formula ?? "0", values);
  }
  return values;
}

/** Validate custom values embedded in workspace-owned enumerations. */
export function validateCapabilityCustomFieldValues(capabilities) {
  const next = structuredClone(capabilities);
  for (const [section, entityType] of [["priorities", "priority"], ["groups", "group"], ["timeEntryActivities", "time-entry-activity"]]) {
    next[section] = (next[section] ?? []).map((item) => ({
      ...item,
      customFields: validateAndCalculateCustomFields(next, entityType, item.customFields ?? {}, {})
    }));
  }
  return next;
}

export function automaticWorkSubject(capabilities, values) {
  const pattern = String(capabilities.work?.automaticSubjectPattern ?? "").trim();
  if (!pattern) throw new ValidationError("Automatic work subjects are not configured");
  return pattern.replaceAll(/\{(project|type|sequence|category|version)\}/g, (_match, name) => ({
    project: values.projectName ?? values.projectId,
    type: values.type ?? "task",
    sequence: values.sequence ?? "1",
    category: values.category ?? "",
    version: values.versionName ?? ""
  })[name]).trim().slice(0, 240);
}

export function configuredCustomAction(capabilities, actionId) {
  const action = (capabilities.customActions ?? []).find((candidate) => candidate.id === actionId);
  if (!action) throw new ValidationError("Custom action is not configured");
  if (!action.changes || typeof action.changes !== "object" || Array.isArray(action.changes)) throw new ValidationError("Custom action changes are invalid");
  return action;
}

export function buildCostReport(capabilities, projects, workItems, timeEntries, {definitionId = ""} = {}) {
  const finance = capabilities.finance ?? {};
  const definition = definitionId ? (finance.reportDefinitions ?? []).find((item) => item.id === definitionId) : undefined;
  if (definitionId && !definition) throw new ValidationError("Cost report definition is not configured");
  const filters = definition?.filters ?? {};
  if (filters.projectIds?.length) projects = projects.filter((project) => filters.projectIds.includes(project.id));
  const selectedProjectIds = new Set(projects.map((project) => project.id));
  workItems = workItems.filter((item) => selectedProjectIds.has(item.projectId));
  timeEntries = timeEntries.filter((entry) => selectedProjectIds.has(entry.projectId)
    && (!filters.userIds?.length || filters.userIds.includes(entry.userId))
    && (!filters.fromDate || entry.entryDate >= filters.fromDate)
    && (!filters.toDate || entry.entryDate <= filters.toDate)
    && (filters.billable === undefined || Boolean(entry.billable) === Boolean(filters.billable)));
  const currency = finance.currency ?? "USD";
  const rates = finance.rates ?? [];
  const projectRows = projects.map((project) => {
    const projectWork = workItems.filter((item) => item.projectId === project.id);
    const projectTime = timeEntries.filter((entry) => entry.projectId === project.id);
    const actualLaborCost = projectTime.reduce((sum, entry) => {
      const rate = rates.filter((candidate) => (!candidate.userId || candidate.userId === entry.userId)
        && (!candidate.projectId || candidate.projectId === project.id)
        && (!candidate.validFrom || candidate.validFrom <= entry.entryDate)).sort((a, b) => String(b.validFrom ?? "").localeCompare(String(a.validFrom ?? "")))[0];
      return sum + Number(entry.durationMinutes ?? 0) / 60 * Number(rate?.hourlyRate ?? 0);
    }, 0);
    const plannedLaborCost = projectWork.reduce((sum, item) => {
      const rate = rates.find((candidate) => (!candidate.userId || candidate.userId === item.assigneeId) && (!candidate.projectId || candidate.projectId === project.id));
      return sum + Number(item.estimateMinutes ?? 0) / 60 * Number(rate?.hourlyRate ?? 0);
    }, 0);
    const unitCost = (finance.unitCosts ?? []).filter((item) => item.projectId === project.id).reduce((sum, item) => sum + Number(item.quantity ?? 0) * Number(item.unitPrice ?? 0), 0);
    const budget = (finance.budgets ?? []).filter((item) => item.projectId === project.id).reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
    const actualCost = actualLaborCost + unitCost;
    return {projectId: project.id, projectName: project.name, currency, plannedLaborCost, actualLaborCost, unitCost, actualCost, budget, variance: budget - actualCost};
  });
  return {currency, definition: definition ? {id: definition.id, name: definition.name ?? definition.id, groupBy: definition.groupBy ?? "project", filters} : undefined, availableDefinitions: (finance.reportDefinitions ?? []).map((item) => ({id: item.id, name: item.name ?? item.id})), projects: projectRows, totals: projectRows.reduce((totals, row) => Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value + Number(row[key] ?? 0)])), {plannedLaborCost: 0, actualLaborCost: 0, unitCost: 0, actualCost: 0, budget: 0, variance: 0})};
}

function mondayOf(value) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) ? new Date(`${value}T00:00:00.000Z`) : new Date();
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function addDays(value, count) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function overlaps(startDate, endDate, weekStart, weekEnd) {
  return (!startDate || startDate <= weekEnd) && (!endDate || endDate >= weekStart);
}

function overlapWorkdays(startDate, endDate, weekStart, weekEnd) {
  let count = 0;
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(weekStart, offset);
    const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    if (day >= 1 && day <= 5 && (!startDate || date >= startDate) && (!endDate || date <= endDate)) count += 1;
  }
  return count;
}

export function buildResourcePlan(capabilities, memberships, workItems, options = {}) {
  const profiles = capabilities.resources?.profiles ?? [];
  const allocations = capabilities.resources?.allocations ?? [];
  const timeOff = capabilities.resources?.timeOff ?? [];
  const weekStart = mondayOf(options.week);
  const weekEnd = addDays(weekStart, 6);
  return memberships.map((membership) => {
    const profile = profiles.find((item) => item.userId === membership.userId) ?? {};
    const skills = profile.skills ?? membership.skills ?? [];
    if (options.skill && !skills.includes(options.skill)) return undefined;
    const assigned = workItems.filter((item) => item.assigneeId === membership.userId
      && Number(item.percentComplete ?? 0) < 100
      && (!options.projectId || item.projectId === options.projectId)
      && overlaps(item.startDate, item.dueDate, weekStart, weekEnd));
    const configured = allocations.filter((item) => item.userId === membership.userId
      && (!options.projectId || item.projectId === options.projectId)
      && overlaps(item.startDate, item.endDate, weekStart, weekEnd));
    const configuredMinutes = configured.reduce((sum, item) => sum + Number(item.minutes ?? 0), 0);
    const taskMinutes = assigned.reduce((sum, item) => sum + Math.max(
      Number(item.remainingMinutes ?? 0),
      Number(item.estimateMinutes ?? 0) * Math.max(0, 100 - Number(item.percentComplete ?? 0)) / 100
    ), 0);
    const allocatedMinutes = configuredMinutes + taskMinutes;
    const weeklyMinutes = Number(profile.weeklyMinutes ?? membership.weeklyMinutes ?? 2400);
    const applicableTimeOff = timeOff.filter((item) => item.userId === membership.userId && overlaps(item.startDate ?? item.date, item.endDate ?? item.date, weekStart, weekEnd));
    const dailyMinutes = Math.round(weeklyMinutes / 5);
    const timeOffMinutes = applicableTimeOff.reduce((sum, item) => sum + Number(item.minutes ?? overlapWorkdays(item.startDate ?? item.date, item.endDate ?? item.date, weekStart, weekEnd) * dailyMinutes), 0);
    const capacityMinutes = Math.max(0, weeklyMinutes - timeOffMinutes);
    const projectIds = [...new Set([...configured.map((item) => item.projectId), ...assigned.map((item) => item.projectId)].filter(Boolean))];
    return {userId: membership.userId, name: membership.name ?? membership.email, placeholder: Boolean(membership.placeholder), skills, weekStart, weekEnd, weeklyMinutes, capacityMinutes, timeOffMinutes, configuredMinutes, taskMinutes, allocatedMinutes, availableMinutes: Math.max(0, capacityMinutes - allocatedMinutes), overallocatedMinutes: Math.max(0, allocatedMinutes - capacityMinutes), utilizationPercent: capacityMinutes ? Math.round(allocatedMinutes / capacityMinutes * 100) : allocatedMinutes ? 100 : 0, timeOff: applicableTimeOff, allocations: configured, assignedWorkItemCount: assigned.length, projectIds};
  }).filter(Boolean);
}

export function securityBadge(capabilities, {mfaMode = process.env.MFA_MODE ?? ""} = {}) {
  const checks = {
    mfa: mfaMode === "required" || Boolean(capabilities.authentication?.mfaRequired),
    securityAlerts: Boolean(capabilities.notifications?.securityAlerts),
    malwareScanning: capabilities.security?.malwareScanning === "required",
    scannerDispatcher: capabilities.security?.malwareScanning !== "required" || Boolean(capabilities.security?.scannerWebhookId && capabilities.security?.scannerCredentialHash),
    uploadQuarantine: Boolean(capabilities.security?.uploadQuarantine),
    outboundLinkControl: ["warn", "capture", "block"].includes(capabilities.outboundLinks?.policy),
    scimCredentialProtected: !capabilities.scim?.enabled || Boolean(capabilities.scim?.bearerCredentialHash)
  };
  const passed = Object.values(checks).filter(Boolean).length;
  return {status: passed === Object.keys(checks).length ? "secure" : passed >= 4 ? "review" : "action-required", passed, total: Object.keys(checks).length, checks};
}
