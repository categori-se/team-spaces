import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {defaultWorkspaceCapabilities, parseTaskCoordination} from "@teamspaces/contracts";
import {createHandler} from "../src/handler.js";
import {coordinationDashboard, coordinationSummary} from "../src/coordination.js";
import {materializeCoordinationProgram, openLocalCoordination} from "../src/local-coordination.js";
import {route} from "../src/routes/router.js";

process.env.ALLOW_DEMO_AUTH = "false";
process.env.ORIGIN_VERIFY_ENFORCED = "false";

function program() {
  const task = (key, status = "ready") => ({key, title: key, status, priority: "high", acceptanceCriteria: "Record the accepted workflow result.", blockedByKeys: [], coordination: {roleId: "workflow-review", nextAction: "Review current evidence.", decision: "", acceptanceState: "pending", scopePaths: [], evidence: [], parityIds: ["geolens.map-composition"], dependencies: []}});
  const managed = task("managed-release", "blocked");
  managed.coordination.dependencies = [{projectKey: "community", taskKey: "shared-review"}];
  return {schemaVersion: 1, initiativeId: "opengeo", title: "OpenGeo Studio", sourceId: "opengeo-program", owner: {id: "owner", name: "Project owner"}, sourceRevision: "fixture-revision", baselineSummary: {pass: 24, partial: 25, exclusion: 1}, projects: [
    {key: "community", name: "OpenGeo Studio [community edition]", facet: "community", repository: {url: "https://github.com/categori-se/opengeo-community", branch: "main", visibility: "public"}, tasks: [task("shared-review"), task("remaining-parity", "intake")]},
    {key: "main", name: "OpenGeo Studio", facet: "internal", repository: {url: "https://github.com/categorise/opengeo", branch: "main", visibility: "private"}, tasks: [managed]}
  ]};
}

function owner(seed) { return {actorId: "owner", workspaceId: seed.workspace.id, membership: seed.memberships[0], correlationId: "unit"}; }

async function send(handler, method, rawPath, body, authenticated = false) {
  const response = await handler({rawPath, headers: {}, requestContext: {http: {method}, ...(authenticated ? {authorizer: {jwt: {claims: {sub: "owner", name: "Project owner"}}}} : {})}, body: body === undefined ? undefined : JSON.stringify(body)});
  const payload = JSON.parse(response.body);
  return {status: response.statusCode, data: payload.data, problem: payload};
}

test("actual program enrolls connected canonical tasks with full names and separate backlog", async () => {
  const {repository, seed} = await materializeCoordinationProgram(program());
  const board = await coordinationDashboard(repository, owner(seed), "opengeo");
  assert.equal(board.title, "OpenGeo Studio");
  assert.equal(board.sample, false);
  assert.equal(board.tasks.length, 3);
  assert.equal(board.summary.ready, 1);
  assert.equal(board.summary.backlog, 1);
  assert.equal(board.summary.blocked, 1);
  assert.deepEqual(board.parityBaseline, {pass: 24, partial: 25, exclusion: 1});
  const managed = board.tasks.find(task => task.coordination.taskKey === "managed-release");
  assert.equal(managed.coordination.dependencies[0].taskId, board.tasks.find(task => task.coordination.taskKey === "shared-review").id);
  assert.equal(board.projects.some(project => project.name === "OpenGeo Studio [community edition]"), true);
});

test("acceptance for a same-ID task in another project never releases a prerequisite", () => {
  const tasks = [
    {id: "shared-id", projectId: "community", status: "ready", coordination: {acceptanceState: "pending"}},
    {id: "shared-id", projectId: "internal", status: "done", coordination: {acceptanceState: "accepted", evidence: [{label: "Review", url: "https://example.com/review"}]}},
    {id: "delivery", projectId: "internal", status: "ready", coordination: {acceptanceState: "pending", dependencies: [{projectId: "community", taskId: "shared-id"}]}}
  ];
  assert.deepEqual(coordinationSummary(tasks, {statuses: [{id: "done", closed: true}]}), {total: 3, accepted: 1, running: 0, blocked: 1, review: 0, ready: 1, backlog: 0});
});

