// @ts-nocheck

import assert from "node:assert/strict";
import test from "node:test";
import {GetCommand, QueryCommand} from "@aws-sdk/lib-dynamodb";
import {defaultWorkConfiguration, parseWorkItemPatchInput} from "@teamspaces/contracts";
import {createHandler, createPublicDemoHandler} from "../src/handler.js";
import {createPublicCoordinationHandler, publicCoordinationProjection, publicCoordinationRegistrationKey, publicCoordinationTaskLimit} from "../src/public-coordination.js";
import {createPublicDemoSeed, publicDemoRequestPolicy} from "../src/demo/public-demo.js";
import {MemoryRepository} from "../src/repositories/memory.js";
import {DynamoRepository} from "../src/repositories/dynamo.js";

process.env.ORIGIN_VERIFY_ENFORCED = "false";
const sentinel = "PRIVATE_SENTINEL_NEVER_PUBLIC";
const workspaceId = "workspace-default";
const registration = {initiativeId: "opengeo", title: "OpenGeo Studio [community edition]", workspaceId, projectIds: ["community"], enabled: true, version: 1};
const privateEvidence = {label: sentinel, url: "https://example.com/private?token=secret", visibility: "private"};

function project(id = "community", facet = "community") {
  return {id, workspaceId, name: facet === "community" ? "OpenGeo Studio [community edition]" : sentinel, coordination: {initiativeId: "opengeo", facet}, version: 1};
}

function task(id = "public-task", projectId = "community") {
  return {id, workspaceId, projectId, title: projectId === "community" ? "Complete the published workflow" : sentinel, status: "ready", priority: "high", type: "task", version: 1, blockedBy: [], acceptanceCriteria: "The published workflow passes its acceptance review.", coordination: {roleId: "feature-delivery", nextAction: "Finish the current implementation.", acceptanceState: "pending", evidence: []}};
}

function harness() {
  const repository = new MemoryRepository();
  repository.projects.set("community", project());
  repository.projects.set("internal", project("internal", "internal"));
  repository.workItems.set("public-task", task());
  repository.workItems.set("internal-task", task("internal-task", "internal"));
  repository.publicCoordinationRegistrations.set("opengeo", structuredClone(registration));
  repository.getOrBootstrap = async () => assert.fail("public reads must never bootstrap identity");
  repository.listMemberships = async () => assert.fail("public reads must never load memberships");
  repository.listProjects = async () => assert.fail("public reads must never enumerate projects");
  return {repository, handler: createHandler({repository})};
}

async function send(handler, method = "GET", path = "/api/v1/public/coordination/opengeo", extras = {}) {
  const response = await handler({rawPath: path, headers: {"x-teamspaces-account-id": "internal", "x-demo-user-id": sentinel, authorization: "Bearer ignored"}, requestContext: {http: {method}, authorizer: {jwt: {claims: {sub: sentinel}}}}, ...extras});
  return {response, payload: JSON.parse(response.body)};
}

test("anonymous tracker uses canonical community records without identity or project enumeration", async () => {
  const {handler} = harness();
  const {response, payload} = await send(handler);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(payload.data.title, "OpenGeo Studio [community edition]");
  assert.equal(payload.data.audience, "public");
  assert.equal(payload.data.sample, false);
  assert.equal(payload.data.readOnly, true);
  assert.equal(payload.data.canManage, false);
  assert.equal(payload.data.tasks.length, 1);
  assert.equal(payload.data.tasks[0].id, "public-task");
  assert.ok(!JSON.stringify(payload).includes(sentinel));
});

test("authenticated edits to the same task are visible on the next public read", async () => {
  const {repository, handler} = harness();
  await repository.patchWorkItem({actorId: "user-demo-admin", workspaceId, membership: {role: "workspace-admin"}, correlationId: "edit"}, "community", "public-task", parseWorkItemPatchInput({version: 1, title: "The current edited workflow", status: "in-progress"}));
  const {payload} = await send(handler);
  assert.equal(payload.data.tasks[0].title, "The current edited workflow");
  assert.equal(payload.data.summary.running, 1);
  assert.equal(payload.data.summary.total, 1);
});

