// @ts-check

import {ValidationError} from "../errors.js";

/**
 * @param {string | undefined | null} body
 * @returns {unknown}
 */
export function parseJsonBody(body) {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }
}

/**
 * @param {URLSearchParams} searchParams
 */
export function parseListOptions(searchParams) {
  const requested = Number(searchParams.get("limit") ?? "50");
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 100) : 50;
  return {
    limit,
    cursor: searchParams.get("cursor") ?? undefined,
    search: searchParams.get("search") ?? undefined,
    status: searchParams.get("status") ?? undefined,
    health: searchParams.get("health") ?? undefined,
    ownerId: searchParams.get("ownerId") ?? undefined,
    projectId: searchParams.get("projectId") ?? undefined,
    workItemId: searchParams.get("workItemId") ?? undefined,
    assigneeId: searchParams.get("assigneeId") ?? undefined,
    portfolioId: searchParams.get("portfolioId") ?? undefined,
    periodId: searchParams.get("periodId") ?? undefined,
    intakeGroup: searchParams.get("intakeGroup") ?? undefined,
    milestoneName: searchParams.get("milestoneName") ?? undefined,
    category: searchParams.get("category") ?? undefined,
    priority: searchParams.get("priority") ?? undefined,
    phase: searchParams.get("phase") ?? undefined,
    sort: searchParams.get("sort") ?? undefined
  };
}
