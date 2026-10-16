// @ts-check

import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import test from "node:test";
import {defaultWorkspaceCapabilities} from "@teamspaces/contracts";
import {createHandler} from "../src/handler.js";
import {ProviderIntegrationRuntime, providerAdapterDescription} from "../src/integrations/provider-adapters.js";
import {synchronizeManagedIntegrations} from "../src/integrations/scheduled-handler.js";
import {MemoryRepository} from "../src/repositories/memory.js";

function jsonResponse(value, options = {}) {
  return new Response(JSON.stringify(value), {status: options.status ?? 200, headers: {"content-type": "application/json", ...(options.headers ?? {})}});
}

test("describes only fully configured maintained adapters as operational", () => {
  assert.deepEqual(providerAdapterDescription({type: "github", enabled: true}), {
    supported: true,
    operational: false,
    missingConfiguration: ["credentialReference", "baseUrl", "projectId", "repository"],
    capabilities: ["health", "development-events", "verified-webhooks"]
  });
  assert.equal(providerAdapterDescription({type: "github", enabled: true, credentialReference: "github", baseUrl: "https://api.github.test", projectId: "project-pilot", repository: "team/repo"}).operational, true);
  assert.equal(providerAdapterDescription({type: "generic", enabled: true}).supported, false);
});

test("browses authenticated GitHub pull requests and verifies signed webhook deliveries", async () => {
  const requests = [];
  const runtime = new ProviderIntegrationRuntime({
    resolveCredential: async () => ({accessToken: "provider-token", webhookSecret: "webhook-secret"}),
    fetchImpl: async (url, request) => {
      requests.push({url, request});
      return jsonResponse([{number: 42, title: "Finish TS#work-cognito", state: "open", html_url: "https://github.test/team/repo/pull/42", head: {ref: "feature"}, base: {ref: "main"}}], {headers: {link: '<https://api.github.test/repos/team/repo/pulls?page=2>; rel="next"'}});
    }
  });
  const connector = {id: "github", type: "github", enabled: true, credentialReference: "github", baseUrl: "https://api.github.test", projectId: "project-pilot", repository: "team/repo"};
  const page = await runtime.developmentItems(connector, {});
  assert.equal(page.items[0].id, "team/repo#42");
  assert.equal(page.nextCursor, "2");
  assert.equal(requests[0].request.headers.authorization, "Bearer provider-token");

  const rawBody = JSON.stringify({action: "opened", number: 42, pull_request: {title: "Finish TS#work-cognito", body: "Links the task", state: "open", html_url: "https://github.test/team/repo/pull/42"}, repository: {full_name: "team/repo"}});
  const signature = `sha256=${createHmac("sha256", "webhook-secret").update(rawBody).digest("hex")}`;
  const event = await runtime.verifyWebhook(connector, {headers: {"x-hub-signature-256": signature, "x-github-event": "pull_request", "x-github-delivery": "delivery-1"}, rawBody});
  assert.deepEqual(event.workItemIds, ["work-cognito"]);
  assert.equal(event.externalId, "team/repo#42");
  await assert.rejects(() => runtime.verifyWebhook(connector, {headers: {"x-hub-signature-256": "sha256=bad", "x-github-delivery": "delivery-2"}, rawBody}), /signature is invalid/);
});