test("private dependencies and unknown fields never expose private IDs, counts, titles or metadata", async () => {
  const {repository, handler} = harness();
  const current = repository.workItems.get("public-task");
  Object.assign(current, {description: sentinel, assigneeId: sentinel, activity: [sentinel], unknown: {secret: sentinel}, blockedBy: ["internal-task", sentinel]});
  Object.assign(current.coordination, {sourceId: sentinel, taskKey: sentinel, scopePaths: [sentinel], run: {id: sentinel}, dependencies: [{projectId: "internal", taskId: "internal-task"}, {projectId: sentinel, taskId: sentinel}], evidence: [privateEvidence]});
  const {payload} = await send(handler);
  for (const value of [sentinel, "internal-task", '"internal"', "scopePaths", "sourceId", "taskKey", '"run"', '"dependencies"', "assigneeId"]) assert.ok(!JSON.stringify(payload).includes(value), value);
  assert.deepEqual(payload.data.tasks[0].blockedBy, []);
  assert.equal(payload.data.tasks[0].blocked, false);
  assert.deepEqual(payload.data.tasks[0].coordination.evidence, []);
  assert.deepEqual(payload.data.summary, {total: 1, accepted: 0, running: 0, blocked: 0, review: 0, ready: 1, backlog: 0});
  current.status = "blocked";
  assert.equal((await send(handler)).payload.data.summary.blocked, 1);
});

test("public dependency edges remain visible and accepted work retains its canonical state", async () => {
  const {repository, handler} = harness();
  repository.workItems.set("accepted", {...task("accepted"), status: "done", coordination: {roleId: "workflow-review", acceptanceState: "accepted", evidence: [privateEvidence]}});
  repository.workItems.get("public-task").coordination.dependencies = [{projectId: "community", taskId: "accepted"}, {projectId: "internal", taskId: "internal-task"}];
  const {payload} = await send(handler);
  assert.equal(payload.data.summary.accepted, 1);
  assert.deepEqual(payload.data.tasks.find((item) => item.id === "public-task").blockedBy, ["accepted"]);
  assert.equal(payload.data.tasks.find((item) => item.id === "public-task").blocked, false);
  assert.deepEqual(payload.data.tasks.find((item) => item.id === "accepted").coordination.evidence, []);
  assert.ok(!JSON.stringify(payload).includes(sentinel));
});

test("intake and unknown task states remain backlog, while open decisions block ready work", async () => {
  const {repository, handler} = harness();
  repository.workItems.get("public-task").status = "intake";
  repository.workItems.set("unknown", {...task("unknown"), status: "not-yet-triaged"});
  repository.workItems.set("decision", {...task("decision"), coordination: {...task().coordination, decision: "Choose the delivery scope."}});
  repository.workItems.set("ready", task("ready"));
  const {payload} = await send(handler);
  assert.deepEqual(payload.data.summary, {total: 4, accepted: 0, running: 0, blocked: 1, review: 0, ready: 1, backlog: 2});
  assert.equal(payload.data.tasks.find((item) => item.id === "decision").blocked, true);
});

test("reviewed parity baseline is separate from canonical task completion and strictly bounded", async () => {
  const {repository, handler} = harness();
  const mapping = repository.publicCoordinationRegistrations.get("opengeo");
  mapping.parityBaseline = {pass: 24, partial: 25, exclusion: 1, unknown: sentinel};
  const {payload} = await send(handler);
  assert.deepEqual(payload.data.parityBaseline, {pass: 24, partial: 25, exclusion: 1});
  assert.equal(payload.data.summary.total, 1);
  assert.equal(payload.data.summary.accepted, 0);
  assert.ok(!JSON.stringify(payload).includes(sentinel));
  for (const baseline of [{pass: -1, partial: 25, exclusion: 1}, {pass: "24", partial: 25, exclusion: 1}, {pass: 1.5, partial: 0, exclusion: 0}, {pass: 1000, partial: 1, exclusion: 0}, {pass: 24, partial: 25}]) {
    mapping.parityBaseline = baseline;
    assert.equal((await send(handler)).payload.data.parityBaseline, undefined);
  }
});

