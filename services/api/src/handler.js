// @ts-check

import {createHash, timingSafeEqual} from "node:crypto";
import {demoUser} from "@teamspaces/test-fixtures";
import {ContractValidationError} from "@teamspaces/contracts";
import {MemoryRepository} from "./repositories/memory.js";
import {createDynamoRepositoryFromEnv} from "./repositories/dynamo.js";
import {
  ForbiddenError,
  HttpError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError
} from "./errors.js";
import {DynamoPublicDemoControl} from "./demo/public-demo-control.js";
import {
  createPublicDemoSeed,
  assertPublicDemoPayload,
  MemoryPublicDemoControl,
  publicDemoBodyLimitBytes,
  publicDemoIdentity,
  publicDemoMetadata,
  publicDemoPageLimit,
  publicDemoProjectIdPrefix,
  publicDemoResponseLimitBytes,
  publicDemoRequestPolicy
} from "./demo/public-demo.js";
import {log} from "./observability/log.js";
import {route} from "./routes/router.js";
import {parseJsonBody} from "./validation/http.js";
import {createLdapDirectoryRuntime} from "./directory/ldap.js";
import {verifyLdapSession} from "./directory/ldap-session.js";
import {environmentCredentialResolver} from "./integrations/provider-adapters.js";
import {createPublicCoordinationHandler, publicCoordinationPathPrefix, publicProjectsPath} from "./public-coordination.js";

const defaultRepository = process.env.TABLE_NAME ? createDynamoRepositoryFromEnv() : new MemoryRepository();
const defaultPublicDemoRepository = process.env.TABLE_NAME
  ? createDynamoRepositoryFromEnv()
  : new MemoryRepository(createPublicDemoSeed("a"));
const defaultPublicDemoControl = process.env.TABLE_NAME
  ? new DynamoPublicDemoControl({tableName: process.env.TABLE_NAME})
  : new MemoryPublicDemoControl({slot: "a"});
const defaultLdapRuntime = createLdapDirectoryRuntime({resolveCredential: environmentCredentialResolver()});

/**
 * @param {Record<string, string | undefined>} headers
 * @param {string} name
 */
function header(headers, name) {
  const lower = name.toLowerCase();
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === lower)?.[1];
}

/** @param {Record<string, string | undefined>} headers */
function requestCorrelationId(headers) {
  const supplied = header(headers, "x-correlation-id");
  return typeof supplied === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)
    ? supplied
    : crypto.randomUUID();
}

/** @param {unknown} value */
function safeLogPath(value) {
  return String(value ?? "")
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, 256);
}

/**
 * Translate mutation paths into stable integration event names. The explicit
 * webhook delivery endpoint is a test/replay surface and must never publish
 * itself recursively.
 * @param {string} method
 * @param {string} rawPath
 */