test("browses Nextcloud WebDAV and reconciles explicitly managed shares", async () => {
  const requests = [];
  const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
    <d:response><d:href>/remote.php/dav/files/service/Projects/</d:href><d:propstat><d:prop><d:displayname>Projects</d:displayname><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
    <d:response><d:href>/remote.php/dav/files/service/Projects/Plan.pdf</d:href><d:propstat><d:prop><d:displayname>Plan.pdf</d:displayname><d:getcontentlength>1200</d:getcontentlength><d:getetag>etag-1</d:getetag></d:prop></d:propstat></d:response>
  </d:multistatus>`;
  const runtime = new ProviderIntegrationRuntime({
    resolveCredential: async () => ({username: "service", appPassword: "app-password"}),
    fetchImpl: async (url, request) => {
      requests.push({url, request});
      if (request.method === "PROPFIND") return new Response(xml, {status: 207, headers: {"content-type": "application/xml"}});
      if (request.method === "DELETE" || request.method === "POST") return jsonResponse({ocs: {data: {}}});
      return jsonResponse({ocs: {data: [{id: "share-1", share_type: 0, share_with: "managed-old", permissions: 1}]}});
    }
  });
  const connector = {id: "nextcloud", type: "nextcloud", enabled: true, credentialReference: "nextcloud", baseUrl: "https://cloud.test", managedPermissions: true, managedPrincipalPrefix: "managed-"};
  const page = await runtime.browse(connector, {path: "Projects"});
  assert.equal(page.items[0].title, "Plan.pdf");
  assert.equal(page.items[0].metadata.sizeBytes, 1200);
  const result = await runtime.reconcilePermissions(connector, {resourceId: "Projects", members: [{externalId: "managed-alice", email: "alice@example.test", permission: "write"}]});
  assert.deepEqual(result.removed, ["managed-old"]);
  assert.deepEqual(result.added, ["managed-alice"]);
  assert.equal(requests.some((entry) => entry.request.method === "DELETE"), true);
  assert.equal(requests.some((entry) => entry.request.method === "POST" && String(entry.request.body).includes("permissions=15")), true);
});

test("uses OIDC token exchange for shared-identity Nextcloud Hub browsing", async () => {
  const requests = [];
  const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/files/service/</d:href><d:propstat><d:prop><d:displayname>root</d:displayname><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>`;
  const runtime = new ProviderIntegrationRuntime({
    resolveCredential: async () => ({username: "service", clientId: "team-spaces", clientSecret: "outside-capabilities"}),
    fetchImpl: async (url, request) => {
      requests.push({url, request});
      return url.includes("/token") ? jsonResponse({access_token: "exchanged-token"}) : new Response(xml, {status: 207, headers: {"content-type": "application/xml"}});
    }
  });
  const connector = {id: "hub", type: "nextcloud", enabled: true, credentialReference: "hub", baseUrl: "https://cloud.test", authMode: "oidc-token-exchange", tokenEndpoint: "https://idp.test/token", audience: "nextcloud"};
  await runtime.browse(connector, {callerToken: "team-spaces-user-token"});
  assert.equal(String(requests[0].request.body).includes("subject_token=team-spaces-user-token"), true);
  assert.equal(requests[1].request.headers.authorization, "Bearer exchanged-token");
});

test("browses Microsoft Graph storage and creates XWiki pages through provider APIs", async () => {
  const calls = [];
  const runtime = new ProviderIntegrationRuntime({
    resolveCredential: async () => ({accessToken: "provider-token"}),
    fetchImpl: async (url, request) => {
      calls.push({url, request});
      if (url.includes("graph.test")) return jsonResponse({value: [{id: "folder-1", name: "Delivery", folder: {childCount: 2}, webUrl: "https://tenant.sharepoint.test/Delivery"}]});
      return jsonResponse({id: "xwiki:Main.Decision", title: "Decision", xwikiAbsoluteUrl: "https://wiki.test/bin/view/Main/Decision"});
    }
  });
  const drive = {id: "drive", type: "sharepoint", enabled: true, credentialReference: "graph", baseUrl: "https://graph.test", driveId: "drive-1"};
  const page = await runtime.browse(drive, {});
  assert.equal(page.items[0].kind, "folder");
  const wiki = {id: "wiki", type: "xwiki", enabled: true, credentialReference: "wiki", baseUrl: "https://wiki.test", wiki: "xwiki", space: "Main"};
  const created = await runtime.createWikiPage(wiki, {title: "Decision", content: "# Decision"});
  assert.equal(created.id, "xwiki:Main.Decision");
  assert.equal(calls.at(-1).request.method, "PUT");
});

function event(method, path, body, headers = {}) {
  const [rawPath, rawQueryString = ""] = path.split("?");
  return {rawPath, rawQueryString, headers, requestContext: {http: {method}}, body: body === undefined ? undefined : JSON.stringify(body)};
}