test("anonymous reads see current community tasks while writes and private reads are denied", async () => {
  const {repository} = await materializeCoordinationProgram(program());
  const handler = createHandler({repository});
  const first = await send(handler, "GET", "/api/v1/public/coordination/opengeo");
  assert.equal(first.status, 200);
  assert.equal(first.data.title, "OpenGeo Studio [community edition]");
  assert.equal(first.data.tasks.length, 2);
  assert.equal(first.data.readOnly, true);
  const shared = first.data.tasks.find(task => task.title === "shared-review");
  assert.equal((await send(handler, "PATCH", `/api/v1/projects/${shared.projectId}/work-items/${shared.id}`, {version: 1, title: "Updated requirement"}, true)).status, 200);
  assert.equal((await send(handler, "GET", "/api/v1/public/coordination/opengeo")).data.tasks.some(task => task.title === "Updated requirement"), true);
  const privateId = [...repository.workItems.values()].find(task => task.coordination.taskKey === "managed-release").id;
  assert.equal(JSON.stringify(first.data).includes(privateId), false);
  assert.equal((await send(handler, "GET", "/api/v1/coordination")).status, 401);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((await send(handler, method, "/api/v1/public/coordination/opengeo", {}, true)).status, 403);
  assert.equal((await send(handler, "POST", "/api/v1/coordination/setup", {}, true)).status, 404);
});

test("public registration requires management, current version and community scope", async () => {
  const {repository} = await materializeCoordinationProgram(program());
  const handler = createHandler({repository});
  const current = await repository.getPublicCoordinationRegistration("opengeo");
  const body = {initiativeId: "opengeo", projectIds: current.projectIds, version: 1, enabled: false};
  assert.equal((await send(handler, "PUT", "/api/v1/coordination/public-registration", body)).status, 401);
  assert.equal((await send(handler, "PUT", "/api/v1/coordination/public-registration", body, true)).status, 200);
  assert.equal((await send(handler, "GET", "/api/v1/public/coordination/opengeo")).status, 404);
  assert.equal((await send(handler, "PUT", "/api/v1/coordination/public-registration", body, true)).status, 409);
  const internal = [...repository.projects.values()].find(project => project.coordination.facet === "internal");
  assert.equal((await send(handler, "PUT", "/api/v1/coordination/public-registration", {...body, version: 2, enabled: true, projectIds: [internal.id]}, true)).status, 400);
});

test("cross-project links check actor access and hide private task references", async () => {
  const {repository, seed} = await materializeCoordinationProgram(program());
  const context = owner(seed);
  const tasks = [...repository.workItems.values()];
  const shared = tasks.find(task => task.coordination.taskKey === "shared-review");
  const internal = tasks.find(task => task.coordination.taskKey === "managed-release");
  const coordination = {...shared.coordination, dependencies: [{projectId: internal.projectId, taskId: internal.id}]};
  const restricted = {...context, membership: {...context.membership, projectIds: [shared.projectId]}};
  await assert.rejects(repository.patchWorkItem(restricted, shared.projectId, shared.id, {version: shared.version, coordination}), /not found/i);
  await repository.patchWorkItem(context, shared.projectId, shared.id, {version: shared.version, coordination});
  const result = await send(createHandler({repository}), "GET", "/api/v1/public/coordination/opengeo");
  assert.equal(JSON.stringify(result.data).includes(internal.id), false);
  assert.equal(JSON.stringify(result.data).includes("managed-release"), false);
});

test("bootstrap and capabilities omit restricted GitHub Projects bindings without changing internal configuration", async () => {
  const {repository, seed} = await materializeCoordinationProgram(program());
  const context = owner(seed);
  const projects = [...repository.projects.values()];
  const community = projects.find(project => project.coordination.facet === "community");
  const internal = projects.find(project => project.coordination.facet === "internal");
  const connectors = [community, internal].map(project => ({id: project.coordination.facet, type: "github", resourceKind: "projects", projectId: project.id, githubProjectId: `${project.coordination.facet}-board`, repository: project.coordination.repository.url}));
  const capabilities = {...structuredClone(defaultWorkspaceCapabilities), connectors};
  repository.getWorkspaceCapabilities = async () => structuredClone(capabilities);
  const restricted = {...context, membership: {...context.membership, projectIds: [community.id]}};
  for (const path of ["/bootstrap", "/capabilities"]) {
    const response = await route({method: "GET", path, searchParams: new URLSearchParams(), body: undefined, context: restricted, repository});
    const visible = path === "/bootstrap" ? response.capabilities : response;
    assert.deepEqual(visible.connectors.map(connector => connector.id), ["community"]);
    assert.ok(!JSON.stringify(visible).includes("internal-board"));
  }
  assert.equal((await repository.getWorkspaceCapabilities(context)).connectors.length, 2);
});

