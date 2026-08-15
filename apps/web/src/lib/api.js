// @ts-nocheck

import {beginSignIn, currentSession, getAccessToken, handleAuthCallback, runtimeConfig} from "./auth.js";

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

export async function apiClient() {
  await handleAuthCallback();
  const config = await runtimeConfig();
  const session = await currentSession();
  const isPublicDemo = session.mode === "public-demo";
  const baseUrl = isPublicDemo
    ? config.publicDemo.apiBaseUrl
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
      if (!isPublicDemo) await beginSignIn();
      throw new ApiError({
        ...responseProblem,
        title: responseProblem.title || "Unauthorized",
        detail: responseProblem.detail || (isPublicDemo ? "The public demo is temporarily unavailable" : "Session expired"),
        correlationId: responseProblem.correlationId ?? correlationId
      });
    }
    if (!response.ok) throw new ApiError({...responseProblem, correlationId: responseProblem.correlationId ?? correlationId});
    return payload?.data ?? payload;
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
    portfolios: {
      list: (options = {}) => request("GET", `/portfolios${query(options)}`, options),
      create: (body, options = {}) => request("POST", "/portfolios", {body, ...options}),
      patch: (id, body, options = {}) => request("PATCH", `/portfolios/${id}`, {body, ...options})
    },
    projects: {
      list: (options = {}) => request("GET", `/projects${query(options)}`, options),
      get: (id, options = {}) => request("GET", `/projects/${id}`, options),
      create: (body, options = {}) => request("POST", "/projects", {body, ...options}),
      patch: (id, body, options = {}) => request("PATCH", `/projects/${id}`, {body, ...options})
    },
    workItems: {
      assigned: (options = {}) => request("GET", "/work-items/assigned", options),
      list: (projectId, options = {}) => request("GET", `/projects/${projectId}/work-items${query(options)}`, options),
      create: (projectId, body, options = {}) => request("POST", `/projects/${projectId}/work-items`, {body, ...options}),
      patch: (projectId, id, body, options = {}) => request("PATCH", `/projects/${projectId}/work-items/${id}`, {body, ...options})
    },
    planning: {
      dashboard: (options = {}) => request("GET", `/planning${query(options)}`, options)
    },
    meetings: {
      list: (projectId, options = {}) => request("GET", meetingListPath(projectId, options), options),
      get: (projectId, id, options = {}) => request("GET", meetingDetailPath(projectId, id), options),
      create: (projectId, body, options = {}) => request("POST", "/meetings", {body: {...body, projectId}, ...options}),
      patch: (projectId, id, body, options = {}) => request("PATCH", `/meetings/${encodeURIComponent(id)}`, {body: {...body, projectId}, ...options})
    },
    timeEntries: {
      list: (options = {}) => request("GET", `/time-entries${query(options)}`, options),
      create: (body, options = {}) => request("POST", "/time-entries", {body, ...options})
    },
    activity: {
      list: (options = {}) => request("GET", `/activity${query(options)}`, options),
      create: (body, options = {}) => request("POST", "/activity", {body, ...options})
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
      patch: (projectId, id, body, options = {}) => request("PATCH", `/documents/${id}${query({projectId})}`, {body, ...options}),
      download: (projectId, id, options = {}) => request("GET", `/documents/${id}/download${query({projectId})}`, options)
    },
    applicationData: {
      summary: (options = {}) => request("GET", "/application-data/summary", options)
    },
    reports: {
      portfolioSummary: (options = {}) => request("GET", "/reports/portfolio-summary", options),
      planningSummary: (options = {}) => request("GET", "/reports/planning-summary", options),
      projectTimeline: (options = {}) => request("GET", "/reports/project-timeline", options)
    },
    attachments: {
      uploadIntent: (body, options = {}) => request("POST", "/attachments/upload-intent", {body, ...options})
    }
  };
}