export function mutationWebhookEvent(method, rawPath) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return undefined;
  const path = rawPath.replace(/^\/api\/v1(?:\/demo)?/, "") || "/";
  if (/^\/(?:webhooks\/[^/]+\/deliver|notifications\/digest\/deliver|mcp)(?:\/|$)/.test(path)) return undefined;
  /** @type {Array<[RegExp, string]>} */
  const rules = [
    [/^\/projects\/[^/]+\/work-items\/[^/]+\/actions\//, "work.custom-action"],
    [/^\/projects\/[^/]+\/work-items\/[^/]+\/copy$/, "work.copied"],
    [/^\/projects\/[^/]+\/work-items\/[^/]+\/move$/, "work.moved"],
    [/^\/projects\/[^/]+\/work-items\/[^/]+$/, `work.${method === "DELETE" ? "deleted" : "updated"}`],
    [/^\/projects\/[^/]+\/work-items$/, "work.created"],
    [/^\/projects\/[^/]+\/copy$/, "project.copied"],
    [/^\/projects\/[^/]+\/(?:archive|restore)$/, `project.${path.endsWith("/archive") ? "archived" : "restored"}`],
    [/^\/projects\/[^/]+$/, `project.${method === "DELETE" ? "deleted" : "updated"}`],
    [/^\/projects$/, "project.created"],
    [/^\/meetings\/[^/]+\/attendance$/, "meeting.attendance-updated"],
    [/^\/meetings\/[^/]+\/copy$/, "meeting.copied"],
    [/^\/meetings\/[^/]+$/, `meeting.${method === "DELETE" ? "deleted" : "updated"}`],
    [/^\/meetings$/, "meeting.created"],
    [/^\/project-content\/[^/]+\/operations$/, "content.operation-applied"],
    [/^\/project-content\/[^/]+\/presence$/, "content.presence-updated"],
    [/^\/project-content\/[^/]+$/, `content.${method === "DELETE" ? "deleted" : "updated"}`],
    [/^\/project-content$/, "content.created"],
    [/^\/time-entries\/[^/]+$/, `time.${method === "DELETE" ? "deleted" : "updated"}`],
    [/^\/time-entries$/, "time.created"],
    [/^\/activity$/, "comment.created"],
    [/^\/documents\/[^/]+\/scan$/, "document.scanned"],
    [/^\/documents\/[^/]+\/scan-request$/, "document.scan-requested"],
    [/^\/documents\/finalize$/, "document.finalized"],
    [/^\/documents\/upload-intent$/, "document.upload-requested"],
    [/^\/documents\/[^/]+$/, "document.updated"],
    [/^\/planning-resources/, "planning.updated"],
    [/^\/capabilities$/, "capabilities.updated"],
    [/^\/directory\/sync$/, "directory.synchronized"],
    [/^\/external-shares/, "external-share.updated"],
    [/^\/integration-links/, "integration-link.updated"],
    [/^\/integrations\//, "integration.event-received"]
  ];
  return rules.find(([pattern]) => pattern.test(path))?.[1];
}

/** @param {string} left @param {string} right */
function sameSecret(left, right) {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

/**
 * Origin verification has an explicit observation phase so CloudFront can
 * finish propagating a selected secret before Lambda starts enforcing it.
 * During rotation Lambda accepts both populated slots while CloudFront sends
 * exactly one, making either resource update order safe.
 *
 * @param {Record<string, string | undefined>} headers
 * @param {Record<string, string | undefined>} [environment]
 */
export function originVerificationAllows(headers, environment = process.env) {
  const secrets = /** @type {string[]} */ (
    [environment.ORIGIN_VERIFY_SECRET, environment.ORIGIN_VERIFY_SECRET_NEXT]
      .filter((value) => typeof value === "string" && value.length > 0)
  );
  const enforcement = environment.ORIGIN_VERIFY_ENFORCED;
  if (enforcement === "false") return true;
  if (enforcement === undefined && secrets.length === 0) return true;
  if (enforcement !== "true") return false;
  const supplied = header(headers, "x-teamspaces-origin-secret");
  return typeof supplied === "string" && secrets.some((secret) => sameSecret(supplied, secret));
}

/** @param {Record<string, string | undefined>} headers */
function parseIdempotencyKey(headers) {
  const value = header(headers, "idempotency-key");
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new ValidationError("Idempotency-Key must be 8 to 128 ASCII letters, digits, dot, underscore, colon, or hyphen");
  }
  return value;
}

/**
 * API Gateway exposes both a raw path and a normalized URL path. The public
 * demo allowlist and the application router must make their decision from the
 * exact same representation; otherwise dot segments or backslashes can make
 * an allowed-looking path resolve to a protected endpoint.
 *
 * Public-demo route identifiers are generated by Team Spaces and use only
 * ASCII letters, digits, underscores, and hyphens, so encoded or otherwise
 * ambiguous path characters can be rejected without reducing functionality.
 *
 * @param {string} rawPath
 * @param {string} normalizedPath
 */
function publicDemoPathIsCanonical(rawPath, normalizedPath) {
  return rawPath === normalizedPath
    && /^\/[A-Za-z0-9_/-]*$/.test(rawPath)
    && !rawPath.includes("//")
    && !rawPath.split("/").some((segment) => segment === "." || segment === "..");
}

/**
 * @param {any} event
 */
function identityFromEvent(event) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  if (claims?.sub) {
    return {
      id: String(claims.sub),
      email: String(claims.email ?? ""),
      name: String(claims.name ?? claims.email ?? claims.sub)
    };
  }
  if (process.env.ALLOW_DEMO_AUTH === "true") {
    return {
      id: header(event.headers ?? {}, "x-demo-user-id") ?? demoUser.id,
      email: header(event.headers ?? {}, "x-demo-user-email") ?? demoUser.email,
      name: header(event.headers ?? {}, "x-demo-user-name") ?? demoUser.name
    };
  }
  throw new UnauthorizedError();
}