test("accepts signed public provider webhooks once and links referenced work items", async () => {
  process.env.ALLOW_DEMO_AUTH = "true";
  process.env.APP_ORIGIN = "http://localhost:3000";
  const runtime = new ProviderIntegrationRuntime({resolveCredential: async () => ({accessToken: "provider-token", webhookSecret: "webhook-secret"})});
  const repository = new MemoryRepository(undefined, {integrationRuntime: runtime});
  const handler = createHandler({repository});
  const capabilities = structuredClone(defaultWorkspaceCapabilities);
  capabilities.connectors = [{id: "github", name: "GitHub", type: "github", enabled: true, credentialReference: "github", baseUrl: "https://api.github.test", projectId: "project-pilot", repository: "team/repo"}];
  const configured = await handler(event("PATCH", "/api/v1/capabilities", capabilities, {origin: "http://localhost:3000", "x-demo-user-id": "user-demo-admin", "x-demo-user-email": "admin@team-spaces.example"}));
  assert.equal(configured.statusCode, 200);

  const body = {action: "opened", number: 42, pull_request: {title: "Finish TS#work-cognito", state: "open", html_url: "https://github.test/team/repo/pull/42"}, repository: {full_name: "team/repo"}};
  const rawBody = JSON.stringify(body);
  const headers = {"x-hub-signature-256": `sha256=${createHmac("sha256", "webhook-secret").update(rawBody).digest("hex")}`, "x-github-event": "pull_request", "x-github-delivery": "delivery-public-1"};
  const first = await handler(event("POST", "/api/v1/provider-webhooks/workspace-default/github", body, headers));
  assert.equal(first.statusCode, 202);
  const firstPayload = JSON.parse(first.body);
  assert.equal(firstPayload.data.linkedCount, 1);
  const duplicate = await handler(event("POST", "/api/v1/provider-webhooks/workspace-default/github", body, headers));
  assert.equal(JSON.parse(duplicate.body).data.duplicate, true);
  const invalid = await handler(event("POST", "/api/v1/provider-webhooks/workspace-default/github", body, {...headers, "x-hub-signature-256": "sha256=bad"}));
  assert.equal(invalid.statusCode, 401);
});

test("supports signed two-way XWiki relations and a bounded provider work-item API", async () => {
  process.env.ALLOW_DEMO_AUTH = "true";
  process.env.APP_ORIGIN = "http://localhost:3000";
  const runtime = new ProviderIntegrationRuntime({resolveCredential: async () => ({accessToken: "provider-token", webhookSecret: "xwiki-webhook-secret", inboundToken: "xwiki-provider-token"})});
  const repository = new MemoryRepository(undefined, {integrationRuntime: runtime});
  const handler = createHandler({repository});
  const capabilities = structuredClone(defaultWorkspaceCapabilities);
  capabilities.connectors = [{id: "xwiki", name: "Knowledge", type: "xwiki", enabled: true, credentialReference: "xwiki", baseUrl: "https://wiki.test", wiki: "xwiki", projectIds: ["project-pilot"]}];
  const demoHeaders = {origin: "http://localhost:3000", "x-demo-user-id": "user-demo-admin", "x-demo-user-email": "admin@team-spaces.example"};
  assert.equal((await handler(event("PATCH", "/api/v1/capabilities", capabilities, demoHeaders))).statusCode, 200);

  const relation = {action: "link", projectId: "project-pilot", workItemId: "work-cognito", pageId: "xwiki:Main.Readiness", title: "Readiness", externalUrl: "https://wiki.test/bin/view/Main/Readiness"};
  const raw = JSON.stringify(relation);
  const webhookHeaders = {"x-xwiki-delivery": "xwiki-delivery-1", "x-teamspaces-signature-256": `sha256=${createHmac("sha256", "xwiki-webhook-secret").update(raw).digest("hex")}`};
  const linked = await handler(event("POST", "/api/v1/provider-webhooks/workspace-default/xwiki", relation, webhookHeaders));
  assert.equal(linked.statusCode, 202);
  assert.equal(JSON.parse(linked.body).data.link.externalId, relation.pageId);

  const providerHeaders = {authorization: "Bearer xwiki-provider-token"};
  const listed = await handler(event("GET", "/api/v1/provider-api/workspace-default/xwiki/work-items?projectId=project-pilot", undefined, providerHeaders));
  assert.equal(listed.statusCode, 200);
  assert.equal(JSON.parse(listed.body).data.items.some((item) => item.id === "work-cognito"), true);
  const created = await handler(event("POST", "/api/v1/provider-api/workspace-default/xwiki/work-items", {projectId: "project-pilot", title: "Created from XWiki", description: "Documentation follow-up"}, providerHeaders));
  assert.equal(created.statusCode, 201);
  assert.equal(JSON.parse(created.body).data.title, "Created from XWiki");
  const denied = await handler(event("GET", "/api/v1/provider-api/workspace-default/xwiki/work-items?projectId=project-pilot", undefined, {authorization: "Bearer wrong"}));
  assert.equal(denied.statusCode, 401);
});

