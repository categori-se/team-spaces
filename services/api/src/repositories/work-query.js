// @ts-check

import {ValidationError} from "../errors.js";

const cursorVersion = 2;
const cursorQueryFields = [
  "version",
  "projectId",
  "type",
  "status",
  "assigneeId",
  "dueFrom",
  "dueTo",
  "milestoneName",
  "periodId",
  "search",
  "sort"
];

/** @param {Record<string, unknown>} query */
function queryFingerprint(query) {
  return JSON.stringify(Object.fromEntries(cursorQueryFields.map((field) => [field, query[field] ?? null])));
}

/** @param {Record<string, unknown>} query */
export function selectWorkQuerySource(query) {
  if (query.sort === "due-asc") {
    if (!query.assigneeId) throw new ValidationError("due-asc sort requires assigneeId");
    return "assignee";
  }
  if (query.sort === "id-asc") {
    if (!query.projectId) throw new ValidationError("id-asc sort requires projectId");
    return "project";
  }
  if (query.sort !== "updated-desc") throw new ValidationError("Unsupported work query sort");
  return "workspace";
}

/**
 * @param {{source: string, workspaceId: string, query: Record<string, unknown>, key: Record<string, unknown>}} value
 */
export function encodeWorkCursor(value) {
  return Buffer.from(JSON.stringify({
    v: cursorVersion,
    source: value.source,
    workspaceId: value.workspaceId,
    query: queryFingerprint(value.query),
    key: value.key
  })).toString("base64url");
}

/**
 * @param {unknown} cursor
 * @param {{source: string, workspaceId: string, query: Record<string, unknown>}} expected
 */
export function decodeWorkCursor(cursor, expected) {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (
      parsed?.v !== cursorVersion
      || parsed.source !== expected.source
      || parsed.workspaceId !== expected.workspaceId
      || parsed.query !== queryFingerprint(expected.query)
      || !parsed.key
      || typeof parsed.key !== "object"
      || Array.isArray(parsed.key)
    ) {
      throw new Error("cursor scope mismatch");
    }
    return parsed.key;
  } catch {
    throw new ValidationError("Cursor is invalid or does not match this work query");
  }
}

/** @param {unknown} value @param {unknown} needle */
function includesFolded(value, needle) {
  return String(value ?? "").toLowerCase().includes(String(needle ?? "").toLowerCase());
}

/**
 * @param {Record<string, any>} item
 * @param {Record<string, any>} query
 */
export function matchesWorkQuery(item, query) {
  if (query.projectId && item.projectId !== query.projectId) return false;
  if (query.type && item.type !== query.type) return false;
  if (query.status && item.status !== query.status) return false;
  if (query.assigneeId && item.assigneeId !== query.assigneeId) return false;
  if (query.dueFrom && (!item.dueDate || item.dueDate < query.dueFrom)) return false;
  if (query.dueTo && (!item.dueDate || item.dueDate > query.dueTo)) return false;
  if (query.milestoneName && item.milestoneName !== query.milestoneName) return false;
  if (query.periodId && item.periodId !== query.periodId) return false;
  if (query.search) {
    const haystack = [
      item.title,
      item.description,
      item.milestoneName,
      ...(item.tags ?? []),
      ...Object.entries(item.customFields ?? {}).flat()
    ].join(" ");
    if (!includesFolded(haystack, query.search)) return false;
  }
  return true;
}

/**
 * @param {Record<string, any>} item
 * @param {string} sort
 */
export function memoryWorkCursorKey(item, sort) {
  if (sort === "updated-desc") return {id: item.id, projectId: item.projectId, value: String(item.updatedAt ?? "")};
  if (sort === "due-asc") return {id: item.id, value: String(item.dueDate ?? "9999-12-31")};
  return {id: item.id, value: String(item.id)};
}

/**
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 * @param {string} sort
 */
export function compareWorkItems(a, b, sort) {
  if (sort === "updated-desc") {
    return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""))
      || String(b.projectId ?? "").localeCompare(String(a.projectId ?? ""))
      || String(b.id).localeCompare(String(a.id));
  }
  if (sort === "due-asc") {
    return String(a.dueDate ?? "9999-12-31").localeCompare(String(b.dueDate ?? "9999-12-31")) || String(a.id).localeCompare(String(b.id));
  }
  return String(a.id).localeCompare(String(b.id));
}

/**
 * @param {Record<string, any>} item
 * @param {{id?: string, projectId?: string, value?: string}} key
 * @param {string} sort
 */
export function isAfterMemoryWorkCursor(item, key, sort) {
  const anchor = sort === "updated-desc"
    ? {id: key.id, projectId: key.projectId, updatedAt: key.value}
    : sort === "due-asc"
      ? {id: key.id, dueDate: key.value}
      : {id: key.id};
  return compareWorkItems(item, anchor, sort) > 0;
}

/**
 * Return the complete exclusive-start key required by a table or GSI query.
 * @param {Record<string, any>} item
 * @param {string} source
 */
export function dynamoWorkCursorKey(item, source) {
  const key = {PK: item.PK, SK: item.SK};
  if (source === "workspace") return {...key, GSI1PK: item.GSI1PK, GSI1SK: item.GSI1SK};
  if (source === "assignee") return {...key, GSI2PK: item.GSI2PK, GSI2SK: item.GSI2SK};
  return key;
}

/** @param {boolean} hasNextPage @param {string | undefined} endCursor */
export function workPageInfo(hasNextPage, endCursor) {
  return {hasNextPage, endCursor: hasNextPage ? endCursor : undefined};
}