/**
 * @param {{repository?: any, ldapRuntime?: any}} [dependencies]
 */
export function createHandler(dependencies = {}) {
  const repository = dependencies.repository ?? defaultRepository;
  const privateHandler = createRequestHandler({
    repository,
    ldapRuntime: dependencies.ldapRuntime ?? defaultLdapRuntime,
    publicDemoMode: false
  });
  const publicHandler = createPublicCoordinationHandler({repository, originAllows: originVerificationAllows});
  return (/** @type {any} */ event) => {
    const path = event?.rawPath ?? event?.path ?? "";
    return path.startsWith(publicCoordinationPathPrefix) || path === publicProjectsPath || path.startsWith(`${publicProjectsPath}/`) ? publicHandler(event) : privateHandler(event);
  };
}

/**
 * Build the unauthenticated, isolated public-demo handler. The caller never
 * supplies identity or account selection; both come from the active demo
 * pointer in the dedicated demo table.
 *
 * @param {{repository?: any, ldapRuntime?: any, control?: any, enabled?: boolean}} [dependencies]
 */
export function createPublicDemoHandler(dependencies = {}) {
  return createRequestHandler({
    repository: dependencies.repository ?? defaultPublicDemoRepository,
    ldapRuntime: dependencies.ldapRuntime ?? defaultLdapRuntime,
    publicDemoControl: dependencies.control ?? defaultPublicDemoControl,
    publicDemoMode: true,
    publicDemoEnabled: dependencies.enabled ?? true
  });
}

/**
 * @param {{repository: any, ldapRuntime: any, publicDemoControl?: any, publicDemoMode: boolean, publicDemoEnabled?: boolean}} options
 */
