// @ts-nocheck

import {createHash, createHmac, timingSafeEqual} from "node:crypto";
import {ForbiddenError, ServiceUnavailableError, UnauthorizedError, ValidationError} from "../errors.js";
import {readGitHubProject} from "./github-projects.js";

const maintainedTypes = new Set(["github", "gitlab", "nextcloud", "onedrive", "sharepoint", "xwiki", "opendesk"]);
const storageTypes = new Set(["nextcloud", "onedrive", "sharepoint", "opendesk"]);
const developmentTypes = new Set(["github", "gitlab"]);
const collaborationTypes = new Set(["xwiki", "nextcloud", "opendesk"]);
const maximumProviderResponseBytes = 1024 * 1024;

function header(headers, name) {
  const target = name.toLowerCase();
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === target)?.[1];
}

function sameValue(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function publicHttpsUrl(value, name) {
  let parsed;
  try {
    parsed = new URL(String(value ?? ""));
  } catch {
    throw new ValidationError(`${name} must be an HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost")) {
    throw new ValidationError(`${name} must be a public HTTPS URL without embedded credentials`);
  }
  return parsed;
}

function connectorUrl(connector, path, baseField = "apiBaseUrl") {
  const base = publicHttpsUrl(connector[baseField] ?? connector.baseUrl, `${baseField} or baseUrl`);
  const resolved = new URL(path.replace(/^\/+/, ""), `${base.toString().replace(/\/+$/, "")}/`);
  if (resolved.origin !== base.origin) throw new ValidationError("Provider requests must remain on the configured origin");
  return resolved.toString();
}

async function boundedResponseText(response) {
  const declared = Number(response.headers?.get?.("content-length") ?? 0);
  if (declared > maximumProviderResponseBytes) throw new ServiceUnavailableError("Provider response exceeded the one MiB integration limit");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maximumProviderResponseBytes) throw new ServiceUnavailableError("Provider response exceeded the one MiB integration limit");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumProviderResponseBytes) {
      await reader.cancel();
      throw new ServiceUnavailableError("Provider response exceeded the one MiB integration limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

async function responsePayload(response) {
  const text = await boundedResponseText(response);
  if (!text) return {};
  const contentType = String(response.headers?.get?.("content-type") ?? "");
  if (contentType.includes("json") || /^[\[{]/.test(text.trim())) {
    try {
      return JSON.parse(text);
    } catch {
      throw new ServiceUnavailableError("Provider returned invalid JSON");
    }
  }
  return text;
}

function nextPage(response) {
  const link = String(response.headers?.get?.("link") ?? "");
  const next = link.split(",").find((entry) => /rel="?next"?/.test(entry));
  const url = next?.match(/<([^>]+)>/)?.[1];
  return url ? new URL(url).searchParams.get("page") ?? undefined : undefined;
}

function normalizedPath(value) {
  const path = String(value ?? "").replace(/^\/+|\/+$/g, "");
  if (path.length > 1000 || path.split("/").some((part) => part === "." || part === "..")) throw new ValidationError("Provider path is invalid");
  return path;
}

function requiredConnectorValue(connector, name) {
  const value = String(connector[name] ?? "").trim();
  if (!value) throw new ValidationError(`Connector ${name} is required`);
  return value;
}

function credentialBag(environment = process.env) {
  const serialized = environment.INTEGRATION_CREDENTIALS_JSON;
  if (!serialized) return {};
  try {
    const parsed = JSON.parse(serialized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new ServiceUnavailableError("The external integration credential bundle is invalid");
  }
}

function canonicalCredentialScope(value) {
  if (Array.isArray(value)) return value.map(canonicalCredentialScope);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonicalCredentialScope(value[key])]));
  return value;
}

/** Server-owned workspace identity plus the complete reviewed connector configuration. */
export function integrationCredentialBinding(workspaceId, connector) {
  if (typeof workspaceId !== "string" || !workspaceId || !connector || typeof connector !== "object" || Array.isArray(connector) || typeof connector.id !== "string" || !connector.id) throw new ForbiddenError("Integration credentials require a trusted workspace and connector");
  const {workspaceId: ignoredWorkspace, ...configuration} = connector;
  return {workspaceId, connectorId: connector.id, configurationSha256: createHash("sha256").update(JSON.stringify(canonicalCredentialScope(configuration))).digest("hex")};
}

export function environmentCredentialResolver(environment = process.env) {
  return async (reference, context = {}) => {
    if (!reference) throw new ServiceUnavailableError("The connector has no external credential reference");
    const credential = credentialBag(environment)[reference];
    if (!credential || typeof credential !== "object" || Array.isArray(credential)) throw new ServiceUnavailableError(`External credential reference ${reference} is unavailable`);
    const {bindings, ...value} = credential;
    if (bindings !== undefined) {
      if (!Array.isArray(bindings) || !bindings.length || bindings.length > 100 || bindings.some(binding => !binding || typeof binding !== "object" || Array.isArray(binding) || typeof binding.workspaceId !== "string" || !binding.workspaceId || typeof binding.connectorId !== "string" || !binding.connectorId || !/^[a-f0-9]{64}$/.test(binding.configurationSha256 ?? ""))) throw new ServiceUnavailableError("The integration credential bindings are invalid");
      const scope = integrationCredentialBinding(context.workspaceId, context.connector);
      if (!bindings.some(binding => binding.workspaceId === scope.workspaceId && binding.connectorId === scope.connectorId && binding.configurationSha256 === scope.configurationSha256)) throw new ForbiddenError("This workspace and connector are not permitted to use the integration credential");
    }
    return structuredClone(value);
  };
}

function connectorCapabilities(connector) {
  if (connector.type === "github" && connector.resourceKind === "projects") return ["health", "browse", "project-items", "project-fields"];
  if (developmentTypes.has(connector.type)) return ["health", "development-events", "verified-webhooks"];
  if (storageTypes.has(connector.type)) return ["health", "browse", "link", "managed-permissions", ...(collaborationTypes.has(connector.type) ? ["two-way-relations", "inbound-work-items"] : []), ...(connector.authMode === "oidc-token-exchange" ? ["oidc-sso"] : [])];
  if (connector.type === "xwiki") return ["health", "browse", "create", "link", "relations", "two-way-relations", "inbound-work-items"];
  return [];
}

export function providerAdapterDescription(connector) {
  const supported = maintainedTypes.has(connector.type);
  const missing = [];
  if (supported && !connector.credentialReference) missing.push("credentialReference");
  if (supported && !connector.baseUrl) missing.push("baseUrl");
  if (developmentTypes.has(connector.type) && !connector.projectId) missing.push("projectId");
  if (developmentTypes.has(connector.type) && !connector.repository && !connector.projectPath) missing.push(connector.type === "github" ? "repository" : "projectPath");
  if (connector.type === "github" && connector.resourceKind === "projects" && !connector.githubProjectId) missing.push("githubProjectId");
  if (connector.type === "github" && connector.resourceKind === "projects" && !["public", "private"].includes(connector.githubProjectVisibility)) missing.push("githubProjectVisibility");
  if (connector.type === "github" && connector.resourceKind !== undefined && !["projects", "pull-requests"].includes(connector.resourceKind)) missing.push("resourceKind");
  if (["onedrive", "sharepoint"].includes(connector.type) && !connector.driveId) missing.push("driveId");
  if (connector.type === "xwiki" && !connector.wiki) missing.push("wiki");
  return {
    supported,
    operational: supported && connector.enabled !== false && missing.length === 0,
    missingConfiguration: missing,
    capabilities: connectorCapabilities(connector)
  };
}

function basicAuthorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function workReferences(text, connector) {
  const value = String(text ?? "");
  const configured = String(connector.referencePattern ?? "").trim();
  let pattern;
  try {
    pattern = configured ? new RegExp(configured, "gi") : /\b(?:TS|OP)#([A-Za-z0-9_-]{1,128})\b/gi;
  } catch {
    throw new ValidationError("Connector referencePattern is not a valid regular expression");
  }
  const ids = [];
  for (const match of value.matchAll(pattern)) {
    const id = match[1] ?? match[0];
    if (id && !ids.includes(id)) ids.push(id);
    if (ids.length === 25) break;
  }
  return ids;
}

function xmlValue(xml, name) {
  const match = String(xml).match(new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${name}>`, "i"));
  return match?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
}

function nextcloudEntries(xml, baseUrl, rootPath) {
  const responses = String(xml).match(/<(?:[A-Za-z0-9_-]+:)?response(?:\s[^>]*)?>[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?response>/gi) ?? [];
  return responses.slice(1, 101).map((entry) => {
    const href = decodeURIComponent(xmlValue(entry, "href") ?? "");
    const name = xmlValue(entry, "displayname") ?? href.replace(/\/+$/, "").split("/").at(-1) ?? "item";
    const directory = /<(?:[A-Za-z0-9_-]+:)?collection(?:\s[^>]*)?\/?\s*>/i.test(entry);
    const relative = href.split("/files/")[1]?.split("/").slice(1).join("/").replace(/\/+$/, "") ?? `${rootPath}/${name}`.replace(/^\/+/, "");
    return {
      id: href,
      title: name,
      path: relative,
      kind: directory ? "folder" : "file",
      linkType: directory ? "folder" : "file",
      externalUrl: new URL(href, baseUrl).toString(),
      metadata: {etag: xmlValue(entry, "getetag"), sizeBytes: Number(xmlValue(entry, "getcontentlength") ?? 0)}
    };
  });
}

export class ProviderIntegrationRuntime {
  constructor({fetchImpl = globalThis.fetch, resolveCredential = environmentCredentialResolver(), timeoutMs = 8000} = {}) {
    this.fetchImpl = fetchImpl;
    this.resolveCredential = resolveCredential;
    this.timeoutMs = timeoutMs;
  }

  describe(connector) {
    return providerAdapterDescription(connector);
  }

  async credential(connector) {
    return this.resolveCredential(requiredConnectorValue(connector, "credentialReference"), {workspaceId: connector.workspaceId, connector});
  }

  async request(url, init = {}) {
    publicHttpsUrl(url, "Provider request URL");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(url, {...init, redirect: "error", signal: controller.signal});
      if (!response.ok) {
        await boundedResponseText(response).catch(() => "");
        throw new ServiceUnavailableError(`Provider request failed with HTTP ${response.status}`);
      }
      return response;
    } catch (error) {
      if (error instanceof ValidationError || error instanceof ServiceUnavailableError) throw error;
      throw new ServiceUnavailableError(error?.name === "AbortError" ? "Provider request timed out" : "Provider request failed");
    } finally {
      clearTimeout(timeout);
    }
  }

  async accessToken(connector, credential, callerToken) {
    if (connector.authMode !== "oidc-token-exchange") return credential.accessToken;
    if (!callerToken) throw new UnauthorizedError("This connector requires the caller's OIDC access token");
    const tokenEndpoint = publicHttpsUrl(requiredConnectorValue(connector, "tokenEndpoint"), "tokenEndpoint").toString();
    const values = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: callerToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_id: String(credential.clientId ?? ""),
      client_secret: String(credential.clientSecret ?? ""),
      ...(connector.audience ? {audience: String(connector.audience)} : {}),
      ...(connector.scope ? {scope: String(connector.scope)} : {})
    });
    const response = await this.request(tokenEndpoint, {method: "POST", headers: {"content-type": "application/x-www-form-urlencoded"}, body: values.toString()});
    const payload = await responsePayload(response);
    if (!payload?.access_token) throw new ServiceUnavailableError("OIDC token exchange did not return an access token");
    return payload.access_token;
  }

  async authorization(connector, credential, callerToken) {
    const token = await this.accessToken(connector, credential, callerToken);
    if (token) return `Bearer ${token}`;
    if (credential.username && (credential.appPassword || credential.password)) return basicAuthorization(credential.username, credential.appPassword ?? credential.password);
    throw new ServiceUnavailableError("The connector credential does not contain a supported provider authentication method");
  }

  async health(connector, {callerToken} = {}) {
    const description = this.describe(connector);
    if (!description.operational) throw new ValidationError(`Connector is not operational: ${description.missingConfiguration.join(", ")}`);
    const credential = await this.credential(connector);
    const authorization = await this.authorization(connector, credential, callerToken);
    let path;
    if (connector.type === "github") path = connector.healthPath ?? "rate_limit";
    else if (connector.type === "gitlab") path = connector.healthPath ?? "api/v4/version";
    else if (["nextcloud", "opendesk"].includes(connector.type)) path = connector.healthPath ?? "ocs/v2.php/cloud/capabilities?format=json";
    else if (["onedrive", "sharepoint"].includes(connector.type)) path = connector.healthPath ?? "v1.0/$metadata";
    else path = connector.healthPath ?? `rest/wikis/${encodeURIComponent(connector.wiki)}`;
    const response = await this.request(connectorUrl(connector, path), {headers: {authorization, accept: "application/json", ...(connector.type === "nextcloud" ? {"ocs-apirequest": "true"} : {})}});
    await boundedResponseText(response);
    return {ok: true, checkedAt: new Date().toISOString(), provider: connector.type, status: response.status, capabilities: description.capabilities};
  }

  async browse(connector, {path = "", cursor = "", query = "", callerToken} = {}) {
    const description = this.describe(connector);
    if (!description.operational || !description.capabilities.includes("browse")) throw new ValidationError("Connector does not provide an operational resource browser");
    const credential = await this.credential(connector);
    const authorization = await this.authorization(connector, credential, callerToken);
    const page = Math.max(1, Math.min(Number(cursor || 1) || 1, 10000));
    const safePath = normalizedPath(path);
    if (connector.type === "nextcloud" || connector.type === "opendesk") {
      const username = String(credential.username ?? connector.serviceUser ?? "");
      if (!username) throw new ServiceUnavailableError("Nextcloud-compatible browsing requires a service username");
      const davPath = `remote.php/dav/files/${encodeURIComponent(username)}/${safePath.split("/").map(encodeURIComponent).join("/")}`;
      const response = await this.request(connectorUrl(connector, davPath), {method: "PROPFIND", headers: {authorization, depth: "1", accept: "application/xml"}});
      return {items: nextcloudEntries(await boundedResponseText(response), connector.baseUrl, safePath), path: safePath};
    }
    if (["onedrive", "sharepoint"].includes(connector.type)) {
      const driveId = encodeURIComponent(requiredConnectorValue(connector, "driveId"));
      const location = safePath ? `root:/${safePath}:/children` : "root/children";
      const endpoint = `v1.0/drives/${driveId}/${location}?$top=100${cursor ? `&$skiptoken=${encodeURIComponent(cursor)}` : ""}`;
      const response = await this.request(connectorUrl(connector, endpoint), {headers: {authorization, accept: "application/json"}});
      const payload = await responsePayload(response);
      return {
        items: (payload.value ?? []).slice(0, 100).map((item) => ({id: item.id, title: item.name, path: `${safePath}/${item.name}`.replace(/^\//, ""), kind: item.folder ? "folder" : "file", linkType: item.folder ? "folder" : "file", externalUrl: item.webUrl, metadata: {sizeBytes: item.size, modifiedAt: item.lastModifiedDateTime}})),
        path: safePath,
        nextCursor: payload["@odata.nextLink"] ? new URL(payload["@odata.nextLink"]).searchParams.get("$skiptoken") : undefined
      };
    }
    if (connector.type === "xwiki") {
      const wiki = encodeURIComponent(requiredConnectorValue(connector, "wiki"));
      const endpoint = query
        ? `rest/wikis/${wiki}/search?q=${encodeURIComponent(query)}&number=100&media=json`
        : `rest/wikis/${wiki}/spaces/${encodeURIComponent(safePath || connector.space || "Main")}/pages?media=json`;
      const response = await this.request(connectorUrl(connector, endpoint), {headers: {authorization, accept: "application/json"}});
      const payload = await responsePayload(response);
      const pages = payload.pageSummaries ?? payload.searchResults ?? payload.pages ?? [];
      return {items: pages.slice(0, 100).map((page) => ({id: page.id ?? page.fullName ?? page.reference, title: page.title ?? page.name, path: page.fullName ?? page.reference, kind: "wiki", linkType: "wiki", externalUrl: page.xwikiAbsoluteUrl ?? page.url, metadata: {wiki: page.wiki, space: page.space}})), path: safePath};
    }
    throw new ValidationError("Connector does not support browsing");
  }

  async developmentItems(connector, {cursor = "", query = ""} = {}) {
    const description = this.describe(connector);
    if (!description.operational || !developmentTypes.has(connector.type)) throw new ValidationError("Connector does not provide an operational development browser");
    const credential = await this.credential(connector);
    const authorization = await this.authorization(connector, credential);
    const page = Math.max(1, Math.min(Number(cursor || 1) || 1, 10000));
    if (connector.type === "github") {
      const repository = requiredConnectorValue(connector, "repository");
      if (connector.resourceKind === "projects") {
        const restBase = new URL(connector.apiBaseUrl ?? connector.baseUrl);
        const graphPath = /\/api\/v3\/?$/.test(restBase.pathname) ? "../graphql" : "graphql";
        return readGitHubProject({projectId: requiredConnectorValue(connector, "githubProjectId"), repository, visibility: connector.githubProjectVisibility, includeDrafts: connector.includeProjectDrafts ?? false, sharedRepositories: connector.sharedRepositories ?? [], statusField: connector.githubStatusField ?? "Status", cursor, query, request: async (body) => {
          const response = await this.request(connectorUrl(connector, graphPath), {method: "POST", headers: {authorization, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2022-11-28"}, body: JSON.stringify(body)});
          return responsePayload(response);
        }});
      }
      const endpoint = `repos/${repository.split("/").map(encodeURIComponent).join("/")}/pulls?state=all&per_page=100&page=${page}`;
      const response = await this.request(connectorUrl(connector, endpoint), {headers: {authorization, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28"}});
      const payload = await responsePayload(response);
      const items = payload.filter((item) => !query || `${item.title} ${item.number}`.toLowerCase().includes(query.toLowerCase())).map((item) => ({id: `${repository}#${item.number}`, title: item.title, kind: "pull-request", linkType: "development", externalUrl: item.html_url, metadata: {number: item.number, state: item.merged_at ? "merged" : item.state, draft: Boolean(item.draft), head: item.head?.ref, base: item.base?.ref}}));
      return {items, nextCursor: nextPage(response)};
    }
    const projectPath = requiredConnectorValue(connector, "projectPath");
    const response = await this.request(connectorUrl(connector, `api/v4/projects/${encodeURIComponent(projectPath)}/merge_requests?state=all&per_page=100&page=${page}`), {headers: {authorization, accept: "application/json"}});
    const payload = await responsePayload(response);
    const items = payload.filter((item) => !query || `${item.title} ${item.iid}`.toLowerCase().includes(query.toLowerCase())).map((item) => ({id: `${projectPath}!${item.iid}`, title: item.title, kind: "merge-request", linkType: "development", externalUrl: item.web_url, metadata: {number: item.iid, state: item.state, draft: Boolean(item.draft), head: item.source_branch, base: item.target_branch, pipelineStatus: item.head_pipeline?.status}}));
    return {items, nextCursor: response.headers?.get?.("x-next-page") || undefined};
  }

  async createWikiPage(connector, input, {callerToken} = {}) {
    if (connector.type !== "xwiki" || !this.describe(connector).operational) throw new ValidationError("An operational XWiki connector is required");
    const credential = await this.credential(connector);
    const authorization = await this.authorization(connector, credential, callerToken);
    const wiki = encodeURIComponent(requiredConnectorValue(connector, "wiki"));
    const space = encodeURIComponent(input.space || connector.space || "Main");
    const page = encodeURIComponent(input.page || input.title.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || "Page");
    const response = await this.request(connectorUrl(connector, `rest/wikis/${wiki}/spaces/${space}/pages/${page}`), {method: "PUT", headers: {authorization, accept: "application/json", "content-type": "application/json"}, body: JSON.stringify({title: input.title, content: input.content ?? "", syntax: input.syntax ?? "markdown/1.2"})});
    const payload = await responsePayload(response);
    return {id: payload.id ?? `${connector.wiki}:${input.space || connector.space || "Main"}.${decodeURIComponent(page)}`, title: payload.title ?? input.title, kind: "wiki", linkType: "wiki", externalUrl: payload.xwikiAbsoluteUrl ?? payload.url ?? connectorUrl(connector, `bin/view/${space}/${page}`), metadata: {wiki: connector.wiki, space: input.space || connector.space || "Main"}};
  }

  async reconcilePermissions(connector, {resourceId, members, callerToken} = {}) {
    if (!storageTypes.has(connector.type) || !this.describe(connector).operational) throw new ValidationError("An operational managed-storage connector is required");
    if (connector.managedPermissions !== true) throw new ValidationError("Connector managedPermissions must be enabled explicitly");
    const credential = await this.credential(connector);
    const authorization = await this.authorization(connector, credential, callerToken);
    const desired = new Map(members.slice(0, 500).map((member) => [String(member.externalId ?? member.email).toLowerCase(), member.permission === "write" ? "write" : "read"]));
    if (["onedrive", "sharepoint"].includes(connector.type)) {
      const driveId = encodeURIComponent(requiredConnectorValue(connector, "driveId"));
      const itemId = encodeURIComponent(resourceId);
      const listUrl = connectorUrl(connector, `v1.0/drives/${driveId}/items/${itemId}/permissions`);
      const existingPayload = await responsePayload(await this.request(listUrl, {headers: {authorization, accept: "application/json"}}));
      const existing = (existingPayload.value ?? []).map((permission) => ({id: permission.id, email: permission.grantedToV2?.user?.email ?? permission.grantedTo?.user?.email ?? permission.invitation?.email, roles: permission.roles ?? []})).filter((permission) => permission.email);
      const managedDomains = new Set((connector.managedPermissionDomains ?? []).map((domain) => String(domain).toLowerCase()));
      const removed = [];
      for (const permission of existing) {
        const email = permission.email.toLowerCase();
        const domain = email.split("@")[1] ?? "";
        if (managedDomains.has(domain) && !desired.has(email)) {
          await this.request(connectorUrl(connector, `v1.0/drives/${driveId}/items/${itemId}/permissions/${encodeURIComponent(permission.id)}`), {method: "DELETE", headers: {authorization}});
          removed.push(email);
        }
      }
      const added = [];
      for (const [email, permission] of desired) {
        const current = existing.find((item) => item.email.toLowerCase() === email && item.roles.includes(permission));
        if (current) continue;
        await this.request(connectorUrl(connector, `v1.0/drives/${driveId}/items/${itemId}/invite`), {method: "POST", headers: {authorization, accept: "application/json", "content-type": "application/json"}, body: JSON.stringify({recipients: [{email}], roles: [permission], requireSignIn: true, sendInvitation: false})});
        added.push(email);
      }
      return {resourceId, desiredCount: desired.size, added, removed};
    }
    const path = normalizedPath(resourceId);
    const shareEndpoint = connectorUrl(connector, `ocs/v2.php/apps/files_sharing/api/v1/shares?path=${encodeURIComponent(path)}&reshares=true&format=json`);
    const existingPayload = await responsePayload(await this.request(shareEndpoint, {headers: {authorization, accept: "application/json", "ocs-apirequest": "true"}}));
    const existing = existingPayload.ocs?.data ?? [];
    const removed = [];
    for (const share of existing) {
      const principal = String(share.share_with ?? "").toLowerCase();
      if (share.share_type === 0 && connector.managedPrincipalPrefix && principal.startsWith(String(connector.managedPrincipalPrefix).toLowerCase()) && !desired.has(principal)) {
        await this.request(connectorUrl(connector, `ocs/v2.php/apps/files_sharing/api/v1/shares/${encodeURIComponent(share.id)}?format=json`), {method: "DELETE", headers: {authorization, "ocs-apirequest": "true"}});
        removed.push(principal);
      }
    }
    const added = [];
    for (const [principal, permission] of desired) {
      const permissionBits = permission === "write" ? "15" : "1";
      if (existing.some((share) => String(share.share_with).toLowerCase() === principal && String(share.permissions) === permissionBits)) continue;
      const values = new URLSearchParams({path, shareType: "0", shareWith: principal, permissions: permissionBits});
      await this.request(connectorUrl(connector, "ocs/v2.php/apps/files_sharing/api/v1/shares?format=json"), {method: "POST", headers: {authorization, "content-type": "application/x-www-form-urlencoded", "ocs-apirequest": "true"}, body: values.toString()});
      added.push(principal);
    }
    return {resourceId: path, desiredCount: desired.size, added, removed};
  }

  async verifyWebhook(connector, {headers = {}, rawBody = ""} = {}) {
    if (!developmentTypes.has(connector.type) || !this.describe(connector).operational) throw new ValidationError("An operational development connector is required");
    if (Buffer.byteLength(rawBody, "utf8") > 1024 * 1024) throw new ValidationError("Provider webhook payload is too large");
    const credential = await this.credential(connector);
    if (!credential.webhookSecret) throw new ServiceUnavailableError("The connector credential has no webhook secret");
    if (connector.type === "github") {
      if (!header(headers, "x-github-delivery")) throw new ValidationError("GitHub webhook delivery ID is required");
      const supplied = String(header(headers, "x-hub-signature-256") ?? "");
      const expected = `sha256=${createHmac("sha256", credential.webhookSecret).update(rawBody, "utf8").digest("hex")}`;
      if (!sameValue(supplied, expected)) throw new UnauthorizedError("GitHub webhook signature is invalid");
    } else {
      if (!header(headers, "x-gitlab-event-uuid") && !header(headers, "x-gitlab-webhook-uuid")) throw new ValidationError("GitLab webhook delivery ID is required");
      if (!sameValue(header(headers, "x-gitlab-token"), credential.webhookSecret)) throw new UnauthorizedError("GitLab webhook token is invalid");
    }
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new ValidationError("Provider webhook body must be JSON");
    }
    if (connector.type === "github") {
      const source = body.pull_request ?? body.check_run ?? body.issue ?? {};
      const number = body.number ?? source.number ?? source.pull_requests?.[0]?.number;
      const repository = body.repository?.full_name ?? connector.repository;
      const title = source.title ?? source.name ?? `${header(headers, "x-github-event") ?? "github"} event`;
      const text = [title, source.body, body.comment?.body, source.head_commit?.message].filter(Boolean).join("\n");
      const action = body.action ?? source.status ?? "received";
      return {provider: "github", deliveryId: header(headers, "x-github-delivery"), eventType: `${header(headers, "x-github-event") ?? "event"}.${action}`, externalId: number ? `${repository}#${number}` : body.check_run?.id ? `${repository}:check:${body.check_run.id}` : undefined, externalUrl: source.html_url ?? body.repository?.html_url, title, summary: `${title} · ${action}`.slice(0, 2000), workItemIds: workReferences(text, connector), payload: {action, state: source.merged_at ? "merged" : source.state ?? source.status, conclusion: source.conclusion, repository}};
    }
    const source = body.object_attributes ?? body.merge_request ?? body;
    const projectPath = body.project?.path_with_namespace ?? connector.projectPath;
    const number = source.iid ?? body.object_attributes?.iid;
    const title = source.title ?? `${header(headers, "x-gitlab-event") ?? "GitLab"} event`;
    const text = [title, source.description, body.commit?.message].filter(Boolean).join("\n");
    const action = source.action ?? source.state ?? "received";
    return {provider: "gitlab", deliveryId: header(headers, "x-gitlab-event-uuid") ?? header(headers, "x-gitlab-webhook-uuid"), eventType: `${String(header(headers, "x-gitlab-event") ?? "event").toLowerCase().replace(/\s+/g, "-")}.${action}`, externalId: number ? `${projectPath}!${number}` : undefined, externalUrl: source.url ?? body.project?.web_url, title, summary: `${title} · ${action}`.slice(0, 2000), workItemIds: workReferences(text, connector), payload: {action, state: source.state, pipelineStatus: body.object_attributes?.status, repository: projectPath}};
  }

  async verifyCollaborationWebhook(connector, {headers = {}, rawBody = ""} = {}) {
    if (!collaborationTypes.has(connector.type) || !this.describe(connector).operational) throw new ValidationError("An operational collaboration connector is required");
    if (Buffer.byteLength(rawBody, "utf8") > 256 * 1024) throw new ValidationError("Collaboration webhook payload is too large");
    const deliveryId = header(headers, "x-teamspaces-delivery") ?? header(headers, `x-${connector.type}-delivery`);
    if (!deliveryId) throw new ValidationError("Collaboration webhook delivery ID is required");
    const credential = await this.credential(connector);
    if (!credential.webhookSecret) throw new ServiceUnavailableError("The collaboration connector credential has no webhook secret");
    const supplied = String(header(headers, "x-teamspaces-signature-256") ?? "");
    const expected = `sha256=${createHmac("sha256", credential.webhookSecret).update(rawBody, "utf8").digest("hex")}`;
    if (!sameValue(supplied, expected)) throw new UnauthorizedError("Collaboration webhook signature is invalid");
    let body;
    try { body = JSON.parse(rawBody); } catch { throw new ValidationError("Collaboration webhook body must be JSON"); }
    const resourceId = body?.resourceId ?? body?.pageId;
    if (!body || !["link", "unlink", "create-work-item"].includes(body.action) || typeof body.projectId !== "string" || !body.projectId) throw new ValidationError("Collaboration webhook action and projectId are required");
    if (["link", "unlink"].includes(body.action) && (typeof body.workItemId !== "string" || !body.workItemId || typeof resourceId !== "string" || !resourceId || typeof body.title !== "string" || !body.title)) throw new ValidationError("Collaboration link actions require workItemId, resourceId, and title");
    if (body.action === "create-work-item" && (typeof body.title !== "string" || !body.title)) throw new ValidationError("Collaboration work-item creation requires a title");
    const defaultLinkType = connector.type === "xwiki" ? "wiki" : "file";
    const linkType = ["wiki", "file", "folder"].includes(body.linkType) ? body.linkType : defaultLinkType;
    let externalUrl;
    if (body.externalUrl) {
      const candidate = publicHttpsUrl(body.externalUrl, "Collaboration resource URL");
      if (candidate.origin !== publicHttpsUrl(connector.baseUrl, "baseUrl").origin) throw new ValidationError("Collaboration resource URL must use the configured provider origin");
      externalUrl = candidate.toString();
    }
    return {provider: connector.type, deliveryId: String(deliveryId).slice(0, 240), action: body.action, projectId: body.projectId.slice(0, 128), workItemId: body.workItemId?.slice(0, 128), resourceId: resourceId?.slice(0, 500), pageId: resourceId?.slice(0, 500), linkType, title: body.title.slice(0, 240), description: typeof body.description === "string" ? body.description.slice(0, 10000) : "", externalUrl};
  }

  async verifyXwikiWebhook(connector, request) {
    return this.verifyCollaborationWebhook(connector, request);
  }

  async verifyInboundToken(connector, {headers = {}} = {}) {
    if (!collaborationTypes.has(connector.type) || !this.describe(connector).operational) throw new ValidationError("An operational collaboration connector is required");
    const supplied = String(header(headers, "authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
    const credential = await this.credential(connector);
    if (!credential.inboundToken || !sameValue(supplied, credential.inboundToken)) throw new UnauthorizedError("Collaboration provider token is invalid");
    return true;
  }
}

export function createProviderIntegrationRuntime(options) {
  return new ProviderIntegrationRuntime(options);
}
