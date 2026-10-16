// @ts-nocheck

import assert from "node:assert/strict";
import test from "node:test";
import {defaultWorkspaceCapabilities, parseWorkspaceCapabilitiesInput} from "@teamspaces/contracts";
import {ProviderIntegrationRuntime, providerAdapterDescription} from "../src/integrations/provider-adapters.js";
import {MemoryRepository} from "../src/repositories/memory.js";
import {DynamoRepository} from "../src/repositories/dynamo.js";

const connector = {id: "github-project", type: "github", enabled: true, baseUrl: "https://api.github.test", credentialReference: "projects-credential", projectId: "project-pilot", repository: "owner/community", resourceKind: "projects", githubProjectId: "PVT_board", githubProjectVisibility: "private"};
const page = (hasNextPage = false, endCursor = null) => ({hasNextPage, endCursor});
const value = {__typename: "ProjectV2ItemFieldSingleSelectValue", name: "In progress", optionId: "status-active", field: {id: "PVTSSF_status", name: "Status"}};

function issueItem(id = "PVTI_issue", repository = connector.repository) {
  return {id, type: "ISSUE", isArchived: false, updatedAt: "2026-10-16T00:00:00Z", content: {__typename: "Issue", id: "I_issue", number: 7, title: "Deliver the scoped workflow", url: "https://github.test/owner/community/issues/7", state: "OPEN", repository: {id: "R_repository", nameWithOwner: repository, isPrivate: false}}, fieldValues: {nodes: [value], pageInfo: page()}};
}

function snapshot() {
  return {data: {node: {__typename: "ProjectV2", id: connector.githubProjectId, title: "Community delivery", url: "https://github.test/orgs/owner/projects/1", public: false, repositories: {nodes: [{id: "R_repository", nameWithOwner: connector.repository, isPrivate: false}], pageInfo: page()}, fields: {nodes: [{id: "PVTSSF_status", name: "Status", dataType: "SINGLE_SELECT", options: [{id: "status-active", name: "In progress"}]}], pageInfo: page()}, items: {nodes: [issueItem()], pageInfo: page()}}}};
}

function runtime(payload = snapshot()) {
  const requests = [];
  return {requests, adapter: new ProviderIntegrationRuntime({resolveCredential: async (reference) => {
    assert.equal(reference, connector.credentialReference);
    return {accessToken: "scoped-provider-token"};
  }, fetchImpl: async (url, options) => {
    requests.push({url, options});
    return new Response(JSON.stringify(payload), {status: 200, headers: {"content-type": "application/json"}});
  }})};
}