test("supports reverse Nextcloud and openDesk-style file relations", async () => {
  process.env.ALLOW_DEMO_AUTH = "true";
  process.env.APP_ORIGIN = "http://localhost:3000";
  const runtime = new ProviderIntegrationRuntime({resolveCredential: async () => ({accessToken: "provider-token", webhookSecret: "cloud-webhook-secret", inboundToken: "cloud-provider-token"})});
  const repository = new MemoryRepository(undefined, {integrationRuntime: runtime});
  const handler = createHandler({repository});
  const capabilities = structuredClone(defaultWorkspaceCapabilities);
  capabilities.connectors = [{id: "nextcloud", name: "Files", type: "nextcloud", enabled: true, credentialReference: "nextcloud", baseUrl: "https://cloud.test", projectIds: ["project-pilot"]}];
  const demoHeaders = {origin: "http://localhost:3000", "x-demo-user-id": "user-demo-admin", "x-demo-user-email": "admin@team-spaces.example"};
  assert.equal((await handler(event("PATCH", "/api/v1/capabilities", capabilities, demoHeaders))).statusCode, 200);

  const relation = {action: "link", projectId: "project-pilot", workItemId: "work-cognito", resourceId: "Projects/Readiness.pdf", linkType: "file", title: "Readiness", externalUrl: "https://cloud.test/apps/files/?dir=/Projects"};
  const raw = JSON.stringify(relation);
  const headers = {"x-teamspaces-delivery": "cloud-delivery-1", "x-teamspaces-signature-256": `sha256=${createHmac("sha256", "cloud-webhook-secret").update(raw).digest("hex")}`};
  const linked = await handler(event("POST", "/api/v1/provider-webhooks/workspace-default/nextcloud", relation, headers));
  assert.equal(linked.statusCode, 202);
  assert.equal(JSON.parse(linked.body).data.link.externalId, relation.resourceId);
  assert.equal(JSON.parse(linked.body).data.link.linkType, "file");

  const listed = await handler(event("GET", "/api/v1/provider-api/workspace-default/nextcloud/work-items?projectId=project-pilot", undefined, {authorization: "Bearer cloud-provider-token"}));
  assert.equal(listed.statusCode, 200);
  assert.equal(JSON.parse(listed.body).data.items.some((item) => item.id === "work-cognito"), true);
});

test("hourly managed-resource reconciliation applies configured project membership", async () => {
  const calls = [];
  const runtime = new ProviderIntegrationRuntime({
    resolveCredential: async () => ({username: "service", appPassword: "app-password"}),
    fetchImpl: async (url, request) => {
      calls.push({url, request});
      if (request.method === "POST") return jsonResponse({ocs: {data: {}}});
      return jsonResponse({ocs: {data: []}});
    }
  });
  const repository = new MemoryRepository(undefined, {integrationRuntime: runtime});
  const capabilities = structuredClone(defaultWorkspaceCapabilities);
  capabilities.connectors = [{id: "managed-cloud", name: "Managed files", type: "nextcloud", enabled: true, credentialReference: "nextcloud", baseUrl: "https://cloud.test", managedPermissions: true, managedPrincipalPrefix: "managed-", managedResources: [{projectId: "project-pilot", resourceId: "Projects/Pilot"}]}];
  const admin = {workspaceId: "workspace-default", actorId: "user-demo-admin", correlationId: "test", membership: {role: "workspace-admin", status: "active"}};
  await repository.patchWorkspaceCapabilities(admin, capabilities);
  const result = await synchronizeManagedIntegrations(repository, "workspace-default");
  assert.equal(result.synchronizedCount, 1);
  assert.equal(calls.some((entry) => entry.request.method === "POST"), true);
});
