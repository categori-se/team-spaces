// @ts-check

import {ValidationError} from "../errors.js";

const cursorVersion = 1;

/** @param {{version?: unknown, projectId?: unknown}} query */
function queryFingerprint(query) {
  return JSON.stringify({
    version: query.version ?? null,
    projectId: query.projectId ?? null
  });
}

/**
 * Meeting cursors are deliberately adapter-scoped as well as query-scoped.
 * This prevents a base-table key from being interpreted as an index key (or
 * vice versa) if a caller switches between local and deployed environments.
 * @param {{adapter: "memory" | "dynamo", workspaceId: string, query: Record<string, unknown>, key: Record<string, unknown>}} value
 */
export function encodeMeetingCursor(value) {
  return Buffer.from(JSON.stringify({
    v: cursorVersion,
    adapter: value.adapter,
    workspaceId: value.workspaceId,
    query: queryFingerprint(value.query),
    key: value.key
  })).toString("base64url");
}

/**
 * @param {unknown} cursor
 * @param {{adapter: "memory" | "dynamo", workspaceId: string, query: Record<string, unknown>}} expected
 */
export function decodeMeetingCursor(cursor, expected) {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (
      parsed?.v !== cursorVersion
      || parsed.adapter !== expected.adapter
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
    throw new ValidationError("Cursor is invalid or does not match this meeting query");
  }
}

/** @param {Record<string, any>} a @param {Record<string, any>} b */
export function compareMeetings(a, b) {
  return String(a.startsAt).localeCompare(String(b.startsAt)) || String(a.id).localeCompare(String(b.id));
}

/** @param {Record<string, any>} meeting */
export function memoryMeetingCursorKey(meeting) {
  return {startsAt: String(meeting.startsAt), id: String(meeting.id)};
}

/**
 * @param {Record<string, any>} meeting
 * @param {{startsAt?: unknown, id?: unknown}} key
 */
export function isAfterMemoryMeetingCursor(meeting, key) {
  return compareMeetings(meeting, {startsAt: key.startsAt, id: key.id}) > 0;
}

/** @param {Record<string, any>} item */
export function dynamoMeetingCursorKey(item) {
  return {
    PK: item.PK,
    SK: item.SK,
    GSI1PK: item.GSI1PK,
    GSI1SK: item.GSI1SK
  };
}

/** @param {boolean} hasNextPage @param {string | undefined} endCursor */
export function meetingPageInfo(hasNextPage, endCursor) {
  return {hasNextPage, endCursor: hasNextPage ? endCursor : undefined};
}
