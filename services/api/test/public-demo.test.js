// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {createPublicDemoHandler} from "../src/handler.js";
import {
  createPublicDemoSeed,
  MemoryPublicDemoControl,
  publicDemoBodyLimitBytes,
  publicDemoIdentity,
  publicDemoPageLimit,
  publicDemoProjectIdPrefix,
  publicDemoResponseLimitBytes,
  publicDemoStringLimit,
  publicDemoWorkspaceId
} from "../src/demo/public-demo.js";
import {MemoryRepository} from "../src/repositories/memory.js";
import {DynamoRepository} from "../src/repositories/dynamo.js";

process.env.ORIGIN_VERIFY_ENFORCED = "false";
process.env.APP_ORIGIN = "https://team-spaces.example";

function demoEvent(method, target, body, headers = {}) {
  const [rawPath, rawQueryString = ""] = target.split("?");
  return {
    rawPath,
    rawQueryString,
    headers: {
      origin: "https://team-spaces.example",
      "x-demo-user-id": "attacker-controlled-user",
      "x-demo-user-email": "attacker@example.test",
      "x-demo-user-name": "Attacker",
      "x-teamspaces-account-id": "workspace-private",
      ...headers
    },
    requestContext: {
      http: {method},
      authorizer: {jwt: {claims: {sub: "attacker-jwt-sub", email: "jwt@example.test"}}}
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
  };
}

async function send(handler, method, target, body, headers) {
  const response = await handler(demoEvent(method, target, body, headers));
  return {response, payload: response.body ? JSON.parse(response.body) : undefined};
}

function demoHarness(options = {}) {
  const now = new Date("2026-08-14T12:00:00.000Z");
  const seed = createPublicDemoSeed("a", now);
  const repository = new MemoryRepository(seed);
  const control = new MemoryPublicDemoControl({
    slot: "a",
    now,
    mutationLimit: options.mutationLimit ?? 500
  });
  return {seed, repository, control, handler: createPublicDemoHandler({repository, control})};
}

test("public demo fixes identity and active workspace server-side", async () => {
  const {handler, seed} = demoHarness();
  const bootstrap = await send(handler, "GET", "/api/v1/demo/bootstrap");
  assert.equal(bootstrap.response.statusCode, 200);
  assert.deepEqual(bootstrap.payload.data.user, publicDemoIdentity("a"));
  assert.equal(bootstrap.payload.data.workspace.id, publicDemoWorkspaceId("a"));
  assert.equal(bootstrap.payload.data.membership.userId, publicDemoIdentity("a").id);
  assert.equal(bootstrap.payload.data.publicDemo.shared, true);
  assert.equal(bootstrap.payload.data.publicDemo.editable, true);
  assert.equal(bootstrap.payload.data.publicDemo.nextResetAt, "2026-08-15T05:00:00.000Z");
  assert.equal(bootstrap.payload.data.projects.length, 3);
  assert.equal(seed.users.length, 5);

  const members = await send(handler, "GET", "/api/v1/demo/memberships");
  assert.equal(members.response.statusCode, 200);
  assert.equal(members.payload.data.items.length, 5);
  assert.equal(members.payload.data.items.some((item) => item.email === "attacker@example.test"), false);
});

test("the seeded demo supports every application read surface", async () => {
  const {handler, seed} = demoHarness();
  const project = seed.projects[0];
  const meeting = seed.meetings.find((item) => item.projectId === project.id);
  const reads = [
    "/api/v1/demo/health",
    "/api/v1/demo/bootstrap",
    "/api/v1/demo/me",
    "/api/v1/demo/accounts",
    "/api/v1/demo/workspace",
    "/api/v1/demo/work-configuration",
    "/api/v1/demo/memberships",
    "/api/v1/demo/portfolios",
    `/api/v1/demo/portfolios/${seed.portfolios[0].id}`,
    "/api/v1/demo/projects",
    `/api/v1/demo/projects/${project.id}`,
    `/api/v1/demo/projects/${project.id}/work-items`,
    "/api/v1/demo/work-items/assigned",
    "/api/v1/demo/planning",
    `/api/v1/demo/meetings?projectId=${project.id}`,
    `/api/v1/demo/meetings/${meeting.id}?projectId=${project.id}`,
    "/api/v1/demo/time-entries",
    "/api/v1/demo/activity",
    "/api/v1/demo/documents",
    "/api/v1/demo/saved-views",
    "/api/v1/demo/reports/portfolio-summary",
    "/api/v1/demo/reports/planning-summary",
    "/api/v1/demo/reports/project-timeline",
    "/api/v1/demo/application-data/summary"
  ];
  for (const path of reads) {
    const result = await send(handler, "GET", path);
    assert.equal(result.response.statusCode, 200, `${path}: ${result.payload?.detail ?? "unexpected response"}`);
  }

  const documents = await send(handler, "GET", "/api/v1/demo/documents");
  assert.equal(documents.payload.data.items.length, 4);
  assert.equal(documents.payload.data.items.every((document) => document.sampleOnly && document.samplePreview), true);
  assert.equal(documents.payload.data.items.every((document) => document.objectKey === undefined), true);
});

test("public demo allows bounded content exploration and namespaced project creation", async () => {
  const {handler} = demoHarness();
  const created = await send(handler, "POST", "/api/v1/demo/projects", {
    name: "Visitor experiment",
    description: "A temporary shared demo project",
    status: "active",
    health: "on-track",
    priority: "medium",
    phase: "Proposed",
    percentComplete: 0,
    tags: ["demo"]
  });
  assert.equal(created.response.statusCode, 201);
  assert.equal(created.payload.data.id.startsWith(publicDemoProjectIdPrefix("a")), true);
  assert.equal(created.payload.data.workspaceId, publicDemoWorkspaceId("a"));

  const task = await send(handler, "POST", `/api/v1/demo/projects/${created.payload.data.id}/work-items`, {
    title: "Explore the board",
    status: "ready",
    type: "task",
    effortPoints: 3
  });
  assert.equal(task.response.statusCode, 201);
  assert.equal(task.payload.data.projectId, created.payload.data.id);

  const configuration = await send(handler, "GET", "/api/v1/demo/work-configuration");
  const replacement = structuredClone(configuration.payload.data);
  replacement.statuses.push({id: "review", label: "Review", active: true, closed: false});
  replacement.transitions.push({fromStatusId: replacement.defaultStatusId, toStatusId: "review", roles: ["workspace-admin"]});
  const configured = await send(handler, "PATCH", "/api/v1/demo/work-configuration", replacement);
  assert.equal(configured.response.statusCode, 200);
  assert.equal(configured.payload.data.statuses.some((status) => status.id === "review"), true);
});

test("Dynamo project creation namespaces public IDs and atomically registers their partition", async () => {
  const commands = [];
  const documentClient = {
    async send(command) {
      commands.push(command);
      return {};
    }
  };
  const repository = new DynamoRepository({tableName: "demo-table", documentClient});
  repository.recordActivity = async () => {};
  const context = {
    actorId: publicDemoIdentity("a").id,
    workspaceId: publicDemoWorkspaceId("a"),
    correlationId: "demo-request",
    membership: {role: "workspace-admin"},
    publicDemo: {projectIdPrefix: publicDemoProjectIdPrefix("a")}
  };

  const project = await repository.createProject(context, {name: "Temporary project"});
  assert.equal(project.id.startsWith(publicDemoProjectIdPrefix("a")), true);
  assert.equal(commands.length, 1);
  assert.equal(commands[0] instanceof TransactWriteCommand, true);
  const puts = commands[0].input.TransactItems.map((operation) => operation.Put.Item);
  assert.equal(puts[0].PK, `PROJECT#${project.id}`);
  assert.deepEqual(puts[1], {
    PK: `WORKSPACE#${publicDemoWorkspaceId("a")}`,
    SK: `DEMO_PARTITION#PROJECT#${project.id}`,
    workspaceId: publicDemoWorkspaceId("a"),
    projectId: project.id,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  });
});

test("public demo permits the bounded content mutations advertised to visitors", async () => {
  const {handler, seed} = demoHarness();
  const project = seed.projects[0];
  const workItem = seed.workItems.find((item) => item.projectId === project.id && item.status === "intake");
  const meeting = seed.meetings.find((item) => item.projectId === project.id && item.status === "open");
  const document = seed.documents.find((item) => item.projectId === project.id);
  const mutations = [
    ["POST", "/api/v1/demo/portfolios", {name: "Visitor portfolio", description: "Temporary sample content"}, 201],
    ["PATCH", `/api/v1/demo/portfolios/${seed.portfolios[0].id}`, {version: 1, description: "Edited in the shared demo"}, 200],
    ["PATCH", `/api/v1/demo/projects/${project.id}`, {version: 1, health: "on-track"}, 200],
    ["POST", `/api/v1/demo/projects/${project.id}/work-items`, {title: "Visitor-created task", status: "intake", type: "task", effortPoints: 2}, 201],
    ["PATCH", `/api/v1/demo/projects/${project.id}/work-items/${workItem.id}`, {version: 1, status: "ready"}, 200],
    ["POST", "/api/v1/demo/meetings", {
      projectId: project.id,
      title: "Visitor planning session",
      startsAt: "2026-08-20T14:00:00.000Z",
      endsAt: "2026-08-20T14:30:00.000Z",
      participantIds: []
    }, 201],
    ["PATCH", `/api/v1/demo/meetings/${meeting.id}`, {projectId: project.id, version: 1, status: "in-progress"}, 200],
    ["POST", "/api/v1/demo/time-entries", {
      projectId: project.id,
      workItemId: workItem.id,
      entryDate: "2026-08-14",
      durationMinutes: 30,
      description: "Explored the public demo",
      billable: false
    }, 201],
    ["POST", "/api/v1/demo/activity", {
      projectId: project.id,
      entityType: "project",
      entityId: project.id,
      summary: "Visitor left a sample comment"
    }, 201],
    ["POST", "/api/v1/demo/saved-views", {
      name: "Visitor view",
      scope: "planning",
      filters: {projectId: project.id, layout: "board"}
    }, 201],
    ["PATCH", `/api/v1/demo/documents/${document.id}?projectId=${project.id}`, {
      version: 1,
      description: "Metadata edited in the shared demo"
    }, 200]
  ];

  for (const [method, path, body, expectedStatus] of mutations) {
    const result = await send(handler, method, path, body);
    assert.equal(result.response.statusCode, expectedStatus, `${method} ${path}: ${result.payload?.detail ?? "unexpected response"}`);
  }

  const documents = await send(handler, "GET", "/api/v1/demo/documents");
  const updatedDocument = documents.payload.data.items.find((item) => item.id === document.id);
  assert.ok(updatedDocument);
  assert.equal(updatedDocument.description, "Metadata edited in the shared demo");
  assert.equal(updatedDocument.sampleOnly, true);
  assert.equal(updatedDocument.samplePreview, document.samplePreview);
  assert.equal(updatedDocument.objectKey, undefined);
});

test("public demo default-denies account, identity, membership, upload, and unknown mutations", async () => {
  const {handler, seed} = demoHarness();
  const document = seed.documents[0];
  const denied = [
    ["POST", "/api/v1/demo/accounts"],
    ["PATCH", "/api/v1/demo/workspace"],
    ["PATCH", "/api/v1/demo/me/profile"],
    ["POST", "/api/v1/demo/memberships"],
    ["PATCH", `/api/v1/demo/memberships/${publicDemoIdentity("a").id}`],
    ["POST", "/api/v1/demo/documents/upload-intent"],
    ["POST", "/api/v1/demo/documents/finalize"],
    ["GET", `/api/v1/demo/documents/${document.id}/download?projectId=${document.projectId}`],
    ["POST", "/api/v1/demo/attachments/upload-intent"],
    ["GET", `/api/v1/demo/attachments/${document.id}/download?projectId=${document.projectId}`],
    ["POST", "/api/v1/demo/future-admin-operation"]
  ];
  for (const [method, path] of denied) {
    const result = await send(handler, method, path, {});
    assert.equal(result.response.statusCode, 403, `${method} ${path}`);
    assert.match(result.payload.detail, /not available in the shared demo/);
  }

  const wrongPrefix = await send(handler, "GET", "/api/v1/bootstrap");
  assert.equal(wrongPrefix.response.statusCode, 403);
});

test("public demo rejects ambiguous paths before allowlist evaluation and routing", async () => {
  const {handler} = demoHarness();
  const attempts = [
    "/api/v1/demo/projects/..\\workspace",
    "/api/v1/demo/projects/%2e%2e/workspace",
    "/api/v1/demo/projects/.%2e/workspace",
    "/api/v1/demo/projects/%2fworkspace",
    "/api/v1/demo/projects/%5cworkspace",
    "/api/v1/demo/projects//workspace"
  ];

  for (const path of attempts) {
    const result = await send(handler, "PATCH", path, {name: "Escaped demo", version: 1});
    assert.equal(result.response.statusCode, 403, path);
    assert.match(result.payload.detail, /not available in the shared demo/);
  }

  const workspace = await send(handler, "GET", "/api/v1/demo/workspace");
  assert.equal(workspace.response.statusCode, 200);
  assert.notEqual(workspace.payload.data.name, "Escaped demo");
});

test("public demo cannot address a project outside its active tenant", async () => {
  const {handler} = demoHarness();
  const result = await send(handler, "GET", "/api/v1/demo/projects/project-pilot");
  assert.equal(result.response.statusCode, 404);
  assert.equal(result.payload.title, "Not Found");
});

test("public demo enforces the shared daily mutation quota", async () => {
  const {handler, seed} = demoHarness({mutationLimit: 1});
  const first = await send(handler, "PATCH", `/api/v1/demo/projects/${seed.projects[0].id}`, {
    version: 1,
    health: "on-track"
  });
  assert.equal(first.response.statusCode, 200);
  const second = await send(handler, "PATCH", `/api/v1/demo/projects/${seed.projects[1].id}`, {
    version: 1,
    health: "watch"
  });
  assert.equal(second.response.statusCode, 429);
  assert.match(second.payload.detail, /daily edit limit/);
});

test("public demo rejects oversized mutation bodies before routing", async () => {
  const {handler} = demoHarness();
  const body = JSON.stringify({name: "x".repeat(publicDemoBodyLimitBytes + 1)});
  const result = await send(handler, "POST", "/api/v1/demo/projects", body);
  assert.equal(result.response.statusCode, 413);
  assert.match(result.payload.detail, /must not exceed/);
});

test("public demo bounds stored text and list pages below the anonymous response ceiling", async () => {
  const {handler} = demoHarness();
  const longText = await send(handler, "POST", "/api/v1/demo/projects", {
    name: "x".repeat(publicDemoStringLimit + 1)
  });
  assert.equal(longText.response.statusCode, 400);
  assert.match(longText.payload.detail, /text fields must not exceed/);

  for (const suppliedLimit of ["100", "", "not-a-number", "0"]) {
    const planning = await send(handler, "GET", `/api/v1/demo/planning?limit=${suppliedLimit}`);
    assert.equal(planning.response.statusCode, 200);
    assert.equal(planning.payload.data.items.length, publicDemoPageLimit);
    assert.equal(planning.payload.data.pageInfo.hasNextPage, true);
    assert.ok(Buffer.byteLength(planning.response.body, "utf8") <= publicDemoResponseLimitBytes);
  }
});

test("public demo caps legacy list-shaped routes in the repository as well as the response", async () => {
  const now = new Date("2026-08-14T12:00:00.000Z");
  const seed = createPublicDemoSeed("a", now);
  const visitor = publicDemoIdentity("a");
  const assignedTemplate = seed.workItems[0];
  const timeTemplate = seed.timeEntries[0];
  const viewTemplate = seed.savedViews[0];
  const activityTemplate = seed.activities[0];
  for (let index = 0; index < publicDemoPageLimit + 5; index += 1) {
    seed.workItems.push({...structuredClone(assignedTemplate), id: `extra-work-${index}`, assigneeId: visitor.id});
    seed.timeEntries.push({...structuredClone(timeTemplate), id: `extra-time-${index}`, userId: visitor.id});
    seed.savedViews.push({...structuredClone(viewTemplate), id: `extra-view-${index}`, userId: visitor.id});
    seed.activities.push({...structuredClone(activityTemplate), id: `extra-activity-${index}`});
  }
  const repository = new MemoryRepository(seed);
  const control = new MemoryPublicDemoControl({slot: "a", now});
  const handler = createPublicDemoHandler({repository, control});

  for (const path of [
    "/api/v1/demo/work-items/assigned",
    "/api/v1/demo/time-entries",
    "/api/v1/demo/activity",
    "/api/v1/demo/saved-views"
  ]) {
    const result = await send(handler, "GET", path);
    assert.equal(result.response.statusCode, 200, path);
    assert.equal(result.payload.data.items.length, publicDemoPageLimit, path);
    assert.equal(result.payload.data.pageInfo.truncated, true, path);
  }

  const requestedOne = await send(handler, "GET", "/api/v1/demo/activity?limit=1");
  assert.equal(requestedOne.response.statusCode, 200);
  assert.equal(requestedOne.payload.data.items.length, 1);
  assert.equal(requestedOne.payload.data.pageInfo.truncated, true);
});

test("public demo replaces unsafe correlation IDs instead of echoing or logging attacker-sized values", async () => {
  const {handler} = demoHarness();
  for (const supplied of ["x".repeat(4096), "line\nbreak", "spaces are not allowed"]) {
    const result = await send(handler, "GET", "/api/v1/demo/bootstrap", undefined, {
      "x-correlation-id": supplied
    });
    assert.equal(result.response.statusCode, 200);
    assert.match(result.response.headers["x-correlation-id"], /^[0-9a-f-]{36}$/);
    assert.equal(result.payload.correlationId, result.response.headers["x-correlation-id"]);
    assert.notEqual(result.payload.correlationId, supplied);
    assert.ok(result.payload.correlationId.length <= 128);
  }
});

test("public demo fails closed with a small response when repository output exceeds its transfer ceiling", async () => {
  const now = new Date("2026-08-14T12:00:00.000Z");
  const seed = createPublicDemoSeed("a", now);
  seed.projects[0].description = "x".repeat(publicDemoResponseLimitBytes);
  const repository = new MemoryRepository(seed);
  const control = new MemoryPublicDemoControl({slot: "a", now});
  const handler = createPublicDemoHandler({repository, control});

  const result = await send(handler, "GET", "/api/v1/demo/bootstrap");
  assert.equal(result.response.statusCode, 413);
  assert.match(result.payload.detail, /result is too large/);
  assert.ok(Buffer.byteLength(result.response.body, "utf8") < 1024);
});

test("public demo rejects oversized and body-bearing read requests", async () => {
  const {handler} = demoHarness();
  const oversized = await send(
    handler,
    "GET",
    "/api/v1/demo/bootstrap",
    JSON.stringify({padding: "x".repeat(publicDemoBodyLimitBytes + 1)})
  );
  assert.equal(oversized.response.statusCode, 413);

  const bodyBearing = await send(handler, "GET", "/api/v1/demo/bootstrap", {unexpected: true});
  assert.equal(bodyBearing.response.statusCode, 400);
  assert.match(bodyBearing.payload.detail, /must not include a body/);
});
