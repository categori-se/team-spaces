// @ts-check

import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {S3Client} from "@aws-sdk/client-s3";
import {getSignedUrl} from "@aws-sdk/s3-request-presigner";
import {defaultWorkspaceCapabilities, parseWorkQuery} from "@teamspaces/contracts";
import {createHandler} from "../src/handler.js";
import {assertUploadedDocument, createDocumentPutRequest, DynamoRepository} from "../src/repositories/dynamo.js";
import {MemoryRepository} from "../src/repositories/memory.js";
import {compareWorkItems, encodeWorkCursor, isAfterMemoryWorkCursor, memoryWorkCursorKey} from "../src/repositories/work-query.js";

process.env.ALLOW_DEMO_AUTH = "true";
process.env.APP_ORIGIN = "http://localhost:3000";

function makeEvent(method, path, body, headers = {}) {
  return {
    rawPath: path,
    headers: {
      origin: "http://localhost:3000",
      "x-demo-user-id": "user-demo-admin",
      "x-demo-user-email": "admin@team-spaces.example",
      ...headers
    },
    requestContext: {http: {method}},
    body: body === undefined ? undefined : JSON.stringify(body)
  };
}

async function send(handler, method, path, body, headers) {
  const response = await handler(makeEvent(method, path, body, headers));
  const payload = response.body ? JSON.parse(response.body) : undefined;
  return {response, payload};
}

test("keeps workspace and portfolio project indexes independent", () => {
  const repository = new DynamoRepository({tableName: "test", attachmentBucketName: "test"});
  const project = {
    PK: "PROJECT#project-one",
    SK: "META",
    id: "project-one",
    workspaceId: "workspace-one",
    portfolioId: "portfolio-one",
    status: "active",
    updatedAt: "2026-08-13T12:00:00.000Z"
  };
  assert.equal(repository.projectIndexAttrs(project).GSI1PK, "WORKSPACE#workspace-one#PROJECTS");
  assert.deepEqual(repository.projectPortfolioProjectionKey(project), {
    PK: "WORKSPACE#workspace-one",
    SK: "PROJECT_PORTFOLIO#portfolio-one#PROJECT#project-one"
  });
  assert.equal(
    repository.projectPortfolioProjection(project).GSI1PK,
    "WORKSPACE#workspace-one#PORTFOLIO#portfolio-one#PROJECTS"
  );
});

test("presigns exact, single-use, checksum-protected document uploads", async () => {
  const checksumSha256 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const {command, uploadHeaders} = createDocumentPutRequest({
    bucketName: "teamspaces-test-uploads",
    objectKey: "documents/workspace-one/project-one/document-one/object",
    documentId: "document-one",
    input: {sizeBytes: 12, contentType: "text/plain", checksumSha256}
  });
  const client = new S3Client({
    region: "us-east-1",
    credentials: {accessKeyId: "test-access-key", secretAccessKey: "test-secret-key"},
    requestChecksumCalculation: "WHEN_REQUIRED"
  });
  const signed = new URL(await getSignedUrl(client, command, {
    expiresIn: 600,
    signableHeaders: new Set(["content-type"])
  }));
  const signedHeaders = signed.searchParams.get("X-Amz-SignedHeaders")?.split(";") ?? [];
  for (const header of ["content-length", "content-type", "host", "if-none-match", "x-amz-server-side-encryption"]) {
    assert.equal(signedHeaders.includes(header), true, `${header} must be signed`);
  }
  assert.equal(signed.searchParams.has("x-amz-checksum-crc32"), false);
  assert.equal(signed.searchParams.get("x-amz-checksum-sha256"), checksumSha256);
  assert.equal(signed.searchParams.get("x-amz-tagging"), "state=pending");
  assert.deepEqual(uploadHeaders, {
    "content-type": "text/plain",
    "if-none-match": "*",
    "x-amz-server-side-encryption": "AES256"
  });
});

test("rejects uploaded objects that differ from their signed intent", () => {
  const document = {
    id: "document-one",
    sizeBytes: 12,
    contentType: "text/plain",
    checksumSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
  };
  const validHead = {
    ContentLength: 12,
    ContentType: "text/plain",
    ChecksumSHA256: document.checksumSha256,
    Metadata: {documentid: document.id},
    ServerSideEncryption: "AES256"
  };
  assert.doesNotThrow(() => assertUploadedDocument(document, validHead));
  assert.throws(() => assertUploadedDocument(document, {...validHead, ContentLength: 13}), /does not match/);
  assert.throws(() => assertUploadedDocument(document, {...validHead, ChecksumSHA256: "BBBB"}), /does not match/);
});

test("bootstrap returns workspace and summary data", async () => {
  const handler = createHandler({repository: new MemoryRepository()});
  const {response, payload} = await send(handler, "GET", "/api/v1/bootstrap");
  assert.equal(response.statusCode, 200);
  assert.equal(payload.data.workspace.id, "workspace-default");
  assert.equal(Object.hasOwn(payload.data, ["pro", "grams"].join("")), false);
  assert.equal(payload.data.summary.totalActiveProjects, 2);
  assert.equal(payload.data.summary.planning.currentPeriod.name, "Pilot Period 1");
  assert.equal(payload.data.workConfiguration.defaultTypeId, "task");
});

test("workspace administrators manage versioned task taxonomy and workflows", async () => {
  const repository = new MemoryRepository();
  const handler = createHandler({repository});
  const current = await send(handler, "GET", "/api/v1/work-configuration");
  assert.equal(current.response.statusCode, 200);
  assert.equal(current.payload.data.version, 1);
  const replacement = structuredClone(current.payload.data);
  replacement.types.push({id: "service-request", label: "Service request", active: true});
  replacement.statuses.push({id: "triage-review", label: "Triage review", active: true, closed: false});
  replacement.transitions.push({
    fromStatusId: replacement.defaultStatusId,
    toStatusId: "triage-review",
    roles: ["workspace-admin"]
  });
  const saved = await send(handler, "PATCH", "/api/v1/work-configuration", replacement);
  assert.equal(saved.response.statusCode, 200);
  assert.equal(saved.payload.data.version, 2);
  assert.equal(saved.payload.data.types.some((type) => type.id === "service-request"), true);
  const bootstrap = await send(handler, "GET", "/api/v1/bootstrap");
  assert.equal(bootstrap.payload.data.workConfiguration.version, 2);

  const denied = await send(handler, "PATCH", "/api/v1/work-configuration", saved.payload.data, {
    "x-demo-user-id": "user-product-engineer",
    "x-demo-user-email": "engineer@team-spaces.example",
    "x-demo-user-name": "Jordan Lee"
  });
  assert.equal(denied.response.statusCode, 403);
});

test("project-scoped activity rejects restricted members outside their projects", async () => {
  const repository = new MemoryRepository();
  const membership = repository.memberships.get("workspace-default:user-product-engineer");
  assert.ok(membership);
  membership.projectIds = ["project-workspace-ux"];
  const handler = createHandler({repository});
  const headers = {
    "x-demo-user-id": "user-product-engineer",
    "x-demo-user-email": "engineer@team-spaces.example",
    "x-demo-user-name": "Jordan Lee"
  };
  const listed = await send(handler, "GET", "/api/v1/activity?projectId=project-pilot", undefined, headers);
  assert.equal(listed.response.statusCode, 404);
  const written = await send(handler, "POST", "/api/v1/activity", {
    projectId: "project-pilot",
    summary: "Should not be accepted"
  }, headers);
  assert.equal(written.response.statusCode, 404);
});

test("groups actionable notifications and persists per-user read state", async () => {
  const repository = new MemoryRepository();
  const handler = createHandler({repository});
  const memberHeaders = {
    "x-demo-user-id": "user-product-engineer",
    "x-demo-user-email": "engineer@team-spaces.example",
    "x-demo-user-name": "Jordan Lee"
  };
  const work = (await send(handler, "GET", "/api/v1/projects/project-pilot/work-items")).payload.data.items.find((item) => item.id === "work-cognito");
  assert.ok(work);
  await send(handler, "PATCH", "/api/v1/projects/project-pilot/work-items/work-cognito", {version: work.version, description: "Notification recipient snapshot test"});
  const comment = await send(handler, "POST", "/api/v1/activity", {
    projectId: "project-pilot",
    entityType: "work-item",
    entityId: "work-cognito",
    summary: "Jordan, please review this change",
    mentions: ["user-product-engineer"]
  });
  const internal = await send(handler, "POST", "/api/v1/activity", {
    projectId: "project-pilot",
    entityType: "work-item",
    entityId: "work-cognito",
    summary: "Manager-only note",
    mentions: ["user-product-engineer"],
    visibility: "internal"
  });

  const listed = await send(handler, "GET", "/api/v1/notifications", undefined, memberHeaders);
  assert.equal(listed.response.statusCode, 200);
  assert.equal(listed.payload.data.summary.unreadCount, 2);
  assert.equal(listed.payload.data.groups.length, 1);
  assert.equal(listed.payload.data.groups[0].totalCount, 2);
  assert.equal(listed.payload.data.groups[0].reasons.includes("watching"), true);
  assert.equal(listed.payload.data.groups[0].reasons.includes("mention"), true);
  assert.equal(listed.payload.data.items.some((item) => item.id === internal.payload.data.id), false);

  const marked = await send(handler, "POST", "/api/v1/notifications/read", {ids: [comment.payload.data.id]}, memberHeaders);
  assert.equal(marked.payload.data.read, true);
  const unread = await send(handler, "GET", "/api/v1/notifications?filter=unread", undefined, memberHeaders);
  assert.equal(unread.payload.data.items.length, 1);
  assert.equal(unread.payload.data.summary.readCount, 1);
  const read = await send(handler, "GET", "/api/v1/notifications?filter=read", undefined, memberHeaders);
  assert.equal(read.payload.data.items.length, 1);
  assert.equal(read.payload.data.items[0].id, comment.payload.data.id);
  await send(handler, "POST", "/api/v1/notifications/read-all", {}, memberHeaders);
  const caughtUp = await send(handler, "GET", "/api/v1/notifications?filter=unread", undefined, memberHeaders);
  assert.equal(caughtUp.payload.data.items.length, 0);
  assert.equal(caughtUp.payload.data.summary.unreadCount, 0);
  const restored = await send(handler, "POST", "/api/v1/notifications/read", {ids: [comment.payload.data.id], read: false}, memberHeaders);
  assert.equal(restored.payload.data.read, false);
});

test("obsolete hierarchy routes are not part of the project model", async () => {
  const handler = createHandler({repository: new MemoryRepository()});
  const {response} = await send(handler, "GET", `/api/v1/${["pro", "grams"].join("")}`);
  assert.equal(response.statusCode, 404);
});

test("planning dashboard returns work items and summary", async () => {
  const handler = createHandler({repository: new MemoryRepository()});
  const {response, payload} = await send(handler, "GET", "/api/v1/planning");
  assert.equal(response.statusCode, 200);
  assert.equal(payload.data.items.some((item) => item.type === "feature"), true);
  assert.equal(payload.data.items.some((item) => item.projectName), true);
  assert.equal(payload.data.summary.currentPeriod.name, "Pilot Period 1");
  assert.equal(payload.data.summary.byIntakeGroup.bugs, 1);
  assert.equal(payload.data.summary.relationshipCount >= 1, true);
  assert.equal(payload.data.summary.acceptanceCriteriaCount >= 1, true);
});

