// @ts-check

import {createHash} from "node:crypto";

const meetingCreateOperation = "meeting.create";
export const meetingIdempotencyTtlSeconds = 24 * 60 * 60;

/** @param {unknown} value @returns {unknown} */
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

/** @param {string} value */
function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** @param {Record<string, unknown>} input */
export function meetingCreateRequestHash(input) {
  return sha256(JSON.stringify(canonicalValue(input)));
}

/**
 * Scope a caller-supplied key to the authenticated account, actor, and exact
 * mutation without persisting the raw secret-like header value.
 * @param {{workspaceId: string, actorId: string}} context
 * @param {string} idempotencyKey
 */
export function meetingCreateKeyHash(context, idempotencyKey) {
  return sha256([context.workspaceId, context.actorId, meetingCreateOperation, idempotencyKey].join("\u0000"));
}

/**
 * @param {{workspaceId: string, actorId: string}} context
 * @param {string} idempotencyKey
 */
export function meetingIdempotencyClaimKey(context, idempotencyKey) {
  const keyHash = meetingCreateKeyHash(context, idempotencyKey);
  return {
    PK: `WORKSPACE#${context.workspaceId}`,
    SK: `IDEMPOTENCY#MEETING_CREATE#${keyHash}`
  };
}

/**
 * @param {{workspaceId: string, actorId: string}} context
 * @param {string} idempotencyKey
 * @param {{requestHash: string, result: Record<string, unknown>, now: string}} values
 */
export function meetingIdempotencyClaim(context, idempotencyKey, values) {
  const keyHash = meetingCreateKeyHash(context, idempotencyKey);
  return {
    ...meetingIdempotencyClaimKey(context, idempotencyKey),
    entityType: "idempotency-claim",
    operation: meetingCreateOperation,
    workspaceId: context.workspaceId,
    actorId: context.actorId,
    keyHash,
    requestHash: values.requestHash,
    result: values.result,
    createdAt: values.now,
    expiresAt: Math.floor(new Date(values.now).getTime() / 1000) + meetingIdempotencyTtlSeconds
  };
}