test("owner-key authentication and real records survive a local restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "teamspaces-real-program-"));
  try {
    const manifestPath = path.join(directory, "program.json");
    await writeFile(manifestPath, JSON.stringify(program()), {mode: 0o600});
    const stateDirectory = path.join(directory, "state");
    const first = await openLocalCoordination({manifestPath, stateDirectory});
    const key = (await readFile(first.ownerKeyFile, "utf8")).trim();
    assert.equal(first.session("incorrect"), undefined);
    const session = first.session(key);
    assert.equal(first.identity(`Bearer ${session.access_token}`).sub, "owner");
    assert.equal(first.identity(`Bearer ${session.access_token.slice(0, -1)}x`), undefined);
    const task = [...first.repository.workItems.values()][0];
    task.title = "Retained maintainer change";
    await first.save();
    const second = await openLocalCoordination({manifestPath, stateDirectory});
    assert.equal(second.restored, true);
    assert.equal(second.repository.workItems.size, 3);
    assert.equal(second.repository.workItems.get(task.id).title, "Retained maintainer change");
    assert.equal(second.identity(`Bearer ${session.access_token}`).sub, "owner");
    assert.equal((await stat(first.ownerKeyFile)).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(stateDirectory, "records.json"))).mode & 0o777, 0o600);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test("metadata rejects invalid links and duplicate cross-project references", () => {
  assert.throws(() => parseTaskCoordination({roleId: "maintenance", dependencies: [{projectId: "other", taskId: "bad/id"}]}));
  assert.throws(() => parseTaskCoordination({roleId: "maintenance", dependencies: [{projectId: "other", taskId: "task"}, {projectId: "other", taskId: "task"}]}));
  assert.throws(() => parseTaskCoordination({roleId: "maintenance", evidence: [{label: "Bad", url: "javascript:alert(1)"}]}));
  assert.deepEqual(parseTaskCoordination({roleId: "maintenance", parityIds: ["geolens.map-composition"]}).parityIds, ["geolens.map-composition"]);
});

test("coordination covers different initiatives while program names remain project data", async () => {
  const {repository, seed} = await materializeCoordinationProgram(program());
  const context = owner(seed);
  const extra = await repository.createProject(context, {name: "Team Spaces", coordination: {initiativeId: "teamspaces", facet: "community", key: "platform"}});
  const board = await coordinationDashboard(repository, context);
  assert.equal(board.title, "Coordination");
  assert.equal(board.projects.length, 3);
  assert.ok(board.projects.some(project => project.id === extra.id));
  const other = {...program(), initiativeId: "teamspaces", title: "Team Spaces", projects: [{key: "platform", name: "Team Spaces", facet: "community", tasks: []}]};
  const enrolled = await materializeCoordinationProgram(other);
  assert.equal(enrolled.seed.workspace.name, "Project workspace");
  assert.equal(enrolled.repository.publicCoordinationRegistrations.get("teamspaces").title, "Team Spaces");
});

test("versioned publication can record a named parity baseline without accepting roadmap tasks", async () => {
  const {repository} = await materializeCoordinationProgram(program());
  const handler=createHandler({repository});
  const current=await repository.getPublicCoordinationRegistration("opengeo");
  const body={initiativeId:"opengeo",projectIds:current.projectIds,version:current.version,enabled:true,
    parityBaseline:{pass:39,partial:0,exclusion:3,reference:"Reference PM 17.7.2 — local source/test baseline"}};
  for (const parityBaseline of [{pass:-1,partial:0,exclusion:0},{pass:1001,partial:0,exclusion:0},{pass:39,partial:0,exclusion:3,privateSource:"hidden"},{pass:39,partial:0,exclusion:3,reference:"invalid\nreference"}]) {
    assert.equal((await send(handler,"PUT","/api/v1/coordination/public-registration",{...body,parityBaseline},true)).status,400);
  }
  assert.equal((await send(handler,"PUT","/api/v1/coordination/public-registration",body,true)).status,200);
  const result=await send(handler,"GET","/api/v1/public/coordination/opengeo");
  assert.deepEqual(result.data.parityBaseline,body.parityBaseline);
  assert.notEqual(result.data.summary.accepted,39);
  assert.equal((await send(handler,"PUT","/api/v1/coordination/public-registration",body,true)).status,409);
});