test("duplicate task IDs in separate enrolled projects fail closed before dependencies flatten", async () => {
  const {repository, handler} = harness();
  repository.projects.set("community-two", project("community-two"));
  repository.publicCoordinationRegistrations.get("opengeo").projectIds.push("community-two");
  repository.workItems.set("second-storage-row", {...task("public-task", "community-two"), status: "done", coordination: {roleId: "workflow-review", acceptanceState: "accepted", evidence: [privateEvidence]}});
  const {response, payload} = await send(handler);
  assert.equal(response.statusCode, 404);
  assert.equal(payload.data, undefined);
  assert.ok(!response.body.includes("public-task"));
  assert.ok(!response.body.includes(sentinel));
});

test("mutations, extra paths and ambiguous paths are denied regardless of JWT or account headers", async () => {
  const {handler, repository} = harness();
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) assert.equal((await send(handler, method)).response.statusCode, 403);
  for (const path of ["/opengeo/setup", "/opengeo/sync", "/opengeo/runs", "/../internal", "/%2e%2e/internal", "/%6fpengeo", "/opengeo/", "/opengeo//"]) assert.equal((await send(handler, "GET", `/api/v1/public/coordination${path}`)).response.statusCode, 403);
  assert.equal(repository.workItems.get("public-task").version, 1);
});

test("tracker rejects caller workspace/query/body overrides and applies the origin gate", async () => {
  const {handler, repository} = harness();
  assert.equal((await send(handler, "GET", undefined, {rawQueryString: "workspaceId=internal"})).response.statusCode, 400);
  assert.equal((await send(handler, "GET", undefined, {body: "{}"})).response.statusCode, 400);
  assert.equal((await send(createPublicCoordinationHandler({repository, originAllows: () => false}))).response.statusCode, 403);
});

test("missing, revoked, cross-workspace, private, archived or deleted registrations fail closed", async () => {
  for (const change of [
    (repository) => repository.publicCoordinationRegistrations.clear(),
    (repository) => { repository.publicCoordinationRegistrations.get("opengeo").enabled = false; },
    (repository) => { repository.publicCoordinationRegistrations.get("opengeo").workspaceId = "another-workspace"; },
    (repository) => { repository.publicCoordinationRegistrations.get("opengeo").projectIds = ["internal"]; },
    (repository) => { repository.projects.get("community").coordination.facet = "internal"; },
    (repository) => { repository.projects.get("community").coordination.initiativeId = "another"; },
    (repository) => { repository.projects.get("community").archived = true; },
    (repository) => { repository.projects.get("community").deletedAt = "2026-10-16T00:00:00Z"; }
  ]) {
    const {repository, handler} = harness();
    change(repository);
    const {response, payload} = await send(handler);
    assert.equal(response.statusCode, 404);
    assert.ok(!JSON.stringify(payload).includes(sentinel));
  }
});

test("registration is checked again after canonical reads to honor concurrent revocation", async () => {
  const {repository, handler} = harness();
  const read = repository.readPublicCoordinationState.bind(repository);
  repository.readPublicCoordinationState = async (mapping) => {
    const state = await read(mapping);
    repository.publicCoordinationRegistrations.get("opengeo").enabled = false;
    return state;
  };
  const {response, payload} = await send(handler);
  assert.equal(response.statusCode, 404);
  assert.equal(payload.data, undefined);
});

