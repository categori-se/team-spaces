// @ts-check

import {permissions, rolePermissions, roles} from "@teamspaces/contracts";
import {ForbiddenError} from "../errors.js";

/**
 * @param {string | {role?: string, permissions?: string[]} | undefined} roleOrMembership
 * @param {string} permission
 */
export function hasPermission(roleOrMembership, permission) {
  const membership = typeof roleOrMembership === "object" ? roleOrMembership : undefined;
  if (membership?.permissions?.includes(permission)) return true;
  const role = typeof roleOrMembership === "string" ? roleOrMembership : membership?.role;
  if (!role) return false;
  const map = /** @type {Record<string, readonly string[]>} */ (rolePermissions);
  return (map[role] ?? []).includes(permission);
}

/**
 * @param {{membership?: {role?: string}}} context
 * @param {string} permission
 */
export function requirePermission(context, permission) {
  if (!hasPermission(context.membership, permission)) {
    throw new ForbiddenError();
  }
}

export {permissions, roles};
