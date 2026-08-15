// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {createHandler} from "../src/handler.js";
import {MemoryRepository} from "../src/repositories/memory.js";

process.env.ALLOW_DEMO_AUTH = "true";
process.env.APP_ORIGIN = "http://localhost:3000";

function makeEvent(method, target, body, headers = {}) {
  const [rawPath, rawQueryString = ""] = target.split("?");
  return {
    rawPath,
    rawQueryString,
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

async function send(handler, method, target, body, headers) {
  const response = await handler(makeEvent(method, target, body, headers));
  return {
    response,
    payload: response.body ? JSON.parse(response.body) : undefined
  };
}

function meetingInput(overrides = {}) {
  return {
    projectId: "project-pilot",
    title: "Pilot review",
    description: "Review the pilot plan.",
    startsAt: "2026-08-20T14:00:00Z",
    endsAt: "2026-08-20T15:00:00Z",
    location: "Room 1",
    participantIds: ["user-delivery-lead"],
    agendaItems: [{
      id: "agenda-plan",
      title: "Delivery plan",
      durationMinutes: 30,
      presenterId: "user-delivery-lead",
      workItemIds: ["work-cognito"],
      notes: "Review dependencies",
      outcome: ""
    }],
    ...overrides
  };
}

test("meeting API creates, directly reads, paginates, patches, and records activity", async () => {
  const repository = new MemoryRepository();
  const handler = createHandler({repository});
  const first = await send(handler, "POST", "/api/v1/meetings", meetingInput());
  assert.equal(first.response.statusCode, 201);
  assert.equal(first.payload.data.status, "draft");
  assert.deepEqual(first.payload.data.participantIds, ["user-demo-admin", "user-delivery-lead"]);
  assert.equal(first.payload.data.version, 1);

  const second = await send(handler, "POST", "/api/v1/meetings", meetingInput({
    title: "Later pilot review",
    startsAt: "2026-08-21T14:00:00Z",
    endsAt: "2026-08-21T15:00:00Z",
    agendaItems: []
  }));
  assert.equal(second.response.statusCode, 201);

  const pageOne = await send(handler, "GET", "/api/v1/meetings?projectId=project-pilot&limit=1");
  assert.equal(pageOne.response.statusCode, 200);
  assert.equal(pageOne.payload.data.items.length, 1);
  assert.equal(pageOne.payload.data.items[0].id, first.payload.data.id);
  assert.equal(pageOne.payload.data.pageInfo.hasNextPage, true);
  const cursor = encodeURIComponent(pageOne.payload.data.pageInfo.endCursor);
  const pageTwo = await send(handler, "GET", `/api/v1/meetings?projectId=project-pilot&limit=1&cursor=${cursor}`);
  assert.equal(pageTwo.response.statusCode, 200);
  assert.equal(pageTwo.payload.data.items[0].id, second.payload.data.id);
  assert.equal(pageTwo.payload.data.pageInfo.hasNextPage, false);

  const detail = await send(handler, "GET", `/api/v1/meetings/${first.payload.data.id}?projectId=project-pilot`);
  assert.equal(detail.response.statusCode, 200);
  assert.equal(detail.payload.data.title, "Pilot review");

  const opened = await send(handler, "PATCH", `/api/v1/meetings/${first.payload.data.id}`, {
    projectId: "project-pilot",
    version: 1,
    status: "open"
  });
  assert.equal(opened.response.statusCode, 200);
  assert.equal(opened.payload.data.version, 2);
  assert.equal(opened.payload.data.status, "open");
  assert.equal(repository.activities.some((activity) => activity.entityType === "meeting" && activity.eventType === "meeting.updated"), true);

  const stale = await send(handler, "PATCH", `/api/v1/meetings/${first.payload.data.id}`, {
    projectId: "project-pilot",
    version: 1,
    title: "Stale title"
  });
  assert.equal(stale.response.statusCode, 409);
});

test("meeting create validates and replays scoped idempotency keys", async () => {
  const repository = new MemoryRepository();
  const handler = createHandler({repository});
  const invalid = await send(handler, "POST", "/api/v1/meetings", meetingInput(), {
    "idempotency-key": "bad key"
  });
  assert.equal(invalid.response.statusCode, 400);
  assert.match(invalid.payload.detail, /Idempotency-Key/);

  const headers = {"idempotency-key": "meeting.create:0001"};
  const created = await send(handler, "POST", "/api/v1/meetings", meetingInput(), headers);
  assert.equal(created.response.statusCode, 201);
  const replayed = await send(handler, "POST", "/api/v1/meetings", meetingInput({
    participantIds: ["user-demo-admin", "user-delivery-lead"]
  }), headers);
  assert.equal(replayed.response.statusCode, 201);
  assert.deepEqual(replayed.payload.data, created.payload.data);
  assert.equal(repository.meetings.size, 1);
  assert.equal(repository.activities.filter((activity) => activity.eventType === "meeting.created").length, 1);

  const mismatched = await send(handler, "POST", "/api/v1/meetings", meetingInput({title: "Different request"}), headers);
  assert.equal(mismatched.response.statusCode, 409);
  assert.match(mismatched.payload.detail, /different meeting request/);
  assert.equal(repository.meetings.size, 1);
  assert.equal(repository.activities.filter((activity) => activity.eventType === "meeting.created").length, 1);
});

test("meeting API rejects wrong-project reads, restricted projects, and cross-project task links", async () => {
  const repository = new MemoryRepository();
  const handler = createHandler({repository});
  const created = await send(handler, "POST", "/api/v1/meetings", meetingInput());
  assert.equal(created.response.statusCode, 201);

  const wrongProject = await send(handler, "GET", `/api/v1/meetings/${created.payload.data.id}?projectId=project-workspace-ux`);
  assert.equal(wrongProject.response.statusCode, 404);

  const invalidLink = await send(handler, "POST", "/api/v1/meetings", meetingInput({
    agendaItems: [{
      id: "agenda-cross-project",
      title: "Wrong task",
      workItemIds: ["work-planning-board"]
    }]
  }));
  assert.equal(invalidLink.response.statusCode, 400);
  assert.match(invalidLink.payload.detail, /belong to the meeting project/);

  const membership = repository.memberships.get("workspace-default:user-product-engineer");
  assert.ok(membership);
  membership.projectIds = ["project-workspace-ux"];
  const restrictedHeaders = {
    "x-demo-user-id": "user-product-engineer",
    "x-demo-user-email": "engineer@team-spaces.example",
    "x-demo-user-name": "Jordan Lee"
  };
  const restrictedList = await send(handler, "GET", "/api/v1/meetings?projectId=project-pilot", undefined, restrictedHeaders);
  assert.equal(restrictedList.response.statusCode, 404);
  const restrictedCreate = await send(handler, "POST", "/api/v1/meetings", meetingInput({participantIds: []}), restrictedHeaders);
  assert.equal(restrictedCreate.response.statusCode, 404);
});

test("meeting API validates active invitees, outcome windows, and terminal locks", async () => {
  const repository = new MemoryRepository();
  const invited = repository.memberships.get("workspace-default:user-delivery-lead");
  assert.ok(invited);
  invited.status = "invited";
  const handler = createHandler({repository});
  const inactiveParticipant = await send(handler, "POST", "/api/v1/meetings", meetingInput());
  assert.equal(inactiveParticipant.response.statusCode, 400);
  assert.match(inactiveParticipant.payload.detail, /active project members/);

  invited.status = "active";
  const created = await send(handler, "POST", "/api/v1/meetings", meetingInput());
  const id = created.payload.data.id;
  const opened = await send(handler, "PATCH", `/api/v1/meetings/${id}`, {
    projectId: "project-pilot",
    version: 1,
    status: "open"
  });
  assert.equal(opened.response.statusCode, 200);

  const outcomeAgenda = created.payload.data.agendaItems.map((item) => ({...item, outcome: "Proceed"}));
  const prematureOutcome = await send(handler, "PATCH", `/api/v1/meetings/${id}`, {
    projectId: "project-pilot",
    version: 2,
    agendaItems: outcomeAgenda
  });
  assert.equal(prematureOutcome.response.statusCode, 400);
  assert.match(prematureOutcome.payload.detail, /only while the meeting is in progress/);

  const facilitated = await send(handler, "PATCH", `/api/v1/meetings/${id}`, {
    projectId: "project-pilot",
    version: 2,
    status: "in-progress",
    agendaItems: outcomeAgenda,
    minutes: "The team agreed to proceed."
  });
  assert.equal(facilitated.response.statusCode, 200);
  assert.equal(facilitated.payload.data.version, 3);

  const closed = await send(handler, "PATCH", `/api/v1/meetings/${id}`, {
    projectId: "project-pilot",
    version: 3,
    status: "closed"
  });
  assert.equal(closed.response.statusCode, 200);
  const locked = await send(handler, "PATCH", `/api/v1/meetings/${id}`, {
    projectId: "project-pilot",
    version: 4,
    status: "open",
    title: "Cannot combine reopen and edit"
  });
  assert.equal(locked.response.statusCode, 400);
  assert.match(locked.payload.detail, /read-only/);
  const reopened = await send(handler, "PATCH", `/api/v1/meetings/${id}`, {
    projectId: "project-pilot",
    version: 4,
    status: "open"
  });
  assert.equal(reopened.response.statusCode, 200);
  assert.equal(reopened.payload.data.status, "open");
});

test("viewers can read project meetings but cannot mutate them", async () => {
  const repository = new MemoryRepository();
  const adminHandler = createHandler({repository});
  const created = await send(adminHandler, "POST", "/api/v1/meetings", meetingInput({participantIds: [], agendaItems: []}));
  assert.equal(created.response.statusCode, 201);
  const viewer = repository.memberships.get("workspace-default:user-product-engineer");
  assert.ok(viewer);
  viewer.role = "viewer";
  const headers = {
    "x-demo-user-id": "user-product-engineer",
    "x-demo-user-email": "engineer@team-spaces.example"
  };
  const listed = await send(adminHandler, "GET", "/api/v1/meetings?projectId=project-pilot", undefined, headers);
  assert.equal(listed.response.statusCode, 200);
  const denied = await send(adminHandler, "PATCH", `/api/v1/meetings/${created.payload.data.id}`, {
    projectId: "project-pilot",
    version: 1,
    status: "open"
  }, headers);
  assert.equal(denied.response.statusCode, 403);
});

test("another manager can update a meeting after its creator becomes inactive", async () => {
  const repository = new MemoryRepository();
  const handler = createHandler({repository});
  const created = await send(handler, "POST", "/api/v1/meetings", meetingInput());
  assert.equal(created.response.statusCode, 201);
  const creator = repository.memberships.get("workspace-default:user-demo-admin");
  assert.ok(creator);
  creator.status = "invited";
  const managerHeaders = {
    "x-demo-user-id": "user-delivery-lead",
    "x-demo-user-email": "delivery@team-spaces.example"
  };
  const updated = await send(handler, "PATCH", `/api/v1/meetings/${created.payload.data.id}`, {
    projectId: "project-pilot",
    version: 1,
    title: "Manager-owned follow-up"
  }, managerHeaders);
  assert.equal(updated.response.statusCode, 200);
  assert.equal(updated.payload.data.title, "Manager-owned follow-up");
  assert.equal(updated.payload.data.participantIds.includes("user-demo-admin"), true);
});

test("invited memberships cannot read or mutate meetings", async () => {
  const repository = new MemoryRepository();
  const handler = createHandler({repository});
  const created = await send(handler, "POST", "/api/v1/meetings", meetingInput());
  assert.equal(created.response.statusCode, 201);
  const invited = repository.memberships.get("workspace-default:user-delivery-lead");
  assert.ok(invited);
  invited.status = "invited";
  const invitedHeaders = {
    "x-demo-user-id": "user-delivery-lead",
    "x-demo-user-email": "delivery@team-spaces.example",
    "x-teamspaces-account-id": "workspace-default"
  };
  const detail = await send(handler, "GET", `/api/v1/meetings/${created.payload.data.id}?projectId=project-pilot`, undefined, invitedHeaders);
  assert.equal(detail.response.statusCode, 403);
  const update = await send(handler, "PATCH", `/api/v1/meetings/${created.payload.data.id}`, {
    projectId: "project-pilot",
    version: 1,
    title: "Invitation must not authorize"
  }, invitedHeaders);
  assert.equal(update.response.statusCode, 403);
});

test("encoded stable meeting IDs resolve inside the required project", async () => {
  const repository = new MemoryRepository();
  const handler = createHandler({repository});
  const created = await send(handler, "POST", "/api/v1/meetings", meetingInput());
  assert.equal(created.response.statusCode, 201);
  const originalKey = `project-pilot:${created.payload.data.id}`;
  const meeting = repository.meetings.get(originalKey);
  assert.ok(meeting);
  repository.meetings.delete(originalKey);
  meeting.id = "meeting:review";
  repository.meetings.set("project-pilot:meeting:review", meeting);
  const detail = await send(handler, "GET", "/api/v1/meetings/meeting%3Areview?projectId=project-pilot");
  assert.equal(detail.response.statusCode, 200);
  assert.equal(detail.payload.data.id, "meeting:review");
});
