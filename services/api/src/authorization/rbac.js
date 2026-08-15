// @ts-check

import {permissions, rolePermissions, roles} from "@teamspaces/contracts";
import {ForbiddenError} from "../errors.js";

/**
 * @param {string | undefined} role
 * @param {string} permission
 */
export function hasPermission(role, permission) {
  if (!role) return false;
  const map = /** @type {Record<string, readonly string[]>} */ (rolePermissions);
  return (map[role] ?? []).includes(permission);
}

/**
 * @param {{membership?: {role?: string}}} context
 * @param {string} permission
 */
export function requirePermission(context, permission) {
  if (!hasPermission(context.membership?.role, permission)) {
    throw new ForbiddenError();
  }
}

export {permissions, roles};
