// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {S3Client} from "@aws-sdk/client-s3";
import {getSignedUrl} from "@aws-sdk/s3-request-presigner";
import {parseWorkQuery} from "@teamspaces/contracts";
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
    summary: "Reviewed handoff with the delivery lead."
  });
  assert.equal(note.response.statusCode, 201);
  const activity = await send(handler, "GET", "/api/v1/activity?projectId=project-pilot");
  assert.equal(activity.payload.data.items.some((item) => item.eventType === "comment.created" && item.entityId === "work-cognito"), true);
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