test("ProjectsV2 browses one read-only GraphQL snapshot through existing credential transport", async () => {
  const {adapter, requests} = runtime();
  const result = await adapter.developmentItems(connector);
  assert.equal(requests[0].url, "https://api.github.test/graphql");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers.authorization, "Bearer scoped-provider-token");
  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(body.variables, {projectId: "PVT_board", after: null});
  assert.match(body.query, /^query /);
  assert.ok(!body.query.includes("mutation"));
  assert.match(body.query, /items\(first: 25/);
  assert.match(body.query, /fields\(first: 50/);
  assert.match(body.query, /fieldValues\(first: 50/);
  assert.equal(result.project.public, false);
  assert.equal(result.project.fields[0].options[0].id, "status-active");
  assert.equal(result.items[0].metadata.contentNodeId, "I_issue");
  assert.equal(result.items[0].metadata.fieldValues[0].optionId, "status-active");
  assert.equal(result.items[0].metadata.repositoryVisibility, "public");
  assert.equal(result.queryScope, "current-page");
  assert.equal(result.truncated, false);
  assert.equal(result.redactedCount, 0);
});

test("all bounded pagination levels remain visible and cursors stay GraphQL variables", async () => {
  const payload = snapshot();
  payload.data.node.fields.pageInfo = page(true, "fields-next");
  payload.data.node.items.pageInfo = page(true, "items-next");
  payload.data.node.items.nodes[0].fieldValues.pageInfo = page(true, "values-next");
  const {adapter, requests} = runtime(payload);
  const result = await adapter.developmentItems(connector, {cursor: "items-previous"});
  assert.equal(JSON.parse(requests[0].options.body).variables.after, "items-previous");
  assert.equal(result.nextCursor, "items-next");
  assert.equal(result.fieldsPageInfo.hasNextPage, true);
  assert.equal(result.items[0].metadata.fieldValuesPageInfo.hasNextPage, true);
  assert.equal(result.repositoriesPageInfo.hasNextPage, false);
  assert.equal(result.truncated, true);
});

test("board association, visibility, GraphQL errors and repository pagination fail closed", async () => {
  for (const mutate of [
    (payload) => { payload.data.node.repositories.nodes = [{nameWithOwner: "other/private"}]; },
    (payload) => { payload.data.node.repositories.pageInfo = page(true, "more-repositories"); },
    (payload) => { payload.data.node.public = true; },
    (payload) => { payload.errors = [{message: "PRIVATE_PROVIDER_ERROR", type: "INSUFFICIENT_SCOPES"}]; },
    (payload) => { payload.data.node.__typename = "Repository"; },
    (payload) => { delete payload.data.node.fields.pageInfo; }
  ]) {
    const payload = snapshot();
    mutate(payload);
    await assert.rejects(runtime(payload).adapter.developmentItems(connector), (error) => error.status === 503 && !error.message.includes("PRIVATE_PROVIDER_ERROR"));
  }
});

test("foreign repository and redacted rows never disclose content; drafts require explicit opt-in", async () => {
  const payload = snapshot();
  const draft = {...issueItem("PVTI_draft"), type: "DRAFT_ISSUE", content: {__typename: "DraftIssue", id: "DI_draft", title: "The explicitly selected board draft"}};
  const foreign = issueItem("PRIVATE_ITEM_ID", "other/private");
  foreign.content.title = "PRIVATE_TITLE";
  payload.data.node.items.nodes.push(foreign, {id: "PRIVATE_REDACTED_ID", type: "REDACTED", content: null}, draft);
  const result = await runtime(payload).adapter.developmentItems(connector);
  assert.equal(result.items.length, 1);
  assert.equal(result.filteredCount, 2);
  assert.equal(result.redactedCount, 1);
  for (const secret of ["PRIVATE_ITEM_ID", "PRIVATE_TITLE", "PRIVATE_REDACTED_ID", "DI_draft"]) assert.ok(!JSON.stringify(result).includes(secret));
  const opted = await runtime(payload).adapter.developmentItems({...connector, includeProjectDrafts: true});
  assert.equal(opted.items.length, 2);
  const selected = opted.items.find((item) => item.id === "PVTI_draft");
  assert.equal(selected.metadata.contentType, "DraftIssue");
  assert.equal(selected.metadata.repositoryMapping, "configured-board");
  assert.equal(selected.linkType, "collaboration");
  assert.equal(selected.externalUrl, payload.data.node.url);
});

test("connector schema requires explicit project identity, repository, visibility and boolean draft policy", () => {
  const parse = (value) => parseWorkspaceCapabilitiesInput({...structuredClone(defaultWorkspaceCapabilities), connectors: [value]});
  assert.equal(parse(connector).connectors[0].githubProjectId, "PVT_board");
  assert.ok(providerAdapterDescription(connector).capabilities.includes("project-items"));
  assert.ok(!providerAdapterDescription(connector).capabilities.includes("verified-webhooks"));
  for (const changes of [{githubProjectId: undefined}, {githubProjectId: 'PVT_\" injection'}, {repository: "../private"}, {githubProjectVisibility: undefined}, {githubProjectVisibility: "unknown"}, {includeProjectDrafts: "true"}, {resourceKind: "projectsv2"}, {projectId: undefined}, {projectId: "invalid/project"}]) assert.throws(() => parse({...connector, ...changes}));
});

test("invalid cursors and oversized provider snapshots are rejected without broad reads", async () => {
  const {adapter, requests} = runtime();
  for (const cursor of ['cursor\"query', "a".repeat(501), "cursor\nnext"]) await assert.rejects(adapter.developmentItems(connector, {cursor}), {status: 400});
  assert.equal(requests.length, 0);
  const payload = snapshot();
  payload.data.node.items.nodes = Array.from({length: 26}, (_, index) => issueItem(`item-${index}`));
  await assert.rejects(runtime(payload).adapter.developmentItems(connector), {status: 503});
});

test("GitHub Enterprise GraphQL stays on the configured origin at its GraphQL endpoint", async () => {
  const {adapter, requests} = runtime();
  await adapter.developmentItems({...connector, baseUrl: "https://github.enterprise.test/api/v3"});
  assert.equal(requests[0].url, "https://github.enterprise.test/api/graphql");
});

test("both repository adapters enforce Teamspaces project access before provider retrieval", async () => {
  const capabilities = {...structuredClone(defaultWorkspaceCapabilities), connectors: [connector]};
  let calls = 0;
  const integrationRuntime = {developmentItems: async () => { calls += 1; return {}; }, health: async () => { calls += 1; return {}; }};
  for (const repository of [new MemoryRepository(undefined, {integrationRuntime}), new DynamoRepository({tableName: "test", integrationRuntime, documentClient: {async send() { return {Item: {id: "project-pilot", workspaceId: "workspace-default"}}; }}})]) {
    repository.getWorkspaceCapabilities = async () => capabilities;
    await assert.rejects(repository.browseIntegrationResources({workspaceId: "workspace-default", membership: {role: "member", projectIds: ["another-project"]}}, connector.id), {status: 404});
    await assert.rejects(repository.checkIntegrationHealth({workspaceId: "workspace-default", membership: {role: "member", projectIds: ["another-project"]}}, connector.id), {status: 404});
  }
  assert.equal(calls, 0);
});

test("public-project-only membership sees no private Projects connector IDs or repository metadata", async () => {
  const publicConnector = {...connector, projectId: "project-pilot"};
  const privateConnector = {...connector, id: "PRIVATE_CONNECTOR", githubProjectId: "PVT_PRIVATE", repository: "private/PRIVATE_REPOSITORY", projectId: "private-project"};
  const memory = new MemoryRepository();
  memory.projects.set("private-project", {id: "private-project", workspaceId: "workspace-default"});
  const dynamo = new DynamoRepository({tableName: "test", documentClient: {async send(command) { return {Item: {id: command.input.Key.PK.slice("PROJECT#".length), workspaceId: "workspace-default"}}; }}});
  dynamo.queryByPk = async () => [];
  for (const repository of [memory, dynamo]) {
    repository.getWorkspaceCapabilities = async () => ({...structuredClone(defaultWorkspaceCapabilities), connectors: [publicConnector, privateConnector]});
    const catalog = await repository.listIntegrationCatalog({workspaceId: "workspace-default", membership: {role: "member", projectIds: ["project-pilot"]}});
    assert.deepEqual(catalog.connectors.map((entry) => entry.id), [connector.id]);
    assert.ok(!JSON.stringify(catalog).includes("PRIVATE"));
  }
});

test("private boards include explicitly shared public issues while filtering private and unlisted repositories", async () => {
  const payload = snapshot();
  const publicShared = issueItem("shared-public", "core/community");
  const privateShared = issueItem("shared-private", "core/private");
  privateShared.content.repository.isPrivate = true;
  const unlisted = issueItem("unlisted", "other/community");
  payload.data.node.items.nodes.push(publicShared, privateShared, unlisted);
  const selected = {...connector, sharedRepositories: ["core/community", "core/private"]};
  const result = await runtime(payload).adapter.developmentItems(selected);
  assert.deepEqual(result.items.map((item) => item.id), ["PVTI_issue", "shared-public"]);
  assert.equal(result.items[1].metadata.repositoryMapping, "shared-public-repository");
  assert.equal(result.filteredCount, 2);
  assert.ok(!JSON.stringify(result).includes("shared-private"));
  const parse = (value) => parseWorkspaceCapabilitiesInput({...structuredClone(defaultWorkspaceCapabilities), connectors: [value]});
  assert.deepEqual(parse(selected).connectors[0].sharedRepositories, selected.sharedRepositories);
  for (const changes of [{githubProjectVisibility: "public"}, {sharedRepositories: ["../private"]}, {sharedRepositories: ["core/community", "CORE/COMMUNITY"]}]) assert.throws(() => parse({...selected, ...changes}));
});

test("configured planning status appears in the provider browser independently of issue state", async () => {
  const payload=snapshot();
  payload.data.node.items.nodes[0].fieldValues.nodes.push({...value,name:"Ready",field:{id:"planning-field",name:"Teamspaces status"}});
  const result=await runtime(payload).adapter.developmentItems({...connector,githubStatusField:"Teamspaces status"});
  assert.equal(result.items[0].metadata.status,"Ready");
  assert.equal(result.items[0].metadata.state,"OPEN");
});