test("planning returns a real cursor page", async () => {
  const handler = createHandler({repository: new MemoryRepository()});
  const query = new URLSearchParams({projectId: "project-pilot", sort: "id-asc", limit: "1"});
  const first = await send(handler, "GET", `/api/v1/planning?${query}`);
  assert.equal(first.response.statusCode, 200);
  assert.equal(first.payload.data.items.length, 1);
  assert.equal(first.payload.data.pageInfo.hasNextPage, true);
  assert.equal(first.payload.data.summaryScope, "page");
  let previousId = first.payload.data.items[0].id;
  let current = first;
  for (let page = 0; current.payload.data.pageInfo.hasNextPage; page += 1) {
    assert.ok(page < 20, "fixture pagination must terminate");
    query.set("cursor", current.payload.data.pageInfo.endCursor);
    current = await send(handler, "GET", `/api/v1/planning?${query}`);
    assert.equal(current.response.statusCode, 200);
    assert.notEqual(current.payload.data.items[0].id, previousId);
    assert.equal(current.payload.data.summaryScope, "page");
    previousId = current.payload.data.items[0].id;
  }
  assert.equal(current.payload.data.pageInfo.hasNextPage, false);
});

test("rejects a cursor missing the updated-order project tie breaker", async () => {
  const repository = new MemoryRepository();
  const query = {...parseWorkQuery({limit: "1"}), workspaceId: repository.workspace.id};
  const cursor = encodeWorkCursor({
    source: "workspace",
    workspaceId: query.workspaceId,
    query,
    key: {id: "work-cognito", value: "2026-08-13T12:00:00.000Z"}
  });
  await assert.rejects(repository.listWorkItemsPage({...query, cursor}), /Cursor key is invalid/);
});

test("memory updated ordering mirrors the descending Dynamo index suffix", () => {
  const newerProject = {id: "work-z", projectId: "project-z", updatedAt: "2026-08-13T12:00:00.000Z"};
  const olderProject = {id: "work-a", projectId: "project-a", updatedAt: "2026-08-13T12:00:00.000Z"};
  assert.equal(compareWorkItems(newerProject, olderProject, "updated-desc") < 0, true);
  const cursor = memoryWorkCursorKey(newerProject, "updated-desc");
  assert.equal(isAfterMemoryWorkCursor(olderProject, cursor, "updated-desc"), true);
});

test("classifies invalid Work Query input as a bad request", async () => {
  const handler = createHandler({repository: new MemoryRepository()});
  const invalid = await send(handler, "GET", "/api/v1/planning?status=not-a-status");
  assert.equal(invalid.response.statusCode, 400);
  assert.equal(invalid.payload.title, "Bad Request");
  assert.match(invalid.payload.detail, /Expected one of/);
});

test("sanitizes unexpected repository failures", async () => {
  const repository = new MemoryRepository();
  repository.listPlanningWorkItemsPage = async () => {
    throw new Error("sensitive DynamoDB implementation detail");
  };
  const handler = createHandler({repository});
  const failed = await send(handler, "GET", "/api/v1/planning");
  assert.equal(failed.response.statusCode, 500);
  assert.equal(failed.payload.title, "Internal Server Error");
  assert.equal(failed.payload.detail, "An unexpected error occurred");
  assert.doesNotMatch(failed.response.body, /sensitive DynamoDB/);
});