test("public evidence omits credentials, capabilities, local hosts and local paths", () => {
  const unsafe = ["https://user:pass@example.com/review", "https://example.com/review?token=secret", "https://example.com/review#secret", "http://localhost/review", "https://localhost/review", "https://private.internal/review", "https://127.0.0.1/review", "https://[::1]/review", "https://example.com/home/aaron/review", "https://example.com/%00private", "file:///tmp/review"];
  const current = task();
  current.coordination.evidence = [{label: "Public review", url: "https://example.com/review", visibility: "public", unknown: sentinel}, ...unsafe.map((url) => ({label: sentinel, url, visibility: "public"})), privateEvidence];
  current.coordination.parityIds = ["PARITY-17", {secret: sentinel}];
  const canonicalProject = project();
  canonicalProject.coordination.repository = {url: "https://github.com/categori-se/opengeo-community", visibility: "public", sourceRefs: sentinel};
  canonicalProject.coordination.githubProject = {url: "https://github.com/orgs/categori-se/projects/2", visibility: "public", sourceRefs: sentinel};
  const result = publicCoordinationProjection({registration, projects: [canonicalProject], tasks: [current], workConfiguration: {...defaultWorkConfiguration, security: sentinel}});
  assert.deepEqual(result.tasks[0].coordination.evidence, [{label: "Public review", url: "https://example.com/review", visibility: "public"}]);
  assert.deepEqual(result.tasks[0].coordination.parityIds, ["PARITY-17"]);
  assert.deepEqual(result.projects[0].coordination.repository, {url: "https://github.com/categori-se/opengeo-community", visibility: "public"});
  assert.deepEqual(result.projects[0].coordination.githubProject, {url: "https://github.com/orgs/categori-se/projects/2", visibility: "public"});
  canonicalProject.coordination.githubProject.visibility = "private";
  const restricted = publicCoordinationProjection({registration, projects: [canonicalProject], tasks: [current], workConfiguration: defaultWorkConfiguration});
  assert.equal(restricted.projects[0].coordination.githubProject, undefined);
  assert.deepEqual(Object.keys(result.workConfiguration), ["statuses"]);
  assert.ok(result.workConfiguration.statuses.every((status) => Object.keys(status).join(",") === "id,label,closed"));
  assert.ok(!JSON.stringify(result).includes(sentinel));
});

test("Dynamo reads only consistent exact registration and enrolled project keys without member or index reads", async () => {
  const commands = [];
  let queries = 0;
  const client = {async send(command) {
    commands.push(command);
    if (command instanceof GetCommand) {
      const key = command.input.Key;
      if (key.PK === "PUBLIC_COORDINATION#opengeo") return {Item: {...publicCoordinationRegistrationKey("opengeo"), ...registration}};
      if (key.PK === "PROJECT#community") return {Item: {...key, ...project()}};
      if (key.PK === `WORKSPACE#${workspaceId}` && key.SK === "WORK_CONFIGURATION") return {};
      assert.fail(`Unexpected key ${JSON.stringify(key)}`);
    }
    assert.ok(command instanceof QueryCommand);
    assert.equal(command.input.ExpressionAttributeValues[":project"], "PROJECT#community");
    assert.equal(command.input.ExpressionAttributeValues[":work"], "WORK#");
    queries += 1;
    return queries === 1 ? {Items: [{...task(), PK: "PROJECT#community", SK: "WORK#public-task"}], LastEvaluatedKey: {PK: "PROJECT#community", SK: "WORK#public-task"}} : {Items: []};
  }};
  const repository = new DynamoRepository({tableName: "canonical-table", documentClient: client});
  const {response, payload} = await send(createPublicCoordinationHandler({repository, originAllows: () => true}));
  assert.equal(response.statusCode, 200);
  assert.equal(payload.data.tasks.length, 1);
  assert.equal(queries, 2);
  assert.ok(commands.every((command) => command.input.ConsistentRead === true && command.input.TableName === "canonical-table" && !command.input.IndexName));
});

test("reader refuses partial progress totals beyond its canonical task bound", async () => {
  const {repository, handler} = harness();
  for (let index = 0; index < publicCoordinationTaskLimit; index += 1) repository.workItems.set(`bounded-${index}`, task(`bounded-${index}`));
  const {response, payload} = await send(handler);
  assert.equal(response.statusCode, 400);
  assert.equal(payload.data, undefined);
});

test("generic writable demo retains no OpenGeo seed or real tracker authority", async () => {
  const seed = createPublicDemoSeed("a");
  assert.equal(seed.projects.length, 3);
  assert.equal(seed.workItems.length, 15);
  assert.equal(seed.projects.some((item) => item.coordination?.initiativeId === "opengeo"), false);
  assert.equal(publicDemoRequestPolicy("GET", "/api/v1/demo/coordination").allowed, false);
  const handler = createPublicDemoHandler({repository: new MemoryRepository(seed)});
  assert.equal((await send(handler, "GET", "/api/v1/demo/coordination")).response.statusCode, 403);
  assert.equal((await send(handler)).response.statusCode, 403);
});

