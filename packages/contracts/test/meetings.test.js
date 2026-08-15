// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMeetingTransition,
  assertMeetingUpdate,
  ContractValidationError,
  maxMeetingPayloadBytes,
  parseMeetingInput,
  parseMeetingPatchInput,
  parseMeetingQuery,
  permissions,
  rolePermissions,
  roles
} from "../src/index.js";

function draftMeeting() {
  return {
    id: "meeting-one",
    workspaceId: "workspace-one",
    projectId: "project-one",
    title: "Delivery review",
    description: "Review the delivery plan.",
    startsAt: "2026-08-20T14:00:00.000Z",
    endsAt: "2026-08-20T15:00:00.000Z",
    status: "draft",
    location: "https://meet.example.test/delivery",
    participantIds: ["user-one"],
    agendaItems: [{
      id: "agenda-one",
      title: "Plan",
      durationMinutes: 30,
      presenterId: "user-one",
      workItemIds: ["work-one"],
      notes: "",
      outcome: ""
    }],
    minutes: "",
    createdBy: "user-one",
    version: 1
  };
}

test("parses bounded draft meetings and normalizes chronological timestamps", () => {
  const meeting = parseMeetingInput({
    projectId: "project-one",
    title: " Delivery review ",
    startsAt: "2026-08-20T10:00:00-04:00",
    endsAt: "2026-08-20T11:00:00-04:00",
    location: "Room 1",
    participantIds: ["user-one"],
    agendaItems: [{
      id: "agenda-one",
      title: "Plan",
      workItemIds: ["work-one"]
    }]
  });
  assert.equal(meeting.status, "draft");
  assert.equal(meeting.title, "Delivery review");
  assert.equal(meeting.startsAt, "2026-08-20T14:00:00.000Z");
  assert.equal(meeting.endsAt, "2026-08-20T15:00:00.000Z");
  assert.equal(meeting.agendaItems[0].durationMinutes, 0);
});

test("rejects invalid meeting schedules, duplicate references, unsafe URLs, and draft outcomes", () => {
  const base = {
    projectId: "project-one",
    title: "Review",
    startsAt: "2026-08-20T15:00:00Z",
    endsAt: "2026-08-20T14:00:00Z"
  };
  assert.throws(() => parseMeetingInput(base), /endsAt must be after/);
  assert.throws(() => parseMeetingInput({...base, endsAt: "2026-08-20T16:00:00Z", participantIds: ["user-one", "user-one"]}), /participantIds must be unique/);
  assert.throws(() => parseMeetingInput({...base, endsAt: "2026-08-20T16:00:00Z", location: "ftp://example.test/review"}), /HTTP or HTTPS/);
  assert.throws(() => parseMeetingInput({
    ...base,
    endsAt: "2026-08-20T16:00:00Z",
    agendaItems: [
      {id: "agenda-one", title: "One", workItemIds: ["work-one"]},
      {id: "agenda-two", title: "Two", workItemIds: ["work-one"]}
    ]
  }), /links must be unique/);
  assert.throws(() => parseMeetingInput({...base, endsAt: "2026-08-20T16:00:00Z", minutes: "Already decided"}), /Draft meetings cannot contain/);
  assert.throws(() => parseMeetingInput({...base, endsAt: "2026-08-20T16:00:00Z", status: "open"}), /must start in draft/);
  assert.throws(() => parseMeetingInput({
    ...base,
    endsAt: "2026-08-20T16:00:00Z",
    description: "d".repeat(20000),
    agendaItems: [
      {id: "agenda-large-one", title: "Large one", notes: "n".repeat(7000)},
      {id: "agenda-large-two", title: "Large two", notes: "n".repeat(7000)}
    ]
  }), new RegExp(String(maxMeetingPayloadBytes)));
});

test("parses query-bound meeting pages and versioned patches", () => {
  assert.deepEqual(parseMeetingQuery({projectId: "project-one", limit: "10", cursor: "opaque"}), {
    version: 1,
    projectId: "project-one",
    limit: 10,
    cursor: "opaque"
  });
  assert.deepEqual(parseMeetingPatchInput({projectId: "project-one", version: 3, status: "open"}), {
    projectId: "project-one",
    version: 3,
    status: "open"
  });
  assert.throws(() => parseMeetingQuery({limit: "10"}), /projectId is required/);
  assert.throws(() => parseMeetingPatchInput({projectId: "project-one", version: 3}), /field to update/);
});

test("enforces forward lifecycle, locked terminal states, and in-progress outcome windows", () => {
  assert.doesNotThrow(() => assertMeetingTransition("open", "closed"));
  assert.doesNotThrow(() => assertMeetingTransition("in-progress", "open"));
  assert.throws(() => assertMeetingTransition("open", "draft"), /not allowed/);

  const currentOpen = {...draftMeeting(), status: "open"};
  assert.doesNotThrow(() => assertMeetingUpdate(
    currentOpen,
    {...currentOpen, agendaItems: [...currentOpen.agendaItems, {
      id: "agenda-two",
      title: "Risks",
      durationMinutes: 10,
      workItemIds: [],
      notes: "",
      outcome: ""
    }]},
    {agendaItems: [...currentOpen.agendaItems, {
      id: "agenda-two",
      title: "Risks",
      durationMinutes: 10,
      workItemIds: [],
      notes: "",
      outcome: ""
    }]}
  ));
  const outcomeAgenda = currentOpen.agendaItems.map((item) => ({...item, outcome: "Approved"}));
  assert.throws(
    () => assertMeetingUpdate(currentOpen, {...currentOpen, agendaItems: outcomeAgenda}, {agendaItems: outcomeAgenda}),
    /only while the meeting is in progress/
  );
  assert.doesNotThrow(() => assertMeetingUpdate(
    currentOpen,
    {...currentOpen, status: "in-progress", agendaItems: outcomeAgenda},
    {status: "in-progress", agendaItems: outcomeAgenda}
  ));

  const closed = {...currentOpen, status: "closed"};
  assert.doesNotThrow(() => assertMeetingUpdate(closed, {...closed, status: "open"}, {status: "open"}));
  assert.throws(() => assertMeetingUpdate(closed, {...closed, status: "open", title: "Changed"}, {status: "open", title: "Changed"}), /read-only/);
  const cancelled = {...currentOpen, status: "cancelled"};
  assert.throws(() => assertMeetingUpdate(cancelled, {...cancelled, title: "Changed"}, {title: "Changed"}), /read-only/);
});

test("meeting management is additive for contributors but excluded from viewers", () => {
  assert.equal(rolePermissions[roles.admin].includes(permissions.meetingManage), true);
  assert.equal(rolePermissions[roles.portfolioManager].includes(permissions.meetingManage), true);
  assert.equal(rolePermissions[roles.projectManager].includes(permissions.meetingManage), true);
  assert.equal(rolePermissions[roles.member].includes(permissions.meetingManage), true);
  assert.equal(rolePermissions[roles.viewer].includes(permissions.meetingManage), false);
  assert.throws(() => parseMeetingInput(null), (error) => error instanceof ContractValidationError);
});
