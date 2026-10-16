// @ts-nocheck

import {beginSignIn, currentSession, getAccessToken, handleAuthCallback, runtimeConfig, signOut} from "./auth.js";

export class ApiError extends Error {
  constructor(problem) {
    super(problem.detail ?? problem.title ?? "API request failed");
    this.name = "ApiError";
    this.problem = problem;
    this.status = problem.status ?? 0;
    this.correlationId = problem.correlationId;
  }
}

export async function putUpload(uploadUrl, file, uploadHeaders = {}) {
  const response = await fetch(uploadUrl, {method: "PUT", headers: uploadHeaders, body: file});
  if (!response.ok) throw new Error(`Document upload failed (${response.status})`);
  return response;
}

/**
 * @param {Record<string, unknown>} params
 */
function query(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (["signal", "idempotencyKey", "refreshVersion"].includes(key)) continue;
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function meetingListPath(projectId, options = {}) {
  if (!projectId) throw new Error("A project is required to list meetings");
  return `/meetings${query({projectId, limit: options.limit, cursor: options.cursor})}`;
}

export function meetingDetailPath(projectId, meetingId) {
  if (!projectId) throw new Error("A project is required to open a meeting");
  if (!meetingId) throw new Error("A meeting is required");
  return `/meetings/${encodeURIComponent(meetingId)}${query({projectId})}`;
}

function normalizeSignal(signal) {
  if (!signal) return undefined;
  if (typeof AbortSignal !== "undefined" && signal instanceof AbortSignal) return signal;
  if (typeof signal.then === "function") {
    const controller = new AbortController();
    signal.then(() => controller.abort(), () => controller.abort());
    return controller.signal;
  }
  return undefined;
}

const accountStorageKey = "teamspaces.accountId";

export function selectedAccountId() {
  try {
    return localStorage.getItem(accountStorageKey) ?? "";
  } catch {
    return "";
  }
}

export function selectAccount(accountId = "") {
  try {
    if (accountId) localStorage.setItem(accountStorageKey, accountId);
    else localStorage.removeItem(accountStorageKey);
  } catch {
    // Ignore storage failures; the API will fall back to the user's default account.
  }
}

export async function publicCoordinationClient() {
  const config = await runtimeConfig();
  return Object.freeze({
    isPublicCoordination: true,
    projects: Object.freeze({
      list: async (options = {}) => {
        const response = await fetch(`${config.apiBaseUrl}/public/projects`, {method: "GET", credentials: "omit", cache: "no-store", signal: normalizeSignal(options.signal)});
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new ApiError({status: response.status, detail: payload.detail ?? "Public projects are unavailable"});
        const data = payload.data;
        if (data?.audience !== "public" || data.readOnly !== true || !Array.isArray(data.projects)) throw new ApiError({status: 502, detail: "The public projects response is unavailable"});
        return data;
      }
    }),
    coordination: Object.freeze({
      get: async (options = {}) => {
        const initiativeId = options.initiativeId;
        if (typeof initiativeId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(initiativeId)) throw new Error("Choose a public project to view its roadmap");
        const response = await fetch(`${config.apiBaseUrl}/public/coordination/${encodeURIComponent(initiativeId)}`, {
          method: "GET",
          credentials: "omit",
          cache: "no-store",
          signal: normalizeSignal(options.signal)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new ApiError({status: response.status, detail: payload.detail ?? "The public project roadmap is unavailable"});
        const data = payload.data ?? payload;
        if (data.audience !== "public" || data.sample !== false || data.readOnly !== true) {
          throw new ApiError({status: 502, detail: "The public project roadmap response is unavailable"});
        }
        return data;
      }
    })
  });
}

export async function apiClient() {
  await handleAuthCallback();
  const config = await runtimeConfig();
  const session = await currentSession();
  const isPublicDemo = session.mode === "public-demo";
  const baseUrl = isPublicDemo
    ? config.publicDemo.apiBaseUrl
    : session.mode === "ldap"
      ? `${config.apiBaseUrl}/ldap/${encodeURIComponent(session.workspaceId)}`
    : config.apiBaseUrl ?? "/api/v1";

  /**
   * @param {string} method
   * @param {string} path
   * @param {{body?: unknown, signal?: AbortSignal, idempotencyKey?: string}} [options]
   */
  async function request(method, path, options = {}) {
    const correlationId = crypto.randomUUID();
    const headers = {
      "content-type": "application/json",
      "x-correlation-id": correlationId
    };
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    const accountId = isPublicDemo ? "" : selectedAccountId();
    if (accountId) headers["x-teamspaces-account-id"] = accountId;
    const token = isPublicDemo ? undefined : await getAccessToken();
    if (token) headers.authorization = `Bearer ${token}`;
    if (!isPublicDemo && config.authMode === "demo") {
      headers["x-demo-user-id"] = "user-demo-admin";
      headers["x-demo-user-email"] = "admin@team-spaces.example";
      headers["x-demo-user-name"] = "Demo Admin";
    }
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      signal: normalizeSignal(options.signal),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store"
    });
    const payload = response.status === 204 ? undefined : await response.json().catch(() => undefined);
    const responseProblem = {
      ...(payload && typeof payload === "object" ? payload : {}),
      status: payload?.status ?? response.status,
      title: payload?.title || response.statusText || "Request failed",
      detail: payload?.detail ?? payload?.message
    };
    if (response.status === 401) {
      if (!isPublicDemo) await (session.mode === "ldap" ? signOut() : beginSignIn());
      throw new ApiError({
        ...responseProblem,
        title: responseProblem.title || "Unauthorized",
        detail: responseProblem.detail || (isPublicDemo ? "The public demo is temporarily unavailable" : "Session expired"),
        correlationId: responseProblem.correlationId ?? correlationId
      });
    }
    if (!response.ok) throw new ApiError({...responseProblem, correlationId: responseProblem.correlationId ?? correlationId});
    const data = payload?.data ?? payload;
    const capabilities = data?.capabilities ?? (path === "/capabilities" ? data : undefined);
    if (capabilities && typeof window !== "undefined") window.dispatchEvent(new CustomEvent("teamspaces:capabilities", {detail: capabilities}));
    return data;
  }

  return {
    mode: session.mode,
    isPublicDemo,
    publicDemo: isPublicDemo ? config.publicDemo : undefined,
    request,
    bootstrap: (options = {}) => request("GET", "/bootstrap", options),
    me: (options = {}) => request("GET", "/me", options),
    profile: {
      patch: (body, options = {}) => request("PATCH", "/me/profile", {body, ...options})
    },
    workspace: {
      get: (options = {}) => request("GET", "/workspace", options),
      patch: (body, options = {}) => request("PATCH", "/workspace", {body, ...options})
    },
    capabilities: {
      get: (options = {}) => request("GET", "/capabilities", options),
      patch: (body, options = {}) => request("PATCH", "/capabilities", {body, ...options})
    },
    workConfiguration: {
      get: (options = {}) => request("GET", "/work-configuration", options),
      patch: (body, options = {}) => request("PATCH", "/work-configuration", {body, ...options})
    },
    accounts: {
      list: (options = {}) => request("GET", "/accounts", options),
      create: (body, options = {}) => request("POST", "/accounts", {body, ...options}),
      select: selectAccount,
      selected: selectedAccountId
    },
    memberships: {
      list: (options = {}) => request("GET", `/memberships${query(options)}`, options),
      create: (body, options = {}) => request("POST", "/memberships", {body, ...options}),
      patch: (userId, body, options = {}) => request("PATCH", `/memberships/${userId}`, {body, ...options})
    },
    placeholders: {
      list: (options = {}) => request("GET", "/placeholders", options),
      create: (body, options = {}) => request("POST", "/placeholders", {body, ...options})
    },
    portfolios: {
      list: (options = {}) => request("GET", `/portfolios${query(options)}`, options),
      create: (body, options = {}) => request("POST", "/portfolios", {body, ...options}),
      patch: (id, body, options = {}) => request("PATCH", `/portfolios/${id}`, {body, ...options})
    },
    projects: {
      list: (options = {}) => request("GET", `/projects${query(options)}`, options),
      get: (id, options = {}) => request("GET", `/projects/${id}`, options),
      create: (body, options = {}) => request("POST", "/projects", {body, ...options}),
      patch: (id, body, options = {}) => request("PATCH", `/projects/${id}`, {body, ...options}),
      submitInitiation: (id, body, options = {}) => request("POST", `/projects/${id}/initiation/submit`, {body, ...options}),
      reviewInitiation: (id, body, options = {}) => request("POST", `/projects/${id}/initiation/review`, {body, ...options}),
      approveGate: (id, gateId, body, options = {}) => request("POST", `/projects/${id}/lifecycle-gates/${encodeURIComponent(gateId)}/approve`, {body, ...options}),
      copy: (id, body = {}, options = {}) => request("POST", `/projects/${id}/copy`, {body, ...options}),
      archive: (id, body, options = {}) => request("POST", `/projects/${id}/archive`, {body, ...options}),
      restore: (id, body, options = {}) => request("POST", `/projects/${id}/restore`, {body, ...options}),
      delete: (id, body, options = {}) => request("DELETE", `/projects/${id}`, {body, ...options})
    },
    workItems: {
      assigned: (options = {}) => request("GET", "/work-items/assigned", options),
      list: (projectId, options = {}) => request("GET", `/projects/${projectId}/work-items${query(options)}`, options),
      create: (projectId, body, options = {}) => request("POST", `/projects/${projectId}/work-items`, {body, ...options}),
      patch: (projectId, id, body, options = {}) => request("PATCH", `/projects/${projectId}/work-items/${id}`, {body, ...options}),
      copy: (projectId, id, body = {}, options = {}) => request("POST", `/projects/${projectId}/work-items/${id}/copy`, {body, ...options}),
      move: (projectId, id, body, options = {}) => request("POST", `/projects/${projectId}/work-items/${id}/move`, {body, ...options}),
      action: (projectId, id, actionId, body, options = {}) => request("POST", `/projects/${projectId}/work-items/${id}/actions/${encodeURIComponent(actionId)}`, {body, ...options}),
      delete: (projectId, id, body, options = {}) => request("DELETE", `/projects/${projectId}/work-items/${id}`, {body, ...options})
    },
    planning: {
      dashboard: (options = {}) => request("GET", `/planning${query(options)}`, options),
      schedule: (projectId, options = {}) => request("POST", `/projects/${encodeURIComponent(projectId)}/schedule`, {body: {}, ...options}),
      baselineComparison: (projectId, options = {}) => request("GET", `/projects/${encodeURIComponent(projectId)}/baseline-comparison${query(options)}`, options)
    },
    coordination: {
      get: (options = {}) => request("GET", `/coordination${query(options)}`, options),
      setup: (body, options = {}) => request("POST", "/coordination/setup", {body, ...options})
    },
    planningResources: {
      list: (projectId, options = {}) => request("GET", `/planning-resources${query({projectId, ...options})}`, options),
      get: (projectId, id, options = {}) => request("GET", `/planning-resources/${encodeURIComponent(id)}${query({projectId})}`, options),
      create: (body, options = {}) => request("POST", "/planning-resources", {body, ...options}),
      patch: (projectId, id, body, options = {}) => request("PATCH", `/planning-resources/${encodeURIComponent(id)}${query({projectId})}`, {body, ...options}),
      delete: (projectId, id, body, options = {}) => request("DELETE", `/planning-resources/${encodeURIComponent(id)}${query({projectId})}`, {body, ...options}),
      baselineComparison: (projectId, id, options = {}) => request("GET", `/planning-resources/${encodeURIComponent(id)}/baseline-comparison${query({projectId})}`, options),
      burndown: (projectId, id, options = {}) => request("GET", `/planning-resources/${encodeURIComponent(id)}/burndown${query({projectId})}`, options)
    },
    meetings: {
      list: (projectId, options = {}) => request("GET", meetingListPath(projectId, options), options),
      all: (options = {}) => request("GET", `/meetings${query(options)}`, options),
      get: (projectId, id, options = {}) => request("GET", meetingDetailPath(projectId, id), options),
      create: (projectId, body, options = {}) => request("POST", "/meetings", {body: {...body, projectId}, ...options}),
      patch: (projectId, id, body, options = {}) => request("PATCH", `/meetings/${encodeURIComponent(id)}`, {body: {...body, projectId}, ...options}),
      copy: (projectId, id, body = {}, options = {}) => request("POST", `/meetings/${encodeURIComponent(id)}/copy`, {body: {...body, projectId}, ...options}),
      delete: (projectId, id, body, options = {}) => request("DELETE", `/meetings/${encodeURIComponent(id)}${query({projectId})}`, {body, ...options}),
      attendance: (projectId, id, body, options = {}) => request("POST", `/meetings/${encodeURIComponent(id)}/attendance${query({projectId})}`, {body, ...options}),
      calendar: (projectId, id, options = {}) => request("GET", `/meetings/${encodeURIComponent(id)}/calendar${query({projectId})}`, options),
      pdf: (projectId, id, options = {}) => request("GET", `/meetings/${encodeURIComponent(id)}/pdf${query({projectId})}`, options)
    },
    timeEntries: {
      list: (options = {}) => request("GET", `/time-entries${query(options)}`, options),
      create: (body, options = {}) => request("POST", "/time-entries", {body, ...options}),
      patch: (id, body, options = {}) => request("PATCH", `/time-entries/${id}`, {body, ...options}),
      delete: (id, body, options = {}) => request("DELETE", `/time-entries/${id}`, {body, ...options})
    },
    timer: {
      get: (options = {}) => request("GET", "/timer", options),
      start: (body, options = {}) => request("POST", "/timer/start", {body, ...options}),
      stop: (options = {}) => request("POST", "/timer/stop", {body: {}, ...options})
    },
    activity: {
      list: (options = {}) => request("GET", `/activity${query(options)}`, options),
      create: (body, options = {}) => request("POST", "/activity", {body, ...options})
    },
    notifications: {
      list: (options = {}) => request("GET", `/notifications${query(options)}`, options),
      preferences: (options = {}) => request("GET", "/notification-preferences", options),
      savePreferences: (body, options = {}) => request("PATCH", "/notification-preferences", {body, ...options}),
      markRead: (ids, read = true, options = {}) => request("POST", "/notifications/read", {body: {ids, read}, ...options}),
      markAllRead: (options = {}) => request("POST", "/notifications/read-all", {body: {}, ...options}),
      digest: (options = {}) => request("GET", "/notifications/digest", options),
      deliverDigest: (body, options = {}) => request("POST", "/notifications/digest/deliver", {body, ...options})
    },
    search: {
      global: (options = {}) => request("GET", `/search${query(options)}`, options)
    },
    projectContent: {
      list: (projectId, options = {}) => request("GET", `/project-content${query({projectId, ...options})}`, options),
      get: (projectId, id, options = {}) => request("GET", `/project-content/${encodeURIComponent(id)}${query({projectId})}`, options),
      create: (body, options = {}) => request("POST", "/project-content", {body, ...options}),
      patch: (projectId, id, body, options = {}) => request("PATCH", `/project-content/${encodeURIComponent(id)}${query({projectId})}`, {body, ...options}),
      delete: (projectId, id, body, options = {}) => request("DELETE", `/project-content/${encodeURIComponent(id)}${query({projectId})}`, {body, ...options}),
      revisions: (projectId, id, options = {}) => request("GET", `/project-content/${encodeURIComponent(id)}/revisions${query({projectId})}`, options),
      operations: (projectId, id, body, options = {}) => request("POST", `/project-content/${encodeURIComponent(id)}/operations${query({projectId})}`, {body, ...options}),
      presence: (projectId, id, options = {}) => request("GET", `/project-content/${encodeURIComponent(id)}/presence${query({projectId})}`, options),
      updatePresence: (projectId, id, body, options = {}) => request("POST", `/project-content/${encodeURIComponent(id)}/presence${query({projectId})}`, {body, ...options})
    },
    integrations: {
      catalog: (options = {}) => request("GET", "/integrations", options),
      links: (options = {}) => request("GET", `/integration-links${query(options)}`, options),
      link: (body, options = {}) => request("POST", "/integration-links", {body, ...options}),
      unlink: (id, body, options = {}) => request("DELETE", `/integration-links/${encodeURIComponent(id)}`, {body, ...options}),
      event: (connectorId, body, options = {}) => request("POST", `/integrations/${encodeURIComponent(connectorId)}/events`, {body, ...options}),
      health: (connectorId, options = {}) => request("POST", `/integrations/${encodeURIComponent(connectorId)}/health`, {body: {}, ...options}),
      resources: (connectorId, options = {}) => request("GET", `/integrations/${encodeURIComponent(connectorId)}/resources${query(options)}`, options),
      createResource: (connectorId, body, options = {}) => request("POST", `/integrations/${encodeURIComponent(connectorId)}/resources`, {body, ...options}),
      syncPermissions: (connectorId, body, options = {}) => request("POST", `/integrations/${encodeURIComponent(connectorId)}/permissions/sync`, {body, ...options}),
      importJira: (body, options = {}) => request("POST", "/integrations/jira/import", {body, ...options})
    },
    repositories: {
      list: (options = {}) => request("GET", "/repositories", options),
      tree: (id, options = {}) => request("GET", `/repositories/${encodeURIComponent(id)}/tree${query(options)}`, options),
      sync: (id, body, options = {}) => request("POST", `/repositories/${encodeURIComponent(id)}/sync`, {body, ...options})
    },
    externalShares: {
      list: (options = {}) => request("GET", "/external-shares", options),
      create: (body, options = {}) => request("POST", "/external-shares", {body, ...options}),
      revoke: (token, body, options = {}) => request("DELETE", `/external-shares/${encodeURIComponent(token)}`, {body, ...options}),
      get: (token, options = {}) => request("GET", `/shared-work/${encodeURIComponent(token)}`, options),
      comment: (token, body, options = {}) => request("POST", `/shared-work/${encodeURIComponent(token)}/comments`, {body, ...options})
    },
    outboundLinks: {
      check: (body, options = {}) => request("POST", "/outbound-links/check", {body, ...options}),
      events: (options = {}) => request("GET", "/outbound-links/events", options)
    },
    directory: {
      sync: (body, options = {}) => request("POST", "/directory/sync", {body, ...options}),
      ldapSync: (options = {}) => request("POST", "/directory/ldap/sync", {body: {}, ...options})
    },
    webhooks: {
      deliver: (id, body, options = {}) => request("POST", `/webhooks/${encodeURIComponent(id)}/deliver`, {body, ...options}),
      deliveries: (options = {}) => request("GET", "/webhook-deliveries", options)
    },
    savedViews: {
      list: (options = {}) => request("GET", "/saved-views", options),
      create: (body, options = {}) => request("POST", "/saved-views", {body, ...options})
    },
    documents: {
      list: (options = {}) => request("GET", `/documents${query(options)}`, options),
      uploadIntent: (body, options = {}) => request("POST", "/documents/upload-intent", {body, ...options}),
      putUpload,
      finalize: (body, options = {}) => request("POST", "/documents/finalize", {body, ...options}),
      requestScan: (projectId, id, options = {}) => request("POST", `/documents/${id}/scan-request${query({projectId})}`, {body: {}, ...options}),
      scan: (projectId, id, body, options = {}) => request("POST", `/documents/${id}/scan${query({projectId})}`, {body, ...options}),
      patch: (projectId, id, body, options = {}) => request("PATCH", `/documents/${id}${query({projectId})}`, {body, ...options}),
      download: (projectId, id, options = {}) => request("GET", `/documents/${id}/download${query({projectId})}`, options)
    },
    applicationData: {
      summary: (options = {}) => request("GET", "/application-data/summary", options)
    },
    reports: {
      portfolioSummary: (options = {}) => request("GET", "/reports/portfolio-summary", options),
      planningSummary: (options = {}) => request("GET", "/reports/planning-summary", options),
      projectTimeline: (options = {}) => request("GET", "/reports/project-timeline", options),
      costs: (options = {}) => request("GET", `/reports/costs${query(options)}`, options),
      resources: (options = {}) => request("GET", `/reports/resources${query(options)}`, options)
    },
    resourcePlanner: {
      saveProfile: (body, options = {}) => request("POST", "/resource-planner/profiles", {body, ...options}),
      saveAllocation: (body, options = {}) => request("POST", "/resource-planner/allocations", {body, ...options}),
      deleteAllocation: (id, version, options = {}) => request("DELETE", `/resource-planner/allocations/${encodeURIComponent(id)}`, {body: {version}, ...options}),
      saveTimeOff: (body, options = {}) => request("POST", "/resource-planner/time-off", {body, ...options}),
      deleteTimeOff: (id, version, options = {}) => request("DELETE", `/resource-planner/time-off/${encodeURIComponent(id)}`, {body: {version}, ...options})
    },
    exports: {
      workItems: (options = {}) => request("GET", `/exports/work-items${query(options)}`, options),
      gantt: (projectId, options = {}) => request("GET", `/exports/gantt${query({projectId})}`, options)
    },
    security: {
      badge: (options = {}) => request("GET", "/security/badge", options)
    },
    attachments: {
      uploadIntent: (body, options = {}) => request("POST", "/attachments/upload-intent", {body, ...options})
    }
  };
}