function createRequestHandler(options) {
  const {repository, ldapRuntime, publicDemoControl, publicDemoMode, publicDemoEnabled = true} = options;
  /** @param {any} event */
  return async function handler(event) {
    const method = event?.requestContext?.http?.method ?? event?.httpMethod ?? "GET";
    const rawPath = event?.rawPath ?? event?.path ?? "/";
    const rawQueryString = event?.rawQueryString ?? "";
    const publicHealthRequest = method === "GET" && rawPath === "/api/v1/health";
    const rawProviderWebhookRequest = !publicDemoMode && method === "POST" && /^\/api\/v1\/provider-webhooks\/[^/]+\/[^/]+$/.test(rawPath);
    const rawProviderApiRequest = !publicDemoMode && ["GET", "POST"].includes(method) && /^\/api\/v1\/provider-api\/[^/]+\/[^/]+\/work-items$/.test(rawPath);
    const rawLdapLoginRequest = !publicDemoMode && method === "POST" && /^\/api\/v1\/ldap-auth\/[^/]+$/.test(rawPath);
    const rawLdapApiRequest = !publicDemoMode && /^\/api\/v1\/ldap\/[^/]+\/.+/.test(rawPath);
    let publicPageLimit = publicDemoPageLimit;
    const correlationId = requestCorrelationId(event.headers ?? {});
    const origin = header(event.headers ?? {}, "origin") ?? "";
    const localOrigin = process.env.ALLOW_DEMO_AUTH === "true"
      && (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:"));
    const allowedOrigin = localOrigin ? origin : (process.env.APP_ORIGIN ?? "https://team-spaces.invalid");
    const baseHeaders = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-correlation-id": correlationId,
      "access-control-allow-origin": allowedOrigin,
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "authorization,content-type,x-correlation-id,idempotency-key,x-demo-user-id,x-demo-user-email,x-demo-user-name,x-teamspaces-account-id",
      "access-control-expose-headers": "x-correlation-id"
    };

    if (method === "OPTIONS") {
      return {statusCode: 204, headers: baseHeaders, body: ""};
    }

    try {
      if (!rawProviderWebhookRequest && !rawProviderApiRequest && !originVerificationAllows(event.headers ?? {})) {
        throw new ForbiddenError("Requests must use the supported application entry point");
      }
      if (
        publicDemoMode
        && process.env.PUBLIC_DEMO_HOST_REQUIRED === "true"
        && header(event.headers ?? {}, "x-teamspaces-public-demo-host") !== "true"
      ) {
        throw new ForbiddenError("Use the supported public demo entry point.");
      }
      const url = new URL(`https://api.local${rawPath}${rawQueryString ? `?${rawQueryString}` : ""}`);
      if (publicDemoMode && !publicDemoPathIsCanonical(rawPath, url.pathname)) {
        throw new ForbiddenError("This operation is not available in the shared demo.");
      }
      const requestPath = url.pathname;
      const providerWebhookMatch = rawProviderWebhookRequest && requestPath === rawPath
        ? requestPath.match(/^\/api\/v1\/provider-webhooks\/([^/]+)\/([^/]+)$/)
        : undefined;
      const providerApiMatch = rawProviderApiRequest && requestPath === rawPath ? requestPath.match(/^\/api\/v1\/provider-api\/([^/]+)\/([^/]+)\/work-items$/) : undefined;
      const ldapLoginMatch = rawLdapLoginRequest && requestPath === rawPath ? requestPath.match(/^\/api\/v1\/ldap-auth\/([^/]+)$/) : undefined;
      const ldapApiMatch = rawLdapApiRequest && requestPath === rawPath ? requestPath.match(/^\/api\/v1\/ldap\/([^/]+)(\/.*)$/) : undefined;
      const demoPolicy = publicDemoMode ? publicDemoRequestPolicy(method, requestPath) : undefined;
      const publicHealth = !publicDemoMode && publicHealthRequest && requestPath === "/api/v1/health";
      if (publicDemoMode && !publicDemoEnabled) {
        throw new ServiceUnavailableError("The shared demo is not enabled.");
      }
      if (publicDemoMode && !demoPolicy?.allowed) {
        throw new ForbiddenError("This operation is not available in the shared demo.");
      }
      if (publicDemoMode && method === "GET") {
        const suppliedLimit = url.searchParams.get("limit");
        if (suppliedLimit === null || !/^[1-9]\d*$/.test(suppliedLimit) || Number(suppliedLimit) > publicDemoPageLimit) {
          url.searchParams.set("limit", String(publicDemoPageLimit));
        }
        publicPageLimit = Number(url.searchParams.get("limit"));
      }
      if (publicDemoMode || publicHealth) {
        const bodyBytes = event?.isBase64Encoded
          ? Buffer.from(event?.body ?? "", "base64").byteLength
          : Buffer.byteLength(event?.body ?? "", "utf8");
        if (bodyBytes > publicDemoBodyLimitBytes) {
          throw new PayloadTooLargeError(`Public API request bodies must not exceed ${publicDemoBodyLimitBytes} bytes.`);
        }
        if (["GET", "HEAD"].includes(method) && bodyBytes > 0) {
          throw new ValidationError("Public API read requests must not include a body.");
        }
      }
      if (rawProviderWebhookRequest || rawProviderApiRequest || rawLdapLoginRequest) {
        const bodyBytes = event?.isBase64Encoded ? Buffer.from(event?.body ?? "", "base64").byteLength : Buffer.byteLength(event?.body ?? "", "utf8");
        const limit = rawLdapLoginRequest ? 8 * 1024 : rawProviderApiRequest ? 128 * 1024 : 1024 * 1024;
        if (bodyBytes > limit) throw new PayloadTooLargeError(`Service request bodies must not exceed ${limit} bytes.`);
        if (method === "GET" && bodyBytes) throw new ValidationError("Service API read requests must not include a body.");
      }
      const idempotencyKey = method === "POST" && requestPath.endsWith("/meetings")
        ? parseIdempotencyKey(event.headers ?? {})
        : undefined;
      const activeDemo = publicDemoMode ? await publicDemoControl.getActive() : undefined;
      if (publicDemoMode && demoPolicy?.mutation) {
        const claimed = await publicDemoControl.claimMutation(demoPolicy, activeDemo);
        if (claimed === false) {
          throw new TooManyRequestsError("The shared demo has reached its daily edit limit. It will reset automatically.");
        }
      }
      let requestedAccountId = header(event.headers ?? {}, "x-teamspaces-account-id");
      if (publicDemoMode) requestedAccountId = activeDemo.workspaceId;
      if (ldapApiMatch) requestedAccountId = decodeURIComponent(ldapApiMatch[1]);
      if (ldapLoginMatch) requestedAccountId = decodeURIComponent(ldapLoginMatch[1]);
      if (providerApiMatch) requestedAccountId = decodeURIComponent(providerApiMatch[1]);
      if (providerWebhookMatch) requestedAccountId = decodeURIComponent(providerWebhookMatch[1]);
      const scimServiceRequest = !publicDemoMode && requestPath.startsWith("/api/v1/scim/v2/");
      const scannerServiceRequest = !publicDemoMode && method === "POST" && /^\/api\/v1\/documents\/[^/]+\/scan$/.test(requestPath);
      let identity;
      let bootstrap;
      if (providerApiMatch) {
        const connectorId = decodeURIComponent(providerApiMatch[2]);
        identity = {id: `provider-api-${connectorId}`, email: "provider-api@service.invalid", name: "Provider API service"};
        const workspace = await repository.getWorkspace({workspaceId: requestedAccountId});
        if (workspace.id !== requestedAccountId) throw new UnauthorizedError("Provider API account is invalid");
        bootstrap = {workspace, user: identity, membership: {role: "workspace-admin", status: "active"}};
      } else if (ldapLoginMatch) {
        identity = {id: "ldap-login-service", email: "ldap-login@service.invalid", name: "LDAP login service"};
        const workspace = await repository.getWorkspace({workspaceId: requestedAccountId});
        if (workspace.id !== requestedAccountId) throw new UnauthorizedError("LDAP authentication is unavailable");
        bootstrap = {workspace, user: identity, membership: {role: "workspace-admin", status: "active"}};
      } else if (ldapApiMatch) {
        const supplied = (header(event.headers ?? {}, "authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
        const capabilities = await repository.getWorkspaceCapabilities({workspaceId: requestedAccountId});
        if (!capabilities.authentication?.ldap?.enabled) throw new UnauthorizedError("LDAP authentication is unavailable");
        const credential = await ldapRuntime.credential(capabilities.authentication.ldap);
        identity = verifyLdapSession(supplied, credential, {workspaceId: requestedAccountId});
        bootstrap = await repository.getOrBootstrap(identity, requestedAccountId);
      } else if (providerWebhookMatch) {
        const connectorId = decodeURIComponent(providerWebhookMatch[2]);
        identity = {id: `provider-${connectorId}`, email: "provider@service.invalid", name: "Provider webhook service"};
        const workspace = await repository.getWorkspace({workspaceId: requestedAccountId});
        if (workspace.id !== requestedAccountId) throw new UnauthorizedError("Provider webhook account is invalid");
        bootstrap = {workspace, user: identity, membership: {role: "workspace-admin", status: "active"}};
      } else if (scimServiceRequest || scannerServiceRequest) {
        if (!requestedAccountId) throw new UnauthorizedError(`${scimServiceRequest ? "SCIM" : "Scanner"} requests require an account identifier`);
        const authorization = header(event.headers ?? {}, "authorization") ?? "";
        const supplied = authorization.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
        const capabilities = await repository.getWorkspaceCapabilities({workspaceId: requestedAccountId});
        const expectedHash = String(scimServiceRequest ? capabilities.scim?.bearerCredentialHash : capabilities.security?.scannerCredentialHash ?? "");
        const suppliedHash = supplied ? createHash("sha256").update(supplied, "utf8").digest("hex") : "";
        const serviceEnabled = scimServiceRequest ? capabilities.scim?.enabled : capabilities.security?.malwareScanning !== "disabled";
        if (!serviceEnabled || !/^[a-f0-9]{64}$/i.test(expectedHash) || !suppliedHash || !sameSecret(suppliedHash, expectedHash.toLowerCase())) {
          throw new UnauthorizedError(`${scimServiceRequest ? "SCIM" : "Scanner"} bearer token is invalid`);
        }
        identity = scimServiceRequest
          ? {id: "scim-service", email: "scim@service.invalid", name: "SCIM provisioning service"}
          : {id: "scanner-service", email: "scanner@service.invalid", name: "Document scanner service"};
        bootstrap = {workspace: await repository.getWorkspace({workspaceId: requestedAccountId}), user: identity, membership: {role: "workspace-admin", status: "active"}};
      } else {
        identity = publicDemoMode
          ? publicDemoIdentity(activeDemo.activeSlot)
          : publicHealth ? demoUser : identityFromEvent(event);
        bootstrap = publicHealth ? {workspace: {id: "health"}, user: identity, membership: {role: "viewer"}} : await repository.getOrBootstrap(identity, requestedAccountId);
      }
      if (!publicHealth && String(bootstrap.membership?.role ?? "").startsWith("custom:")) {
        const capabilities = await repository.getWorkspaceCapabilities({workspaceId: bootstrap.workspace.id});
        const roleId = String(bootstrap.membership.role).slice("custom:".length);
        const customRole = capabilities.customRoles?.find((/** @type {any} */ role) => role.id === roleId);
        bootstrap.membership = {...bootstrap.membership, permissions: customRole?.permissions ?? []};
      }
      const requestBody = event?.isBase64Encoded ? Buffer.from(event?.body ?? "", "base64").toString("utf8") : event?.body;
      const body = ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? parseJsonBody(requestBody) : {};
      if (publicDemoMode) {
        try {
          assertPublicDemoPayload(body);
        } catch (error) {
          throw new ValidationError(error instanceof Error ? error.message : "Shared demo content is invalid");
        }
      }
      const context = {
        correlationId,
        actorId: bootstrap.user.id,
        user: bootstrap.user,
        workspace: bootstrap.workspace,
        workspaceId: bootstrap.workspace.id,
        membership: bootstrap.membership,
        idempotencyKey,
        ...(!providerWebhookMatch && !publicDemoMode ? {providerToken: (header(event.headers ?? {}, "authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1]} : {}),
        ...(providerWebhookMatch ? {providerWebhook: true} : {}),
        ...(providerApiMatch ? {providerApi: true} : {}),
        ...(ldapLoginMatch ? {ldapLogin: true} : {}),
        ...(ldapApiMatch ? {ldapSession: true} : {}),
        ...(publicDemoMode ? {
          publicDemo: {
            slot: activeDemo.activeSlot,
            pageLimit: publicPageLimit,
            projectIdPrefix: publicDemoProjectIdPrefix(activeDemo.activeSlot),
            metadata: typeof publicDemoControl.metadata === "function"
              ? publicDemoControl.metadata(activeDemo)
              : publicDemoMetadata(activeDemo)
          }
        } : {})
      };
      const routedPath = ldapApiMatch ? `/api/v1${ldapApiMatch[2]}` : requestPath;
      const result = await route({method, path: routedPath, searchParams: url.searchParams, body, context, repository, ldapRuntime, headers: event.headers ?? {}, rawBody: requestBody ?? ""});
      const webhookEvent = publicDemoMode ? undefined : mutationWebhookEvent(method, routedPath);
      if (webhookEvent && typeof repository.publishWebhookEvent === "function") {
        try {
          await repository.publishWebhookEvent(context, webhookEvent, result?.body !== undefined ? result.body : result);
        } catch (error) {
          log("warn", "automatic webhook publication failed", {correlationId, eventType: webhookEvent, errorName: error instanceof Error ? error.name : "UnknownError"});
        }
      }
      const statusCode = typeof result?.statusCode === "number" ? result.statusCode : 200;
      const payload = result?.body !== undefined ? result.body : result;
      const responseBody = JSON.stringify(result?.rawJson ?? {data: payload, correlationId});
      if (publicDemoMode && Buffer.byteLength(responseBody, "utf8") > publicDemoResponseLimitBytes) {
        throw new PayloadTooLargeError("The shared demo result is too large. Narrow the selected project or filters and try again.");
      }
      return {statusCode, headers: baseHeaders, body: responseBody};
    } catch (error) {
      const httpError = error instanceof HttpError
        ? error
        : error instanceof ContractValidationError
          ? new ValidationError(error.message)
          : new HttpError(500, "Internal Server Error", "An unexpected error occurred");
      // API Gateway metrics retain aggregate 4xx visibility. Avoid logging one
      // attacker-controlled record for every anonymous validation failure;
      // doing so would turn the public demo into a CloudWatch cost amplifier.
      if ((!publicDemoMode && !publicHealthRequest) || httpError.status >= 500) {
        log(httpError.status >= 500 ? "error" : "warn", "request failed", {
          correlationId,
          status: httpError.status,
          title: httpError.title,
          path: safeLogPath(rawPath),
          method,
          errorName: error instanceof Error ? error.name : "UnknownError"
        });
      }
      return {
        statusCode: httpError.status,
        headers: baseHeaders,
        body: JSON.stringify({
          type: `urn:team-spaces:problem:${httpError.title.toLowerCase().replaceAll(" ", "-")}`,
          title: httpError.title,
          status: httpError.status,
          detail: httpError.detail,
          correlationId
        })
      };
    }
  };
}

export const handler = createHandler();
export const publicDemoHandler = createPublicDemoHandler({
  enabled: process.env.PUBLIC_DEMO_MODE === "true"
});