test("stages and rotates the configured CloudFront origin header", {concurrency: false}, async () => {
  const previous = {
    secret: process.env.ORIGIN_VERIFY_SECRET,
    next: process.env.ORIGIN_VERIFY_SECRET_NEXT,
    enforced: process.env.ORIGIN_VERIFY_ENFORCED
  };
  process.env.ORIGIN_VERIFY_SECRET = "test-origin-secret";
  process.env.ORIGIN_VERIFY_SECRET_NEXT = "test-next-origin-secret";
  try {
    const handler = createHandler({repository: new MemoryRepository()});
    process.env.ORIGIN_VERIFY_ENFORCED = "false";
    const observationPhase = await send(handler, "GET", "/api/v1/bootstrap");
    assert.equal(observationPhase.response.statusCode, 200);

    process.env.ORIGIN_VERIFY_ENFORCED = "true";
    const direct = await send(handler, "GET", "/api/v1/bootstrap");
    assert.equal(direct.response.statusCode, 403);
    const viaPrimary = await send(handler, "GET", "/api/v1/bootstrap", undefined, {
      "x-teamspaces-origin-secret": "test-origin-secret"
    });
    assert.equal(viaPrimary.response.statusCode, 200);
    const viaNext = await send(handler, "GET", "/api/v1/bootstrap", undefined, {
      "x-teamspaces-origin-secret": "test-next-origin-secret"
    });
    assert.equal(viaNext.response.statusCode, 200);
    const wrong = await send(handler, "GET", "/api/v1/bootstrap", undefined, {
      "x-teamspaces-origin-secret": "wrong-origin-secret"
    });
    assert.equal(wrong.response.statusCode, 403);
  } finally {
    for (const [name, value] of [
      ["ORIGIN_VERIFY_SECRET", previous.secret],
      ["ORIGIN_VERIFY_SECRET_NEXT", previous.next],
      ["ORIGIN_VERIFY_ENFORCED", previous.enforced]
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("reflects loopback CORS only in local demo mode", {concurrency: false}, async () => {
  const previous = process.env.ALLOW_DEMO_AUTH;
  const handler = createHandler({repository: new MemoryRepository()});
  try {
    process.env.ALLOW_DEMO_AUTH = "true";
    const local = await send(handler, "GET", "/api/v1/health", undefined, {origin: "http://127.0.0.1:4190"});
    assert.equal(local.response.headers["access-control-allow-origin"], "http://127.0.0.1:4190");
    delete process.env.ALLOW_DEMO_AUTH;
    const production = await send(handler, "GET", "/api/v1/health", undefined, {origin: "http://127.0.0.1:4190"});
    assert.equal(production.response.headers["access-control-allow-origin"], process.env.APP_ORIGIN);
  } finally {
    if (previous === undefined) delete process.env.ALLOW_DEMO_AUTH;
    else process.env.ALLOW_DEMO_AUTH = previous;
  }
});

test("public health rejects request bodies before routing", async () => {
  const handler = createHandler({repository: new MemoryRepository()});
  const result = await send(handler, "GET", "/api/v1/health", {unexpected: true});
  assert.equal(result.response.statusCode, 400);
  assert.match(result.payload.detail, /must not include a body/);
});

test("creates and updates linked work item details with neutral planning aliases", async () => {
  const repository = new MemoryRepository();
  const handler = createHandler({repository});
  const created = await send(handler, "POST", "/api/v1/projects/project-pilot/work-items", {
    title: "Document acceptance workflow",
    description: "Confirm documents move cleanly through upload, review, and archive states.",
    type: "feature",
    status: "ready",
    priority: "high",
    parentId: "work-dns",
    blockedBy: ["work-cognito"],
    relatedIds: ["work-s3-attachments"],
    watcherIds: ["user-delivery-lead"],
    acceptanceCriteria: "A reviewer can see status, linked work, and current document metadata.",
    customFields: {component: "Documents"},
    effortPoints: 3,
    periodName: "Pilot Period 1",
    periodGoal: "Validate document collaboration",
    intakeGroup: "ready",
    milestoneName: "Pilot beta"
  });
  assert.equal(created.response.statusCode, 201);
  assert.equal(created.payload.data.blockedBy[0], "work-cognito");
  assert.equal(created.payload.data.customFields.component, "Documents");
  assert.equal(created.payload.data.effortPoints, 3);
  assert.equal(created.payload.data.periodName, "Pilot Period 1");
  assert.equal(created.payload.data.milestoneName, "Pilot beta");
  const patched = await send(handler, "PATCH", `/api/v1/projects/project-pilot/work-items/${created.payload.data.id}`, {
    version: created.payload.data.version,
    status: "in-progress",
    acceptanceCriteria: "Reviewed documents remain linked to their work item.",
    periodName: "Review Period",
    milestoneName: "Evidence review"
  });
  assert.equal(patched.response.statusCode, 200);
  assert.equal(patched.payload.data.status, "in-progress");
  assert.equal(patched.payload.data.periodName, "Review Period");
  assert.equal(patched.payload.data.milestoneName, "Evidence review");
  assert.match(patched.payload.data.acceptanceCriteria, /Reviewed documents/);
});

test("filters and cursor-pages project work with Work Query v1", async () => {
  const handler = createHandler({repository: new MemoryRepository()});
  const created = [];
  for (const title of ["Cursor suite alpha", "Cursor suite beta", "Cursor suite gamma"]) {
    const result = await send(handler, "POST", "/api/v1/projects/project-pilot/work-items", {
      title,
      type: "bug",
      status: "ready",
      assigneeId: "user-delivery-lead",
      dueDate: "2026-08-20",
      milestoneName: "Cursor milestone",
      periodId: "cursor-period"
    });
    created.push(result.payload.data.id);
  }

  const query = new URLSearchParams({
    type: "bug",
    status: "ready",
    assigneeId: "user-delivery-lead",
    dueFrom: "2026-08-01",
    dueTo: "2026-08-31",
    milestoneName: "Cursor milestone",
    periodId: "cursor-period",
    search: "cursor suite",
    limit: "2"
  });
  const first = await send(handler, "GET", `/api/v1/projects/project-pilot/work-items?${query}`);
  assert.equal(first.response.statusCode, 200);
  assert.equal(first.payload.data.items.length, 2);
  assert.equal(first.payload.data.pageInfo.hasNextPage, true);
  assert.ok(first.payload.data.pageInfo.endCursor);

  query.set("cursor", first.payload.data.pageInfo.endCursor);
  const second = await send(handler, "GET", `/api/v1/projects/project-pilot/work-items?${query}`);
  assert.equal(second.response.statusCode, 200);
  assert.equal(second.payload.data.items.length, 1);
  assert.equal(second.payload.data.pageInfo.hasNextPage, false);
  const pagedIds = [...first.payload.data.items, ...second.payload.data.items].map((item) => item.id);
  assert.deepEqual([...pagedIds].sort(), [...created].sort());

  query.set("status", "blocked");
  const mismatchedCursor = await send(handler, "GET", `/api/v1/projects/project-pilot/work-items?${query}`);
  assert.equal(mismatchedCursor.response.statusCode, 400);
});

test("uses project-scoped work updates and rejects stale versions", async () => {
  const handler = createHandler({repository: new MemoryRepository()});
  const created = await send(handler, "POST", "/api/v1/projects/project-pilot/work-items", {
    title: "Scoped update",
    status: "ready"
  });
  const id = created.payload.data.id;
  const first = await send(handler, "PATCH", `/api/v1/projects/project-pilot/work-items/${id}`, {
    version: created.payload.data.version,
    status: "in-progress"
  });
  assert.equal(first.response.statusCode, 200);
  assert.equal(first.payload.data.status, "in-progress");

  const stale = await send(handler, "PATCH", `/api/v1/projects/project-pilot/work-items/${id}`, {
    version: created.payload.data.version,
    status: "done"
  });
  assert.equal(stale.response.statusCode, 409);
  const wrongProject = await send(handler, "PATCH", `/api/v1/projects/project-workspace-ux/work-items/${id}`, {
    version: first.payload.data.version,
    status: "done"
  });
  assert.equal(wrongProject.response.statusCode, 404);
  const legacyRoute = await send(handler, "PATCH", `/api/v1/work-items/${id}`, {
    version: first.payload.data.version,
    status: "done"
  });
  assert.equal(legacyRoute.response.statusCode, 404);
});

test("manages workspace membership data", async () => {
  const repository = new MemoryRepository();
  const handler = createHandler({repository});
  const profile = await send(handler, "PATCH", "/api/v1/me/profile", {
    name: "Demo Admin Updated",
    title: "Workspace Owner",
    timezone: "America/New_York",
    locale: "en-US"
  });
  assert.equal(profile.response.statusCode, 200);
  assert.equal(profile.payload.data.user.title, "Workspace Owner");
  const workspace = await send(handler, "PATCH", "/api/v1/workspace", {
    name: "Team Spaces Pilot Updated",
    defaultProjectPrefix: "TS",
    dataRetentionDays: 365
  });
  assert.equal(workspace.response.statusCode, 200);
  assert.equal(workspace.payload.data.defaultProjectPrefix, "TS");
  const member = await send(handler, "POST", "/api/v1/memberships", {
    email: "new.member@team-spaces.example",
    name: "New Member",
    role: "member",
    status: "active"
  });
  assert.equal(member.response.statusCode, 201);
  const memberships = await send(handler, "GET", "/api/v1/memberships");
  assert.equal(memberships.payload.data.items.some((item) => item.email === "new.member@team-spaces.example"), true);
  const dataSummary = await send(handler, "GET", "/api/v1/application-data/summary");
  assert.equal(dataSummary.response.statusCode, 200);
  assert.equal(dataSummary.payload.data.records.memberships >= 5, true);
  assert.equal(dataSummary.payload.data.records.meetings, 0);
  assert.equal(dataSummary.payload.data.records.activities >= 3, true);
});

test("creates accounts and enforces project-scoped member access", async () => {
  const repository = new MemoryRepository();
  const handler = createHandler({repository});
  const accounts = await send(handler, "GET", "/api/v1/accounts");
  assert.equal(accounts.response.statusCode, 200);
  assert.equal(accounts.payload.data.items.some((item) => item.workspaceId === "workspace-default"), true);

  const createdAccount = await send(handler, "POST", "/api/v1/accounts", {
    name: "Acme Client Portfolio",
    accountType: "client",
    defaultProjectPrefix: "AC"
  });
  assert.equal(createdAccount.response.statusCode, 201);
  const accountId = createdAccount.payload.data.id;
  const emptyProjects = await send(handler, "GET", "/api/v1/projects", undefined, {"x-teamspaces-account-id": accountId});
  assert.equal(emptyProjects.response.statusCode, 200);
  assert.equal(emptyProjects.payload.data.items.length, 0);

  const clientProject = await send(handler, "POST", "/api/v1/projects", {name: "Client onboarding"}, {"x-teamspaces-account-id": accountId});
  assert.equal(clientProject.response.statusCode, 201);
  assert.equal(clientProject.payload.data.workspaceId, accountId);
  const clientProjects = await send(handler, "GET", "/api/v1/projects", undefined, {"x-teamspaces-account-id": accountId});
  assert.equal(clientProjects.payload.data.items.some((item) => item.name === "Client onboarding"), true);

  const member = await send(handler, "POST", "/api/v1/memberships", {
    email: "restricted.member@team-spaces.example",
    name: "Restricted Member",
    role: "member",
    status: "active",
    projectIds: ["project-pilot"]
  });
  assert.equal(member.response.statusCode, 201);
  const restrictedHeaders = {
    "x-demo-user-id": member.payload.data.userId,
    "x-demo-user-email": "restricted.member@team-spaces.example",
    "x-demo-user-name": "Restricted Member",
    "x-teamspaces-account-id": "workspace-default"
  };
  const restrictedProjects = await send(handler, "GET", "/api/v1/projects", undefined, restrictedHeaders);
  assert.equal(restrictedProjects.response.statusCode, 200);
  assert.equal(restrictedProjects.payload.data.items.some((item) => item.id === "project-pilot"), true);
  assert.equal(restrictedProjects.payload.data.items.some((item) => item.id === "project-workspace-ux"), false);
  const blockedProject = await send(handler, "GET", "/api/v1/projects/project-workspace-ux", undefined, restrictedHeaders);
  assert.equal(blockedProject.response.statusCode, 404);
  const allowedWork = await send(handler, "GET", "/api/v1/projects/project-pilot/work-items", undefined, restrictedHeaders);
  assert.equal(allowedWork.response.statusCode, 200);
  const blockedWork = await send(handler, "GET", "/api/v1/projects/project-workspace-ux/work-items", undefined, restrictedHeaders);
  assert.equal(blockedWork.response.statusCode, 404);
});

test("creates and finalizes document records", async () => {
  const repository = new MemoryRepository();
  const handler = createHandler({repository});
  const intent = await send(handler, "POST", "/api/v1/documents/upload-intent", {
    projectId: "project-pilot",
    workItemId: "work-s3-attachments",
    name: "Pilot brief",
    filename: "pilot-brief.txt",
    contentType: "text/plain",
    sizeBytes: 12,
    checksumSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    category: "brief",
    description: "Pilot document"
  });
  assert.equal(intent.response.statusCode, 201);
  assert.equal(intent.payload.data.document.status, "pending");
  assert.equal(intent.payload.data.uploadHeaders["if-none-match"], "*");
  assert.equal(typeof intent.payload.data.document.expiresAt, "number");
  assert.equal(intent.payload.data.document.workItemId, "work-s3-attachments");
  const bypass = await send(handler, "PATCH", `/api/v1/documents/${intent.payload.data.documentId}?projectId=project-pilot`, {
    status: "ready",
    version: intent.payload.data.document.version
  });
  assert.equal(bypass.response.statusCode, 400);
  const unscopedDownload = await send(handler, "GET", `/api/v1/documents/${intent.payload.data.documentId}/download`);
  assert.equal(unscopedDownload.response.statusCode, 400);
  const pendingDownload = await send(handler, "GET", `/api/v1/documents/${intent.payload.data.documentId}/download?projectId=project-pilot`);
  assert.equal(pendingDownload.response.statusCode, 409);
  const finalized = await send(handler, "POST", "/api/v1/documents/finalize", {
    documentId: intent.payload.data.documentId,
    projectId: "project-pilot"
  });
  assert.equal(finalized.response.statusCode, 201);
  assert.equal(finalized.payload.data.status, "ready");
  assert.equal(Object.hasOwn(finalized.payload.data, "expiresAt"), false);
  const repeatedFinalize = await send(handler, "POST", "/api/v1/documents/finalize", {
    documentId: intent.payload.data.documentId,
    projectId: "project-pilot"
  });
  assert.equal(repeatedFinalize.response.statusCode, 201);
  assert.equal(repeatedFinalize.payload.data.version, finalized.payload.data.version);
  const archived = await send(handler, "PATCH", `/api/v1/documents/${intent.payload.data.documentId}?projectId=project-pilot`, {
    status: "archived",
    workItemId: "work-cognito",
    version: finalized.payload.data.version
  });
  assert.equal(archived.response.statusCode, 200);
  assert.equal(archived.payload.data.status, "archived");
  assert.equal(archived.payload.data.workItemId, "work-cognito");
  const documents = await send(handler, "GET", "/api/v1/documents?projectId=project-pilot");
  assert.equal(documents.payload.data.items.some((item) => item.name === "Pilot brief"), true);
  assert.equal(documents.payload.data.items.some((item) => item.workItemName), true);
  const taskDocuments = await send(handler, "GET", "/api/v1/documents?workItemId=work-cognito");
  assert.equal(taskDocuments.payload.data.items.some((item) => item.id === intent.payload.data.documentId), true);
  const download = await send(handler, "GET", `/api/v1/documents/${intent.payload.data.documentId}/download?projectId=project-pilot`);
  assert.equal(download.response.statusCode, 200);
  assert.equal(download.payload.data.document.id, intent.payload.data.documentId);
});

test("creates portfolio and project and records activity", async () => {
  const repository = new MemoryRepository();
  const handler = createHandler({repository});
  const portfolio = await send(handler, "POST", "/api/v1/portfolios", {name: "Delivery"});
  assert.equal(portfolio.response.statusCode, 201);
  const project = await send(handler, "POST", "/api/v1/projects", {
    name: "Integration Pilot",
    portfolioId: portfolio.payload.data.id,
    health: "on-track",
    priority: "high",
    startDate: "2026-07-10",
    targetDate: "2026-08-10"
  });
  assert.equal(project.response.statusCode, 201);
  const list = await send(handler, "GET", "/api/v1/projects");
  assert.equal(list.payload.data.items.some((item) => item.name === "Integration Pilot"), true);
  const activity = await send(handler, "GET", `/api/v1/activity?projectId=${project.payload.data.id}`);
  assert.equal(activity.payload.data.items.some((item) => item.eventType === "project.created"), true);
});

test("updates project management fields and records collaboration notes", async () => {
  const repository = new MemoryRepository();
  const handler = createHandler({repository});
  const project = await send(handler, "GET", "/api/v1/projects/project-pilot");
  const patched = await send(handler, "PATCH", "/api/v1/projects/project-pilot", {
    version: project.payload.data.version,
    name: "Pilot Readiness Updated",
    ownerId: "user-delivery-lead",
    health: "on-track",
    phase: "Execution",
    percentComplete: 55,
    tags: "pilot, launch"
  });
  assert.equal(patched.response.statusCode, 200);
  assert.equal(patched.payload.data.name, "Pilot Readiness Updated");
  assert.deepEqual(patched.payload.data.tags, ["pilot", "launch"]);
  const note = await send(handler, "POST", "/api/v1/activity", {
    projectId: "project-pilot",
    entityType: "work-item",
    entityId: "work-cognito",
    summary: "Reviewed handoff with the delivery lead.",
    mentions: ["user-delivery-lead"],
    reactions: ["✅"],
    format: "markdown",
    reminderAt: "2026-08-30T14:00:00Z"
  });
  assert.equal(note.response.statusCode, 201);
  assert.deepEqual(note.payload.data.mentions, ["user-delivery-lead"]);
  const reply = await send(handler, "POST", "/api/v1/activity", {
    projectId: "project-pilot",
    entityType: "work-item",
    entityId: "work-cognito",
    parentId: note.payload.data.id,
    summary: "The handoff is complete."
  });
  assert.equal(reply.payload.data.eventType, "comment.replied");
  const activity = await send(handler, "GET", "/api/v1/activity?projectId=project-pilot");
  assert.equal(activity.payload.data.items.some((item) => item.eventType === "comment.created" && item.entityId === "work-cognito"), true);
  const taskActivity = await send(handler, "GET", "/api/v1/activity?projectId=project-pilot&entityType=work-item&entityId=work-cognito");
  assert.equal(taskActivity.payload.data.items.every((item) => item.entityType === "work-item" && item.entityId === "work-cognito"), true);
});

test("stale project update returns conflict", async () => {
  const handler = createHandler({repository: new MemoryRepository()});
  const created = await send(handler, "POST", "/api/v1/projects", {name: "Conflict Test"});
  const id = created.payload.data.id;
  const first = await send(handler, "PATCH", `/api/v1/projects/${id}`, {version: 1, percentComplete: 10});
  assert.equal(first.response.statusCode, 200);
  const stale = await send(handler, "PATCH", `/api/v1/projects/${id}`, {version: 1, percentComplete: 20});
  assert.equal(stale.response.statusCode, 409);
});

test("manages project hierarchy, modules, templates, copies, favorites, and lifecycle", async () => {
  const handler = createHandler({repository: new MemoryRepository()});
  const parent = await send(handler, "POST", "/api/v1/projects", {
    name: "Reusable delivery setup",
    modules: ["work", "meetings", "documents", "wiki"],
    template: true
  });
  assert.equal(parent.response.statusCode, 201);
  const child = await send(handler, "POST", "/api/v1/projects", {
    name: "Child project",
    parentProjectId: parent.payload.data.id,
    modules: ["work", "time"]
  });
  assert.equal(child.response.statusCode, 201);
  assert.equal(child.payload.data.parentProjectId, parent.payload.data.id);

  const favorite = await send(handler, "PATCH", `/api/v1/projects/${child.payload.data.id}`, {
    version: child.payload.data.version,
    favorite: true
  });
  assert.equal(favorite.payload.data.favorite, true);
  const favorites = await send(handler, "GET", "/api/v1/projects?favorite=true");
  assert.equal(favorites.payload.data.items.some((item) => item.id === child.payload.data.id), true);

  const copied = await send(handler, "POST", `/api/v1/projects/${child.payload.data.id}/copy`, {
    name: "Child project copy",
    includeTasks: false
  });
  assert.equal(copied.response.statusCode, 201);
  assert.equal(copied.payload.data.name, "Child project copy");
  assert.equal(copied.payload.data.parentProjectId, parent.payload.data.id);

  const archived = await send(handler, "POST", `/api/v1/projects/${copied.payload.data.id}/archive`, {version: copied.payload.data.version});
  assert.equal(archived.payload.data.archived, true);
  assert.equal(archived.payload.data.status, "archived");
  const restored = await send(handler, "POST", `/api/v1/projects/${copied.payload.data.id}/restore`, {version: archived.payload.data.version});
  assert.equal(restored.payload.data.archived, false);
  const removed = await send(handler, "DELETE", `/api/v1/projects/${copied.payload.data.id}`, {version: restored.payload.data.version});
  assert.equal(removed.payload.data.deleted, true);
  const missing = await send(handler, "GET", `/api/v1/projects/${copied.payload.data.id}`);
  assert.equal(missing.response.statusCode, 404);

  const cycle = await send(handler, "PATCH", `/api/v1/projects/${parent.payload.data.id}`, {
    version: parent.payload.data.version,
    parentProjectId: child.payload.data.id
  });
  assert.equal(cycle.response.statusCode, 400);
  assert.match(cycle.payload.detail, /cycle/);
});

test("supports richer task progress, typed relations, duplicate, move, and delete", async () => {
  const handler = createHandler({repository: new MemoryRepository()});
  const created = await send(handler, "POST", "/api/v1/projects/project-pilot/work-items", {
    title: "Parity workflow",
    accountableId: "user-delivery-lead",
    category: "Release",
    versionName: "Pilot 1.0",
    estimateMinutes: 480,
    remainingMinutes: 360,
    percentComplete: 25,
    schedulingMode: "automatic",
    relations: [{type: "predecessor", targetId: "work-cognito", lagDays: 1}]
  });
  assert.equal(created.response.statusCode, 201);
  assert.equal(created.payload.data.percentComplete, 25);
  assert.equal(created.payload.data.relations[0].type, "predecessor");

  const selfRelation = await send(handler, "PATCH", `/api/v1/projects/project-pilot/work-items/${created.payload.data.id}`, {
    version: created.payload.data.version,
    relations: [{type: "related", targetId: created.payload.data.id}]
  });
  assert.equal(selfRelation.response.statusCode, 400);

  const copied = await send(handler, "POST", `/api/v1/projects/project-pilot/work-items/${created.payload.data.id}/copy`, {
    title: "Parity workflow copy"
  });
  assert.equal(copied.response.statusCode, 201);
  assert.equal(copied.payload.data.title, "Parity workflow copy");
  assert.equal(copied.payload.data.recordedMinutes, 0);

  const moved = await send(handler, "POST", `/api/v1/projects/project-pilot/work-items/${copied.payload.data.id}/move`, {
    version: copied.payload.data.version,
    targetProjectId: "project-workspace-ux"
  });
  assert.equal(moved.response.statusCode, 200);
  assert.equal(moved.payload.data.projectId, "project-workspace-ux");
  assert.deepEqual(moved.payload.data.relations, []);

  const removed = await send(handler, "DELETE", `/api/v1/projects/project-workspace-ux/work-items/${moved.payload.data.id}`, {
    version: moved.payload.data.version
  });
  assert.equal(removed.response.statusCode, 200);
  assert.equal(removed.payload.data.deleted, true);
  const targetItems = await send(handler, "GET", "/api/v1/projects/project-workspace-ux/work-items");
  assert.equal(targetItems.payload.data.items.some((item) => item.id === moved.payload.data.id), false);
});

test("edits time history and persists a cross-device timer", async () => {
  const handler = createHandler({repository: new MemoryRepository()});
  const created = await send(handler, "POST", "/api/v1/time-entries", {
    projectId: "project-pilot",
    workItemId: "work-cognito",
    entryDate: "2026-08-20",
    durationMinutes: 30,
    description: "Initial work",
    billable: false
  });
  assert.equal(created.response.statusCode, 201);
  const edited = await send(handler, "PATCH", `/api/v1/time-entries/${created.payload.data.id}`, {
    version: created.payload.data.version,
    originalEntryDate: created.payload.data.entryDate,
    entryDate: "2026-08-21",
    durationMinutes: 75,
    description: "Reviewed implementation",
    billable: true
  });
  assert.equal(edited.response.statusCode, 200);
  assert.equal(edited.payload.data.durationMinutes, 75);
  assert.equal(edited.payload.data.billable, true);

  const started = await send(handler, "POST", "/api/v1/timer/start", {
    projectId: "project-pilot",
    description: "Timed review"
  });
  assert.equal(started.response.statusCode, 201);
  assert.equal(started.payload.data.active, true);
  const active = await send(handler, "GET", "/api/v1/timer");
  assert.equal(active.payload.data.active, true);
  const stopped = await send(handler, "POST", "/api/v1/timer/stop", {});
  assert.equal(stopped.response.statusCode, 200);
  assert.equal(stopped.payload.data.timer.active, false);
  assert.equal(stopped.payload.data.entry.durationMinutes, 1);

  const removed = await send(handler, "DELETE", `/api/v1/time-entries/${edited.payload.data.id}`, {
    version: edited.payload.data.version,
    originalEntryDate: edited.payload.data.entryDate
  });
  assert.equal(removed.payload.data.deleted, true);
  const entries = await send(handler, "GET", "/api/v1/time-entries?projectId=project-pilot");
  assert.equal(entries.payload.data.items.some((entry) => entry.id === edited.payload.data.id), false);
  assert.equal(entries.payload.data.items.some((entry) => entry.description === "Timed review"), true);
});

test("publishes hierarchical project content with immutable revisions and search", async () => {
  const handler = createHandler({repository: new MemoryRepository()});
  const parent = await send(handler, "POST", "/api/v1/project-content", {
    projectId: "project-pilot",
    kind: "wiki-page",
    title: "Delivery handbook",
    body: "Release readiness and escalation guidance",
    status: "published",
    tags: ["handbook"]
  });
  assert.equal(parent.response.statusCode, 201);
  assert.equal(parent.payload.data.version, 1);
  const child = await send(handler, "POST", "/api/v1/project-content", {
    projectId: "project-pilot",
    kind: "news",
    title: "Launch update",
    body: "The readiness review passed.",
    parentId: parent.payload.data.id,
    status: "published"
  });
  assert.equal(child.response.statusCode, 201);
  const listed = await send(handler, "GET", "/api/v1/project-content?projectId=project-pilot&kind=wiki-page&search=escalation");
  assert.deepEqual(listed.payload.data.items.map((item) => item.id), [parent.payload.data.id]);

  const patched = await send(handler, "PATCH", `/api/v1/project-content/${parent.payload.data.id}?projectId=project-pilot`, {
    version: parent.payload.data.version,
    body: "Release readiness, escalation guidance, and rollback ownership",
    pinned: true
  });
  assert.equal(patched.response.statusCode, 200);
  assert.equal(patched.payload.data.version, 2);
  const presence = await send(handler, "POST", `/api/v1/project-content/${parent.payload.data.id}/presence?projectId=project-pilot`, {
    clientId: "browser-one",
    cursor: 12,
    selectionEnd: 18
  });
  assert.equal(presence.response.statusCode, 200);
  assert.equal(presence.payload.data.userId, "user-demo-admin");
  const activeEditors = await send(handler, "GET", `/api/v1/project-content/${parent.payload.data.id}/presence?projectId=project-pilot`);
  assert.deepEqual(activeEditors.payload.data.items.map((item) => item.clientId), ["browser-one"]);
  const collaborativeBody = "# {{project.name}} handbook\n\n{{toc}}\n\n## Rollback\nSee [work-item:work-pilot].";
  const operated = await send(handler, "POST", `/api/v1/project-content/${parent.payload.data.id}/operations?projectId=project-pilot`, {
    version: patched.payload.data.version,
    clientId: "browser-one",
    operations: [
      {type: "delete", index: 0, count: patched.payload.data.body.length},
      {type: "insert", index: 0, text: collaborativeBody}
    ]
  });
  assert.equal(operated.response.statusCode, 200);
  assert.equal(operated.payload.data.version, 3);
  assert.equal(operated.payload.data.body, collaborativeBody);
  const editorOne = await send(handler, "POST", `/api/v1/project-content/${parent.payload.data.id}/operations?projectId=project-pilot`, {
    version: operated.payload.data.version,
    clientId: "browser-one",
    changeId: "change-a",
    operations: [{type: "insert", index: collaborativeBody.length, text: "\nEditor one"}]
  });
  const editorTwo = await send(handler, "POST", `/api/v1/project-content/${parent.payload.data.id}/operations?projectId=project-pilot`, {
    version: operated.payload.data.version,
    clientId: "browser-two",
    changeId: "change-b",
    operations: [{type: "insert", index: collaborativeBody.length, text: "\nEditor two"}]
  });
  assert.equal(editorTwo.response.statusCode, 200);
  assert.equal(editorTwo.payload.data.collaboration.merged, true);
  assert.equal(editorTwo.payload.data.body, `${collaborativeBody}\nEditor one\nEditor two`);
  const replayedEditorTwo = await send(handler, "POST", `/api/v1/project-content/${parent.payload.data.id}/operations?projectId=project-pilot`, {
    version: operated.payload.data.version,
    clientId: "browser-two",
    changeId: "change-b",
    operations: [{type: "insert", index: collaborativeBody.length, text: "\nEditor two"}]
  });
  assert.equal(replayedEditorTwo.payload.data.version, editorTwo.payload.data.version);
  assert.equal(replayedEditorTwo.payload.data.collaboration.duplicate, true);
  const revisions = await send(handler, "GET", `/api/v1/project-content/${parent.payload.data.id}/revisions?projectId=project-pilot`);
  assert.deepEqual(revisions.payload.data.items.map((revision) => revision.version), [5, 4, 3, 2, 1]);
  const search = await send(handler, "GET", "/api/v1/search?q=rollback");
  assert.equal(search.payload.data.items.some((item) => item.id === parent.payload.data.id && item.type === "wiki-page"), true);

  const blockedDelete = await send(handler, "DELETE", `/api/v1/project-content/${parent.payload.data.id}?projectId=project-pilot`, {version: editorTwo.payload.data.version});
  assert.equal(blockedDelete.response.statusCode, 409);
  const childDelete = await send(handler, "DELETE", `/api/v1/project-content/${child.payload.data.id}?projectId=project-pilot`, {version: child.payload.data.version});
  assert.equal(childDelete.response.statusCode, 200);
  const removed = await send(handler, "DELETE", `/api/v1/project-content/${parent.payload.data.id}?projectId=project-pilot`, {version: editorTwo.payload.data.version});
  assert.equal(removed.payload.data.deleted, true);
});

test("connects calendars, automatic schedules, baselines, sprints, burndown, and saved boards", async () => {
  const handler = createHandler({repository: new MemoryRepository()});
  const calendar = await send(handler, "POST", "/api/v1/planning-resources", {
    projectId: "project-pilot",
    kind: "work-calendar",
    name: "Delivery calendar",
    status: "active",
    workingDays: [1, 2, 3, 4, 5],
    holidays: ["2026-08-31"],
    hoursPerDay: 8,
    default: true
  });
  assert.equal(calendar.response.statusCode, 201);
  const predecessor = await send(handler, "POST", "/api/v1/projects/project-pilot/work-items", {
    title: "Finish dependency",
    startDate: "2026-08-28",
    dueDate: "2026-08-28",
    estimateMinutes: 480,
    schedulingMode: "manual"
  });
  const dependent = await send(handler, "POST", "/api/v1/projects/project-pilot/work-items", {
    title: "Automatically scheduled follow-up",
    estimateMinutes: 960,
    remainingMinutes: 960,
    schedulingMode: "automatic",
    relations: [{type: "predecessor", targetId: predecessor.payload.data.id, lagDays: 0}]
  });
  const scheduled = await send(handler, "POST", "/api/v1/projects/project-pilot/schedule", {});
  assert.equal(scheduled.response.statusCode, 200);
  const scheduledDependent = scheduled.payload.data.items.find((item) => item.id === dependent.payload.data.id);
  assert.equal(scheduledDependent.startDate, "2026-09-01");
  assert.equal(scheduledDependent.dueDate, "2026-09-02");

  const baseline = await send(handler, "POST", "/api/v1/planning-resources", {
    projectId: "project-pilot",
    kind: "baseline",
    name: "Approved schedule"
  });
  assert.equal(baseline.payload.data.snapshot.some((item) => item.id === dependent.payload.data.id), true);
  const currentDependent = (await send(handler, "GET", "/api/v1/projects/project-pilot/work-items?limit=100")).payload.data.items.find((item) => item.id === dependent.payload.data.id);
  await send(handler, "PATCH", `/api/v1/projects/project-pilot/work-items/${dependent.payload.data.id}`, {
    version: currentDependent.version,
    dueDate: "2026-09-04"
  });
  const comparison = await send(handler, "GET", `/api/v1/planning-resources/${baseline.payload.data.id}/baseline-comparison?projectId=project-pilot`);
  assert.equal(comparison.payload.data.summary.changed >= 1, true);

  const sprint = await send(handler, "POST", "/api/v1/planning-resources", {
    projectId: "project-pilot",
    kind: "sprint",
    name: "Sprint 12",
    status: "active",
    startDate: "2026-08-24",
    endDate: "2026-09-04",
    capacityPoints: 20
  });
  const latestDependent = (await send(handler, "GET", "/api/v1/projects/project-pilot/work-items?limit=100")).payload.data.items.find((item) => item.id === dependent.payload.data.id);
  await send(handler, "PATCH", `/api/v1/projects/project-pilot/work-items/${dependent.payload.data.id}`, {
    version: latestDependent.version,
    sprintId: sprint.payload.data.id,
    effortPoints: 8
  });
  const burndown = await send(handler, "GET", `/api/v1/planning-resources/${sprint.payload.data.id}/burndown?projectId=project-pilot`);
  assert.equal(burndown.payload.data.totalPoints, 8);
  assert.equal(burndown.payload.data.series.length, 12);

  const board = await send(handler, "POST", "/api/v1/planning-resources", {
    projectId: "project-pilot",
    kind: "board",
    name: "Release owners",
    boardDimension: "assignee",
    boardEditorIds: ["user-delivery-lead"]
  });
  assert.equal(board.response.statusCode, 201);
  const memberBoards = await send(handler, "GET", "/api/v1/planning-resources?projectId=project-pilot&kind=board", undefined, {
    "x-demo-user-id": "user-product-engineer",
    "x-demo-user-email": "engineer@team-spaces.example",
    "x-demo-user-name": "Jordan Lee"
  });
  assert.equal(memberBoards.payload.data.items.some((item) => item.id === board.payload.data.id), false);
});

test("compares task state across retained historical dates without a pre-created baseline", async () => {
  const repository = new MemoryRepository();
  let clock = "2026-08-26T12:00:00.000Z";
  repository.now = () => clock;
  const handler = createHandler({repository});
  const first = repository.workItems.get("work-cognito");
  assert.ok(first);
  const dayOne = await send(handler, "PATCH", "/api/v1/projects/project-pilot/work-items/work-cognito", {version: first.version, title: "Cognito ready on day one"});
  assert.equal(dayOne.response.statusCode, 200);
  clock = "2026-08-27T12:00:00.000Z";
  const dayTwo = await send(handler, "PATCH", "/api/v1/projects/project-pilot/work-items/work-cognito", {version: dayOne.payload.data.version, title: "Cognito ready on day two"});
  assert.equal(dayTwo.response.statusCode, 200);

  const comparison = await send(handler, "GET", "/api/v1/projects/project-pilot/baseline-comparison?from=2026-08-25&to=2026-08-26");
  assert.equal(comparison.response.statusCode, 200);
  assert.deepEqual(comparison.payload.data.range, {from: "2026-08-25", to: "2026-08-26"});
  assert.equal(comparison.payload.data.historyComplete, true);
  const changed = comparison.payload.data.items.find((item) => item.id === "work-cognito");
  assert.equal(changed.change, "changed");
  assert.equal(changed.previous.title, "Connect Cognito hosted UI");
  assert.equal(changed.current.title, "Cognito ready on day one");

  const invalid = await send(handler, "GET", "/api/v1/projects/project-pilot/baseline-comparison?from=2026-08-27&to=2026-08-26");
  assert.equal(invalid.response.statusCode, 400);
});

test("enforces configured fields, actions, custom roles, exact time, finance, resources, and security", async () => {
  const handler = createHandler({repository: new MemoryRepository()});
  const capabilities = JSON.parse(JSON.stringify(defaultWorkspaceCapabilities));
  capabilities.work.automaticSubjectPattern = "{project} · {type} · {sequence}";
  capabilities.work.exactTimeRequired = true;
  capabilities.customFields = [
    {id: "business-value", name: "Business value", type: "weighted", entityType: "work-item", required: true, options: [{id: "high", weight: 8}]},
    {id: "value-score", name: "Value score", type: "calculated", entityType: "work-item", formula: "business-value__score * 2"},
    {id: "risk-rating", name: "Risk rating", type: "select", entityType: "project", options: [{id: "low"}, {id: "high"}]}
  ];
  capabilities.customActions = [{id: "escalate", name: "Escalate", roles: ["custom:quality-reviewer"], changes: {priority: "critical"}}];
  capabilities.customRoles = [{id: "quality-reviewer", name: "Quality reviewer", permissions: ["workspace:read", "work:manage", "time:manage:own", "report:read"]}];
  capabilities.finance = {
    currency: "USD",
    rates: [{userId: "user-quality-reviewer-example-test", projectId: "project-pilot", hourlyRate: 120, validFrom: "2026-08-01"}],
    unitCosts: [{id: "licenses", projectId: "project-pilot", quantity: 2, unitPrice: 50}],
    budgets: [{id: "pilot-budget", projectId: "project-pilot", amount: 10000}],
    reportDefinitions: [{id: "variance", name: "Budget variance"}]
  };
  capabilities.resources = {profiles: [{userId: "user-quality-reviewer-example-test", weeklyMinutes: 1800, skills: ["quality", "release"]}], allocations: [], timeOff: []};
  capabilities.authentication.mfaRequired = true;
  capabilities.security.malwareScanning = "required";
  capabilities.security.scannerWebhookId = "scanner";
  capabilities.security.scannerCredentialHash = createHash("sha256").update("resource-test-scanner-token").digest("hex");
  capabilities.webhooks = [{id: "scanner", name: "Scanner", url: "https://scanner.example.test/jobs", enabled: true, eventTypes: ["document.scan-requested"]}];
  const savedCapabilities = await send(handler, "PATCH", "/api/v1/capabilities", capabilities);
  assert.equal(savedCapabilities.response.statusCode, 200);
  assert.equal(savedCapabilities.payload.data.version, 2);

  const projectBefore = await send(handler, "GET", "/api/v1/projects/project-pilot");
  const configuredProject = await send(handler, "PATCH", "/api/v1/projects/project-pilot", {version: projectBefore.payload.data.version, customFields: {"risk-rating": "high"}});
  assert.equal(configuredProject.payload.data.customFields["risk-rating"], "high");

  const membership = await send(handler, "POST", "/api/v1/memberships", {
    email: "quality.reviewer@example.test",
    name: "Quality Reviewer",
    role: "custom:quality-reviewer",
    status: "active"
  });
  assert.equal(membership.response.statusCode, 201);
  const placeholder = await send(handler, "POST", "/api/v1/placeholders", {name: "Future release specialist", weeklyMinutes: 1200, skills: ["release", "compliance"], projectIds: ["project-pilot"]});
  assert.equal(placeholder.response.statusCode, 201);
  assert.equal(placeholder.payload.data.placeholder, true);
  const profile = await send(handler, "POST", "/api/v1/resource-planner/profiles", {version: savedCapabilities.payload.data.version, userId: membership.payload.data.userId, weeklyMinutes: 2100, skills: ["quality", "release", "facilitation"]});
  assert.equal(profile.response.statusCode, 200);
  const allocation = await send(handler, "POST", "/api/v1/resource-planner/allocations", {version: profile.payload.data.version, userId: membership.payload.data.userId, projectId: "project-pilot", startDate: "2026-08-24", endDate: "2026-08-30", minutes: 600, note: "Release readiness"});
  assert.equal(allocation.response.statusCode, 200);
  const timeOff = await send(handler, "POST", "/api/v1/resource-planner/time-off", {version: allocation.payload.data.version, userId: membership.payload.data.userId, startDate: "2026-08-26", endDate: "2026-08-26", minutes: 480, note: "Leave"});
  assert.equal(timeOff.response.statusCode, 200);
  const customHeaders = {
    "x-demo-user-id": membership.payload.data.userId,
    "x-demo-user-email": "quality.reviewer@example.test",
    "x-demo-user-name": "Quality Reviewer"
  };
  const work = await send(handler, "POST", "/api/v1/projects/project-pilot/work-items", {
    autoSubject: true,
    type: "task",
    customFields: {"business-value": "high"},
    estimateMinutes: 120
  }, customHeaders);
  assert.equal(work.response.statusCode, 201);
  assert.match(work.payload.data.title, /Pilot Readiness/);
  assert.equal(work.payload.data.customFields["business-value__score"], 8);
  assert.equal(work.payload.data.customFields["value-score"], 16);
  const action = await send(handler, "POST", `/api/v1/projects/project-pilot/work-items/${work.payload.data.id}/actions/escalate`, {version: work.payload.data.version}, customHeaders);
  assert.equal(action.payload.data.priority, "critical");

  const imprecise = await send(handler, "POST", "/api/v1/time-entries", {projectId: "project-pilot", entryDate: "2026-08-26", durationMinutes: 60}, customHeaders);
  assert.equal(imprecise.response.statusCode, 400);
  const exact = await send(handler, "POST", "/api/v1/time-entries", {
    projectId: "project-pilot",
    workItemId: work.payload.data.id,
    entryDate: "2026-08-26",
    startedAt: "2026-08-26T13:00:00Z",
    endedAt: "2026-08-26T14:30:00Z",
    billable: true
  }, customHeaders);
  assert.equal(exact.payload.data.durationMinutes, 90);
  const costs = await send(handler, "GET", "/api/v1/reports/costs", undefined, customHeaders);
  assert.equal(costs.payload.data.projects.find((project) => project.projectId === "project-pilot").actualCost, 280);
  const resources = await send(handler, "GET", "/api/v1/reports/resources?week=2026-08-24&projectId=project-pilot&skill=quality", undefined, customHeaders);
  const plannedMember = resources.payload.data.items.find((item) => item.userId === membership.payload.data.userId);
  assert.deepEqual(plannedMember.skills, ["quality", "release", "facilitation"]);
  assert.equal(plannedMember.weeklyMinutes, 2100);
  assert.equal(plannedMember.timeOffMinutes, 480);
  assert.equal(plannedMember.configuredMinutes, 600);
  assert.equal(plannedMember.taskMinutes, 120);
  assert.equal(plannedMember.availableMinutes, 900);
  const allResources = await send(handler, "GET", "/api/v1/reports/resources?week=2026-08-24", undefined, customHeaders);
  assert.equal(allResources.payload.data.items.find((item) => item.userId === placeholder.payload.data.userId).weeklyMinutes, 1200);
  const allocationId = timeOff.payload.data.resources.allocations[0].id;
  const removedAllocation = await send(handler, "DELETE", `/api/v1/resource-planner/allocations/${allocationId}`, {version: resources.payload.data.version});
  assert.equal(removedAllocation.payload.data.resources.allocations.length, 0);
  const badge = await send(handler, "GET", "/api/v1/security/badge", undefined, customHeaders);
  assert.equal(badge.payload.data.status, "secure");
});

test("enforces custom fields across users, groups, versions, time entries, activities, priorities, timers, and SCIM", async () => {
  const handler = createHandler({repository: new MemoryRepository()});
  const capabilities = JSON.parse(JSON.stringify(defaultWorkspaceCapabilities));
  capabilities.customFields = [
    {id: "clearance", name: "Clearance", type: "select", entityType: "user", required: true, options: [{id: "standard"}, {id: "restricted"}]},
    {id: "region", name: "Region", type: "string", entityType: "group", required: true},
    {id: "release-link", name: "Release link", type: "link", entityType: "version", required: true},
    {id: "release-reviewers", name: "Release reviewers", type: "user", entityType: "version", multiSelect: true},
    {id: "billing-code", name: "Billing code", type: "string", entityType: "time-entry", required: true},
    {id: "cost-center", name: "Cost center", type: "string", entityType: "time-entry", defaultValue: "OPS"},
    {id: "ledger", name: "Ledger", type: "string", entityType: "time-entry-activity", required: true},
    {id: "rank", name: "Rank", type: "integer", entityType: "priority", required: true}
  ];
  capabilities.groups = [{id: "delivery", name: "Delivery", customFields: {region: "NA"}}];
  capabilities.priorities = capabilities.priorities.map((priority, index) => ({...priority, customFields: {rank: index + 1}}));
  capabilities.timeEntryActivities = [
    {id: "general", name: "General", active: true, customFields: {ledger: "GEN"}},
    {id: "research", name: "Research", active: true, customFields: {ledger: "RND"}}
  ];
  const savedCapabilities = await send(handler, "PATCH", "/api/v1/capabilities", capabilities);
  assert.equal(savedCapabilities.response.statusCode, 200);
  assert.equal(savedCapabilities.payload.data.groups[0].customFields.region, "NA");
  assert.equal(savedCapabilities.payload.data.timeEntryActivities[1].customFields.ledger, "RND");
  assert.equal(savedCapabilities.payload.data.priorities[0].customFields.rank, 1);

  const missingUserField = await send(handler, "POST", "/api/v1/memberships", {email: "field.user@example.test", name: "Field User", role: "viewer", status: "active"});
  assert.equal(missingUserField.response.statusCode, 400);
  const member = await send(handler, "POST", "/api/v1/memberships", {email: "field.user@example.test", name: "Field User", role: "viewer", status: "active", customFields: {clearance: "restricted"}});
  assert.equal(member.response.statusCode, 201);
  assert.equal(member.payload.data.customFields.clearance, "restricted");
  const profile = await send(handler, "PATCH", "/api/v1/me/profile", {name: "Demo Administrator", customFields: {clearance: "standard"}});
  assert.equal(profile.response.statusCode, 200);
  assert.equal(profile.payload.data.membership.customFields.clearance, "standard");

  const missingVersionField = await send(handler, "POST", "/api/v1/planning-resources", {projectId: "project-pilot", kind: "version", name: "Release 2", status: "planned"});
  assert.equal(missingVersionField.response.statusCode, 400);
  const release = await send(handler, "POST", "/api/v1/planning-resources", {projectId: "project-pilot", kind: "version", name: "Release 2", status: "planned", customFields: {"release-link": "https://example.test/releases/2", "release-reviewers": ["user-demo-admin", "user-delivery-lead"]}});
  assert.equal(release.response.statusCode, 201);
  assert.equal(release.payload.data.customFields["release-link"], "https://example.test/releases/2");
  assert.deepEqual(release.payload.data.customFields["release-reviewers"], ["user-demo-admin", "user-delivery-lead"]);
  const unsafeRelease = await send(handler, "PATCH", `/api/v1/planning-resources/${release.payload.data.id}?projectId=project-pilot`, {version: release.payload.data.version, customFields: {"release-link": "https://user:secret@example.test/release"}});
  assert.equal(unsafeRelease.response.statusCode, 400);

  const missingTimeField = await send(handler, "POST", "/api/v1/time-entries", {projectId: "project-pilot", entryDate: "2026-08-27", durationMinutes: 30, activityId: "research"});
  assert.equal(missingTimeField.response.statusCode, 400);
  const time = await send(handler, "POST", "/api/v1/time-entries", {projectId: "project-pilot", entryDate: "2026-08-27", durationMinutes: 30, activityId: "research", customFields: {"billing-code": "R-42"}});
  assert.equal(time.response.statusCode, 201);
  assert.equal(time.payload.data.activityId, "research");
  assert.equal(time.payload.data.customFields["billing-code"], "R-42");
  assert.equal(time.payload.data.customFields["cost-center"], "OPS");
  const timer = await send(handler, "POST", "/api/v1/timer/start", {projectId: "project-pilot", activityId: "research", customFields: {"billing-code": "R-43"}});
  assert.equal(timer.response.statusCode, 201);
  const stopped = await send(handler, "POST", "/api/v1/timer/stop", {});
  assert.equal(stopped.response.statusCode, 200);
  assert.equal(stopped.payload.data.entry.activityId, "research");
  assert.equal(stopped.payload.data.entry.customFields["billing-code"], "R-43");
  assert.ok(stopped.payload.data.entry.startedAt);
  assert.ok(stopped.payload.data.entry.endedAt);
});

test("manages recurring meeting records, templates, attendance, attachments, exports, copy, and delete", async () => {
  const handler = createHandler({repository: new MemoryRepository()});
  const meeting = await send(handler, "POST", "/api/v1/meetings", {
    projectId: "project-pilot",
    title: "Weekly readiness council",
    description: "Review readiness and decide escalations.",
    startsAt: "2026-09-01T14:00:00Z",
    endsAt: "2026-09-01T15:00:00Z",
    participantIds: ["user-demo-admin", "user-delivery-lead"],
    agendaItems: [{id: "readiness", section: "Decisions", title: "Readiness decision", durationMinutes: 30, presenterId: "user-delivery-lead", workItemIds: ["work-cognito"], notes: "Review evidence", outcome: ""}],
    recurrence: {frequency: "weekly", interval: 1, weekdays: [2], occurrences: 8},
    attachmentIds: ["doc-pilot-brief"],
    attendance: [{userId: "user-demo-admin", status: "accepted"}, {userId: "user-delivery-lead", status: "invited"}],
    invitationMessage: "Please review the readiness brief."
  }, {"idempotency-key": "meeting-parity-001"});
  assert.equal(meeting.response.statusCode, 201);
  assert.equal(meeting.payload.data.seriesId, meeting.payload.data.id);
  assert.equal(meeting.payload.data.agendaItems[0].section, "Decisions");
  const global = await send(handler, "GET", "/api/v1/meetings?limit=50");
  assert.equal(global.payload.data.items.some((item) => item.id === meeting.payload.data.id), true);

  const response = await send(handler, "POST", `/api/v1/meetings/${meeting.payload.data.id}/attendance?projectId=project-pilot`, {version: meeting.payload.data.version, status: "attended"});
  assert.equal(response.payload.data.attendance.find((item) => item.userId === "user-demo-admin").status, "attended");
  const calendar = await send(handler, "GET", `/api/v1/meetings/${meeting.payload.data.id}/calendar?projectId=project-pilot`);
  assert.match(calendar.payload.data.content, /RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=8;BYDAY=TU/);
  const pdf = await send(handler, "GET", `/api/v1/meetings/${meeting.payload.data.id}/pdf?projectId=project-pilot`);
  assert.equal(Buffer.from(pdf.payload.data.base64, "base64").subarray(0, 8).toString(), "%PDF-1.4");
  const copied = await send(handler, "POST", `/api/v1/meetings/${meeting.payload.data.id}/copy`, {projectId: "project-pilot", title: "Readiness template", asTemplate: true});
  assert.equal(copied.response.statusCode, 201);
  assert.equal(copied.payload.data.template, true);
  assert.equal(copied.payload.data.agendaItems[0].outcome, "");
  const removed = await send(handler, "DELETE", `/api/v1/meetings/${copied.payload.data.id}?projectId=project-pilot`, {version: copied.payload.data.version});
  assert.equal(removed.payload.data.deleted, true);
});

test("governs configurable dashboards, initiation requests, lifecycle gates, and date-alert digests", async () => {
  const repository = new MemoryRepository();
  const handler = createHandler({repository});
  const template = await send(handler, "POST", "/api/v1/projects", {name: "Governed delivery template", template: true, modules: ["work", "meetings", "documents", "wiki"], tags: ["governed"]});
  const capabilities = JSON.parse(JSON.stringify(defaultWorkspaceCapabilities));
  capabilities.dashboard.widgets = [{id: "my-work", type: "my-work"}, {id: "activity", type: "activity", limit: 5}, {id: "projects", type: "project-list"}];
  capabilities.lifecycle = {
    phases: [
      {id: "proposed", label: "Proposed", gates: []},
      {id: "execution", label: "Execution", gates: [{id: "sponsor-approval", name: "Sponsor approval", reviewerIds: ["user-demo-admin"]}]}
    ],
    initiation: {enabled: true, reviewerIds: ["user-demo-admin"], templateProjectId: template.payload.data.id, requestFields: [{id: "business-case", name: "Business case", type: "string", required: true}]}
  };
  capabilities.notifications = {participationRules: ["assigned", "watching"], emailDigest: "daily", dateAlerts: [{id: "due-window", name: "Delivery date window", enabled: true, daysBefore: 3650, daysAfter: 3650}], securityAlerts: true};
  capabilities.webhooks = [{id: "mail-gateway", name: "Mail gateway", url: "https://mail.example.test/digests", enabled: true, eventTypes: ["notification.digest"]}];
  await send(handler, "PATCH", "/api/v1/capabilities", capabilities);
  const defaultPreferences = await send(handler, "GET", "/api/v1/notification-preferences");
  assert.equal(defaultPreferences.payload.data.emailDigest, "daily");
  const preferences = await send(handler, "PATCH", "/api/v1/notification-preferences", {
    version: defaultPreferences.payload.data.version,
    participationRules: ["assigned"],
    projectOverrides: [{projectId: "project-pilot", participationRules: ["watching"]}],
    dateAlertsEnabled: true,
    emailDigest: "weekly",
    deliveryWebhookId: "mail-gateway",
    digestHourUtc: 13,
    weeklyDay: 4
  });
  assert.equal(preferences.response.statusCode, 200);
  assert.equal(preferences.payload.data.version, 2);
  assert.deepEqual(preferences.payload.data.projectOverrides[0].participationRules, ["watching"]);
  const project = await send(handler, "POST", "/api/v1/projects", {name: "Governed delivery", phase: "Proposed"});
  assert.equal(project.payload.data.initiationStatus, "draft");
  const submitted = await send(handler, "POST", `/api/v1/projects/${project.payload.data.id}/initiation/submit`, {version: project.payload.data.version, requestData: {"business-case": "Reduce release risk"}, note: "Sponsor requested review"});
  assert.equal(submitted.payload.data.initiationStatus, "submitted");
  assert.equal(submitted.payload.data.templateSourceProjectId, template.payload.data.id);
  assert.equal(submitted.payload.data.modules.includes("wiki"), true);
  const approved = await send(handler, "POST", `/api/v1/projects/${project.payload.data.id}/initiation/review`, {version: submitted.payload.data.version, decision: "approved", comment: "Funding and ownership confirmed"});
  assert.equal(approved.payload.data.initiationStatus, "approved");
  assert.equal(approved.payload.data.initiationAuditArtifact.decisions.length, 1);
  const gated = await send(handler, "PATCH", `/api/v1/projects/${project.payload.data.id}`, {version: approved.payload.data.version, phase: "Execution"});
  assert.equal(gated.response.statusCode, 409);
  const gate = await send(handler, "POST", `/api/v1/projects/${project.payload.data.id}/lifecycle-gates/sponsor-approval/approve`, {version: approved.payload.data.version, comment: "Sponsor signed off"});
  assert.equal(gate.payload.data.lifecycleGateApprovals[0].gateId, "sponsor-approval");
  const execution = await send(handler, "PATCH", `/api/v1/projects/${project.payload.data.id}`, {version: gate.payload.data.version, phase: "Execution"});
  assert.equal(execution.payload.data.phase, "Execution");
  const digest = await send(handler, "GET", "/api/v1/notifications/digest");
  assert.equal(digest.payload.data.frequency, "weekly");
  assert.equal(digest.payload.data.summary.dateAlertCount > 0, true);
  const bootstrap = await send(handler, "GET", "/api/v1/bootstrap");
  assert.equal(bootstrap.payload.data.capabilities.dashboard.widgets.length, 3);
});

test("links maintained connectors, imports Jira, captures outbound navigation, and exposes MCP tools", async () => {
  const repository = new MemoryRepository();
  const handler = createHandler({repository});
  const capabilities = JSON.parse(JSON.stringify(defaultWorkspaceCapabilities));
  capabilities.connectors = [
    {id: "github-main", name: "GitHub", type: "github", enabled: true, baseUrl: "https://github.example.test"},
    {id: "jira", name: "Jira", type: "jira", enabled: true, baseUrl: "https://jira.example.test"},
    {id: "nextcloud", name: "Nextcloud", type: "nextcloud", enabled: true, baseUrl: "https://files.example.test"}
  ];
  capabilities.repositories = [{id: "platform-git", name: "Platform Git", type: "git", enabled: true, projectId: "project-pilot", baseUrl: "https://git.example.test/platform/team-spaces"}];
  capabilities.outboundLinks = {policy: "capture", captureEvents: true, allowDomains: ["docs.example.test"]};
  capabilities.mcp = {enabled: true, readOnly: false, allowedToolIds: ["search", "list_projects", "list_work_items", "create_work_item", "update_work_item"]};
  const saved = await send(handler, "PATCH", "/api/v1/capabilities", capabilities);
  assert.equal(saved.response.statusCode, 200);

  const linked = await send(handler, "POST", "/api/v1/integration-links", {
    projectId: "project-pilot",
    workItemId: "work-cognito",
    connectorId: "github-main",
    externalId: "openai/team-spaces#42",
    externalUrl: "https://github.example.test/openai/team-spaces/pull/42",
    title: "Implement readiness workflow",
    linkType: "development",
    metadata: {state: "open", repository: "openai/team-spaces"}
  });
  assert.equal(linked.response.statusCode, 201);
  const event = await send(handler, "POST", "/api/v1/integrations/github-main/events", {
    linkId: linked.payload.data.id,
    eventType: "pull-request.merged",
    summary: "Pull request 42 merged",
    payload: {commit: "abc123"}
  });
  assert.equal(event.response.statusCode, 201);
  assert.equal(event.payload.data.workItemId, "work-cognito");

  const imported = await send(handler, "POST", "/api/v1/integrations/jira/import", {
    projectId: "project-pilot",
    connectorId: "jira",
    issues: [{key: "READY-17", summary: "Migrate readiness checklist", type: "task", status: "new", priority: "high", externalUrl: "https://jira.example.test/browse/READY-17"}]
  });
  assert.equal(imported.response.statusCode, 201);
  assert.equal(imported.payload.data.importedCount, 1);
  assert.equal(imported.payload.data.items[0].link.externalId, "READY-17");
  const catalog = await send(handler, "GET", "/api/v1/integrations");
  assert.equal(catalog.payload.data.connectors.find((item) => item.id === "jira").linkedItemCount, 1);
  const synchronizedRepository = await send(handler, "POST", "/api/v1/repositories/platform-git/sync", {ref: "main", revision: "abc123", entries: [{path: "src", type: "directory", revision: "abc123"}, {path: "README.md", type: "file", sizeBytes: 100, revision: "abc123", externalUrl: "https://git.example.test/platform/team-spaces/blob/main/README.md"}, {path: "src/index.js", type: "file", sizeBytes: 200, revision: "abc123"}]});
  assert.equal(synchronizedRepository.payload.data.entryCount, 3);
  const repositoryRoot = await send(handler, "GET", "/api/v1/repositories/platform-git/tree?ref=main");
  assert.deepEqual(repositoryRoot.payload.data.entries.map((entry) => entry.path), ["src", "README.md"]);
  const repositorySource = await send(handler, "GET", "/api/v1/repositories/platform-git/tree?path=src");
  assert.deepEqual(repositorySource.payload.data.entries.map((entry) => entry.path), ["src/index.js"]);

  const warning = await send(handler, "POST", "/api/v1/outbound-links/check", {url: "https://untrusted.example.org/reference", sourceType: "work-item", sourceId: "work-cognito"});
  assert.equal(warning.payload.data.allowed, false);
  assert.equal(warning.payload.data.requiresConfirmation, true);
  const confirmed = await send(handler, "POST", "/api/v1/outbound-links/check", {url: "https://untrusted.example.org/reference", sourceType: "work-item", sourceId: "work-cognito", confirmed: true});
  assert.equal(confirmed.payload.data.allowed, true);
  const allowedDomain = await send(handler, "POST", "/api/v1/outbound-links/check", {url: "https://docs.example.test/guide"});
  assert.equal(allowedDomain.payload.data.allowedDomain, true);
  const navigationEvents = await send(handler, "GET", "/api/v1/outbound-links/events");
  assert.equal(navigationEvents.payload.data.items.length, 3);

  const initialized = await send(handler, "POST", "/api/v1/mcp", {jsonrpc: "2.0", id: 1, method: "initialize", params: {}});
  assert.equal(initialized.payload.result.serverInfo.name, "team-spaces");
  const tools = await send(handler, "POST", "/api/v1/mcp", {jsonrpc: "2.0", id: 2, method: "tools/list", params: {}});
  assert.equal(tools.payload.result.tools.some((tool) => tool.name === "create_work_item"), true);
  const called = await send(handler, "POST", "/api/v1/mcp", {jsonrpc: "2.0", id: 3, method: "tools/call", params: {name: "create_work_item", arguments: {projectId: "project-pilot", title: "Created through MCP", type: "task"}}});
  assert.equal(called.payload.result.structuredContent.title, "Created through MCP");
  const toolError = await send(handler, "POST", "/api/v1/mcp", {jsonrpc: "2.0", id: 4, method: "tools/call", params: {name: "list_work_items", arguments: {}}});
  assert.equal(toolError.response.statusCode, 200);
  assert.equal(toolError.payload.result.isError, true);
  const csv = await send(handler, "GET", "/api/v1/exports/work-items?projectId=project-pilot&format=csv");
  assert.match(csv.payload.data.content, /ID,Project,Subject/);
  const xls = await send(handler, "GET", "/api/v1/exports/work-items?projectId=project-pilot&format=xls");
  assert.match(xls.payload.data.content, /<Workbook/);
  const atom = await send(handler, "GET", "/api/v1/exports/work-items?projectId=project-pilot&format=atom");
  assert.match(atom.payload.data.content, /<feed xmlns="http:\/\/www.w3.org\/2005\/Atom">/);
  const pdf = await send(handler, "GET", "/api/v1/exports/work-items?projectId=project-pilot&format=pdf");
  assert.equal(Buffer.from(pdf.payload.data.base64, "base64").subarray(0, 8).toString(), "%PDF-1.4");
  const gantt = await send(handler, "GET", "/api/v1/exports/gantt?projectId=project-pilot");
  assert.equal(gantt.payload.data.view, "gantt");
  assert.match(gantt.payload.data.filename, /gantt\.pdf$/);
  assert.equal(Buffer.from(gantt.payload.data.base64, "base64").subarray(0, 8).toString(), "%PDF-1.4");
});

test("limits external task shares to recipients and external-safe comments", async () => {
  const repository = new MemoryRepository();
  const handler = createHandler({repository});
  const capabilities = JSON.parse(JSON.stringify(defaultWorkspaceCapabilities));
  capabilities.externalSharing = {enabled: true, defaultExpiresDays: 7};
  await send(handler, "PATCH", "/api/v1/capabilities", capabilities);
  const created = await send(handler, "POST", "/api/v1/external-shares", {
    projectId: "project-pilot",
    workItemId: "work-cognito",
    targetType: "email",
    target: "partner@example.test",
    permissions: ["read", "comment"]
  });
  assert.equal(created.response.statusCode, 201);
  await send(handler, "POST", "/api/v1/activity", {projectId: "project-pilot", entityType: "work-item", entityId: "work-cognito", summary: "Internal-only decision", visibility: "internal"});
  const recipientHeaders = {"x-demo-user-id": "user-external-partner", "x-demo-user-email": "partner@example.test", "x-demo-user-name": "External Partner"};
  const shared = await send(handler, "GET", `/api/v1/shared-work/${created.payload.data.token}`, undefined, recipientHeaders);
  assert.equal(shared.response.statusCode, 200);
  assert.equal(shared.payload.data.workItem.id, "work-cognito");
  assert.equal(shared.payload.data.activity.some((item) => item.visibility === "internal"), false);
  const comment = await send(handler, "POST", `/api/v1/shared-work/${created.payload.data.token}/comments`, {summary: "Partner confirms the handoff."}, recipientHeaders);
  assert.equal(comment.response.statusCode, 201);
  assert.equal(comment.payload.data.visibility, "external");
  const wrongRecipient = await send(handler, "GET", `/api/v1/shared-work/${created.payload.data.token}`, undefined, {"x-demo-user-id": "user-not-target", "x-demo-user-email": "other@example.test"});
  assert.equal(wrongRecipient.response.statusCode, 404);
  const revoked = await send(handler, "DELETE", `/api/v1/external-shares/${created.payload.data.token}`, {version: created.payload.data.version});
  assert.equal(revoked.payload.data.revoked, true);
  const gone = await send(handler, "GET", `/api/v1/shared-work/${created.payload.data.token}`, undefined, recipientHeaders);
  assert.equal(gone.response.statusCode, 404);
});

test("provisions LDAP and SCIM users, delivers webhooks, and enforces clean document scans", async () => {
  const repository = new MemoryRepository();
  const handler = createHandler({repository});
  const scimToken = "scim-integration-test-token";
  const scannerToken = "scanner-integration-test-token";
  const capabilities = JSON.parse(JSON.stringify(defaultWorkspaceCapabilities));
  capabilities.authentication.ldap = {enabled: true, host: "ldaps://directory.example.test", baseDn: "dc=example,dc=test", bindCredentialReference: "arn:aws:secretsmanager:us-east-1:111122223333:secret:ldap", syncGroups: true, groupBaseDn: "ou=groups,dc=example,dc=test"};
  capabilities.scim = {enabled: true, bearerCredentialHash: createHash("sha256").update(scimToken).digest("hex")};
  capabilities.security.malwareScanning = "required";
  capabilities.security.scannerWebhookId = "scanner";
  capabilities.security.scannerCredentialHash = createHash("sha256").update(scannerToken).digest("hex");
  capabilities.webhooks = [
    {id: "audit", name: "Audit webhook", url: "https://events.example.test/team-spaces", enabled: true, eventTypes: ["work.created"]},
    {id: "scanner", name: "Scanner", url: "https://scanner.example.test/jobs", enabled: true, eventTypes: ["document.scan-requested"]}
  ];
  await send(handler, "PATCH", "/api/v1/capabilities", capabilities);

  const ldap = await send(handler, "POST", "/api/v1/directory/sync", {source: "ldap", users: [{externalId: "directory-user-1", email: "directory.user@example.test", name: "Directory User", role: "viewer", groupIds: ["delivery"]}]});
  assert.equal(ldap.payload.data.synchronizedCount, 1);
  assert.deepEqual(ldap.payload.data.items[0].groupIds, ["delivery"]);

  const scimHeaders = {authorization: `Bearer ${scimToken}`, "x-teamspaces-account-id": "workspace-default", origin: "http://localhost:3000"};
  const provisioned = await send(handler, "POST", "/api/v1/scim/v2/Users", {externalId: "scim-user-1", userName: "scim.user@example.test", displayName: "SCIM User", active: true, role: "viewer"}, scimHeaders);
  assert.equal(provisioned.response.statusCode, 201);
  assert.equal(provisioned.payload.data.id, "scim-user-1");
  const scimList = await send(handler, "GET", "/api/v1/scim/v2/Users", undefined, scimHeaders);
  assert.equal(scimList.payload.data.Resources.some((item) => item.id === "scim-user-1"), true);
  const scimUserDetail = await send(handler, "GET", "/api/v1/scim/v2/Users/scim-user-1", undefined, scimHeaders);
  assert.equal(scimUserDetail.payload.data.userName, "scim.user@example.test");
  const scimUserFilter = await send(handler, "GET", "/api/v1/scim/v2/Users?filter=userName%20eq%20%22scim.user%40example.test%22", undefined, scimHeaders);
  assert.equal(scimUserFilter.payload.data.totalResults, 1);
  const group = await send(handler, "POST", "/api/v1/scim/v2/Groups", {
    externalId: "team-alpha",
    displayName: "Team Alpha",
    members: [{value: "scim-user-1"}]
  }, scimHeaders);
  assert.equal(group.response.statusCode, 201);
  assert.equal(group.payload.data.id, "scim-team-alpha");
  assert.deepEqual(group.payload.data.members.map((member) => member.value), ["scim-user-1"]);
  const patchedGroup = await send(handler, "PATCH", `/api/v1/scim/v2/Groups/${group.payload.data.id}`, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{op: "Add", path: "members", value: [{value: "user-product-engineer"}]}]
  }, scimHeaders);
  assert.deepEqual(patchedGroup.payload.data.members.map((member) => member.value).sort(), ["scim-user-1", "user-product-engineer"]);
  const scimGroups = await send(handler, "GET", "/api/v1/scim/v2/Groups", undefined, scimHeaders);
  assert.equal(scimGroups.payload.data.Resources.some((item) => item.displayName === "Team Alpha"), true);
  const deletedGroup = await send(handler, "DELETE", `/api/v1/scim/v2/Groups/${group.payload.data.id}`, undefined, scimHeaders);
  assert.equal(deletedGroup.response.statusCode, 204);
  assert.equal((await repository.listMemberships({workspaceId: "workspace-default"})).some((member) => member.groupIds?.includes(group.payload.data.id)), false);
  const invalidScim = await send(handler, "GET", "/api/v1/scim/v2/Users", undefined, {...scimHeaders, authorization: "Bearer incorrect"});
  assert.equal(invalidScim.response.statusCode, 401);

  const originalFetch = globalThis.fetch;
  const webhookEvents = [];
  globalThis.fetch = async (_url, request) => {
    webhookEvents.push(request.headers["x-team-spaces-event"]);
    return {ok: true, status: 202};
  };
  try {
    const delivery = await send(handler, "POST", "/api/v1/webhooks/audit/deliver", {eventType: "parity.checked", payload: {status: "ready"}});
    assert.equal(delivery.response.statusCode, 202);
    assert.equal(delivery.payload.data.status, "delivered");
    const webhookWork = await send(handler, "POST", "/api/v1/projects/project-pilot/work-items", {title: "Publish configured event", type: "task", status: "ready", priority: "medium"});
    assert.equal(webhookWork.response.statusCode, 201);
    assert.deepEqual(webhookEvents, ["parity.checked", "work.created"]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const intent = await send(handler, "POST", "/api/v1/documents/upload-intent", {projectId: "project-pilot", name: "Scanned evidence", filename: "evidence.txt", contentType: "text/plain", sizeBytes: 8, checksumSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", category: "evidence"});
  const scannerEvents = [];
  globalThis.fetch = async (_url, request) => {
    scannerEvents.push(request.headers["x-team-spaces-event"]);
    return {ok: true, status: 202};
  };
  const requestedScan = await send(handler, "POST", `/api/v1/documents/${intent.payload.data.documentId}/scan-request?projectId=project-pilot`, {});
  globalThis.fetch = originalFetch;
  assert.equal(requestedScan.response.statusCode, 202);
  assert.equal(requestedScan.payload.data.scanRequested, true);
  assert.match(requestedScan.payload.data.job.callbackPath, /\/scan\?projectId=project-pilot/);
  assert.deepEqual(scannerEvents, ["document.scan-requested"]);
  const blocked = await send(handler, "POST", "/api/v1/documents/finalize", {documentId: intent.payload.data.documentId, projectId: "project-pilot"});
  assert.equal(blocked.response.statusCode, 409);
  const scannerHeaders = {authorization: `Bearer ${scannerToken}`, "x-teamspaces-account-id": "workspace-default", origin: "http://localhost:3000"};
  const rejectedScan = await send(handler, "POST", `/api/v1/documents/${intent.payload.data.documentId}/scan?projectId=project-pilot`, {status: "clean", engine: "untrusted"}, {...scannerHeaders, authorization: "Bearer incorrect"});
  assert.equal(rejectedScan.response.statusCode, 401);
  const scanned = await send(handler, "POST", `/api/v1/documents/${intent.payload.data.documentId}/scan?projectId=project-pilot`, {status: "clean", engine: "clamav", extractedText: "Confidential readiness phrase for full text indexing"}, scannerHeaders);
  assert.equal(scanned.payload.data.scanStatus, "clean");
  assert.equal(scanned.payload.data.extractedText, undefined);
  assert.equal(scanned.payload.data.extractedTextIndexed, true);
  const attachmentSearch = await send(handler, "GET", "/api/v1/search?q=Confidential%20readiness%20phrase");
  assert.equal(attachmentSearch.payload.data.items.some((item) => item.id === intent.payload.data.documentId && item.matchedAttachmentContent), true);
  const finalized = await send(handler, "POST", "/api/v1/documents/finalize", {documentId: intent.payload.data.documentId, projectId: "project-pilot"});
  assert.equal(finalized.response.statusCode, 201);
  assert.equal(finalized.payload.data.extractedText, undefined);
  assert.equal(finalized.payload.data.extractedTextIndexed, true);
});

test("unauthenticated request is rejected when demo auth is disabled", async () => {
  const previous = process.env.ALLOW_DEMO_AUTH;
  process.env.ALLOW_DEMO_AUTH = "false";
  const handler = createHandler({repository: new MemoryRepository()});
  const {response} = await send(handler, "GET", "/api/v1/bootstrap", undefined, {
    "x-demo-user-id": undefined,
    "x-demo-user-email": undefined
  });
  assert.equal(response.statusCode, 401);
  process.env.ALLOW_DEMO_AUTH = previous;
});
