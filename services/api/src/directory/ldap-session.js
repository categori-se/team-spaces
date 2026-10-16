// @ts-nocheck

import {createHmac, timingSafeEqual} from "node:crypto";
import {UnauthorizedError} from "../errors.js";

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function decode(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new UnauthorizedError("LDAP session is invalid");
  }
}

function signingKey(credential) {
  const key = String(credential?.sessionSigningKey ?? "");
  if (Buffer.byteLength(key, "utf8") < 32) throw new UnauthorizedError("LDAP session signing is unavailable");
  return key;
}

function signature(value, key) {
  return createHmac("sha256", key).update(value, "utf8").digest("base64url");
}

function sameSignature(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function issueLdapSession({workspaceId, user, credential, now = Date.now(), lifetimeSeconds = 3600}) {
  const header = base64Url(JSON.stringify({alg: "HS256", typ: "JWT"}));
  const issuedAt = Math.floor(now / 1000);
  const payload = base64Url(JSON.stringify({
    iss: "team-spaces-ldap",
    aud: "team-spaces-api",
    sub: user.externalId,
    email: user.email,
    name: user.name,
    workspaceId,
    iat: issuedAt,
    exp: issuedAt + Math.min(Math.max(Number(lifetimeSeconds) || 3600, 300), 8 * 3600)
  }));
  const unsigned = `${header}.${payload}`;
  const token = `${unsigned}.${signature(unsigned, signingKey(credential))}`;
  return {access_token: token, id_token: token, token_type: "Bearer", expires_in: Math.min(Math.max(Number(lifetimeSeconds) || 3600, 300), 8 * 3600)};
}

export function unverifiedLdapSession(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) throw new UnauthorizedError("LDAP session is invalid");
  return decode(parts[1]);
}

/**
 * @param {string} token
 * @param {Record<string, any>} credential
 * @param {{workspaceId?: string, now?: number}} [options]
 */
export function verifyLdapSession(token, credential, {workspaceId, now = Date.now()} = {}) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) throw new UnauthorizedError("LDAP session is invalid");
  const [encodedHeader, encodedPayload, supplied] = parts;
  const header = decode(encodedHeader);
  const payload = decode(encodedPayload);
  const expected = signature(`${encodedHeader}.${encodedPayload}`, signingKey(credential));
  const current = Math.floor(now / 1000);
  if (header.alg !== "HS256" || header.typ !== "JWT" || !sameSignature(supplied, expected) || payload.iss !== "team-spaces-ldap" || payload.aud !== "team-spaces-api" || payload.workspaceId !== workspaceId || !payload.sub || !payload.email || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.iat > current + 60 || payload.exp <= current || payload.exp - payload.iat > 8 * 3600) {
    throw new UnauthorizedError("LDAP session is invalid or expired");
  }
  return {id: String(payload.sub), email: String(payload.email), name: String(payload.name ?? payload.email), workspaceId: payload.workspaceId, expiresAt: payload.exp * 1000};
}