test("public discovery lists multiple published projects without tasks, private records or identity bootstrap", async () => {
  const {repository, handler} = harness();
  repository.readPublicCoordinationState = async () => assert.fail("discovery must not read task partitions");
  repository.projects.set("platform", {...project("platform"), name: "Team Spaces", coordination: {initiativeId: "teamspaces", facet: "community"}});
  repository.publicCoordinationRegistrations.set("teamspaces", {...registration, initiativeId: "teamspaces", title: "Team Spaces", projectIds: ["platform"]});
  repository.projects.set("unpublished", {...project("unpublished"), name: sentinel});
  repository.publicCoordinationRegistrations.set("revoked", {...registration, initiativeId: "revoked", enabled: false, projectIds: ["unpublished"]});
  const {response, payload} = await send(handler, "GET", "/api/v1/public/projects");
  assert.equal(response.statusCode, 200);
  assert.equal(payload.data.readOnly, true);
  assert.deepEqual(payload.data.projects.map(record => record.name), ["OpenGeo Studio [community edition]", "Team Spaces"]);
  assert.ok(!JSON.stringify(payload).includes(sentinel));
  assert.deepEqual(Object.keys(payload.data.projects[0]), ["id", "name", "initiativeId"]);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((await send(handler, method, "/api/v1/public/projects")).response.statusCode, 403);
  repository.projects.get("community").archived = true;
  assert.deepEqual((await send(handler, "GET", "/api/v1/public/projects")).payload.data.projects.map(record => record.id), ["platform"]);
});

test("Dynamo directory uses only its public index and validates canonical registration revocation", async () => {
  const commands = [];
  const records = new Map([
    [JSON.stringify(publicCoordinationRegistrationKey("opengeo")), registration],
    [JSON.stringify(publicCoordinationRegistrationKey("revoked")), {...registration, enabled: false}],
    [JSON.stringify({PK: "PROJECT#community", SK: "META"}), project()]
  ]);
  const repository = new DynamoRepository({tableName: "directory", documentClient: {async send(command) {
    commands.push(command);
    if (command instanceof QueryCommand) return {Items: [{initiativeId: "opengeo"}, {initiativeId: "revoked"}]};
    assert.ok(command instanceof GetCommand);
    return {Item: records.get(JSON.stringify(command.input.Key))};
  }}});
  repository.getOrBootstrap = async () => assert.fail("public discovery must not authenticate");
  const handler = createHandler({repository});
  const first = await send(handler, "GET", "/api/v1/public/projects");
  assert.equal(first.response.statusCode, 200);
  assert.deepEqual(first.payload.data.projects.map(record => record.id), ["community"]);
  const queries = commands.filter(command => command instanceof QueryCommand);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].input.IndexName, "GSI1");
  assert.deepEqual(queries[0].input.ExpressionAttributeValues, {":directory": "PUBLIC_COORDINATION"});
  assert.equal(queries[0].input.Limit, 11);
  assert.ok(!commands.some(command => command.input.Key?.SK.startsWith("WORK#")));
  records.get(JSON.stringify(publicCoordinationRegistrationKey("opengeo"))).enabled = false;
  assert.deepEqual((await send(handler, "GET", "/api/v1/public/projects")).payload.data.projects, []);
});

test("Dynamo registration indexes only enabled published initiatives", async () => {
  const commands = [];
  const repository = new DynamoRepository({tableName: "directory", documentClient: {async send(command) {commands.push(command); return {};}}});
  let current;
  repository.getPublicCoordinationRegistration = async () => current;
  repository.getProject = async () => project();
  const context = {workspaceId, membership: {role: "workspace-admin"}};
  current = await repository.setPublicCoordinationRegistration(context, {initiativeId: "opengeo", projectIds: ["community"], enabled: true, version: 0});
  assert.equal(commands[0].input.Item.GSI1PK, "PUBLIC_COORDINATION");
  assert.equal(commands[0].input.Item.GSI1SK, "opengeo");
  await repository.setPublicCoordinationRegistration(context, {initiativeId: "opengeo", projectIds: ["community"], enabled: false, version: 1});
  assert.equal(commands[1].input.Item.GSI1PK, undefined);
});
