// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {maxMeetingPayloadBytes as contractMeetingPayloadBytes} from "@teamspaces/contracts";
import {maxMeetingPayloadBytes, meetingMutationPayload, meetingPatchPayload} from "../src/components/ui.js";
import {meetingDetailPath, meetingListPath} from "../src/lib/api.js";

const baseMeeting = {
  projectId: "project-alpha",
  title: " Delivery review ",
  description: " Review launch readiness ",
  startsAt: "2026-08-18T13:00:00-04:00",
  endsAt: "2026-08-18T14:00:00-04:00",
  status: "draft",
  location: "Room 4",
  participantIds: ["user-one", "user-two"],
  minutes: ""
};

test("meeting payload normalizes dates and keeps agenda links inside the selected project", () => {
  const result = meetingMutationPayload(baseMeeting, [{
    id: "agenda-one",
    title: " Launch decision ",
    durationMinutes: "20",
    presenterId: "user-two",
    workItemIds: ["work-alpha"],
    notes: " Review evidence ",
    outcome: ""
  }], {allowedWorkItemIds: ["work-alpha", "work-beta"]});

  assert.deepEqual(result, {
    projectId: "project-alpha",
    title: "Delivery review",
    description: "Review launch readiness",
    startsAt: "2026-08-18T17:00:00.000Z",
    endsAt: "2026-08-18T18:00:00.000Z",
    status: "draft",
    location: "Room 4",
    participantIds: ["user-one", "user-two"],
    agendaItems: [{
      id: "agenda-one",
      title: "Launch decision",
      durationMinutes: 20,
      presenterId: "user-two",
      workItemIds: ["work-alpha"],
      notes: "Review evidence",
      outcome: ""
    }],
    minutes: ""
  });
});

test("meeting payload rejects invalid schedules and cross-project or duplicate task links", () => {
  assert.equal(maxMeetingPayloadBytes, contractMeetingPayloadBytes);
  assert.throws(
    () => meetingMutationPayload({...baseMeeting, endsAt: baseMeeting.startsAt}, []),
    /end must be after/
  );
  assert.throws(
    () => meetingMutationPayload(baseMeeting, [{id: "agenda-one", title: "Review", durationMinutes: 10, workItemIds: ["work-other"]}], {allowedWorkItemIds: ["work-alpha"]}),
    /outside this project/
  );
  assert.throws(
    () => meetingMutationPayload(baseMeeting, [
      {id: "agenda-one", title: "First", durationMinutes: 10, workItemIds: ["work-alpha"]},
      {id: "agenda-two", title: "Second", durationMinutes: 10, workItemIds: ["work-alpha"]}
    ], {allowedWorkItemIds: ["work-alpha"]}),
    /linked only once/
  );
  assert.throws(
    () => meetingMutationPayload(baseMeeting, [{id: "agenda-one", title: "Review", durationMinutes: 10, presenterId: "user-three"}]),
    /presenter must also be selected/
  );
  assert.throws(
    () => meetingMutationPayload({...baseMeeting, description: "d".repeat(20000)}, [
      {id: "agenda-large-one", title: "Large one", notes: "n".repeat(7000)},
      {id: "agenda-large-two", title: "Large two", notes: "n".repeat(7000)}
    ]),
    /32 KiB/
  );
});

test("meeting API paths always carry an explicit project scope and bounded cursor", () => {
  assert.equal(
    meetingListPath("project:alpha", {limit: 20, cursor: "next/page+1"}),
    "/meetings?projectId=project%3Aalpha&limit=20&cursor=next%2Fpage%2B1"
  );
  assert.equal(
    meetingDetailPath("project:alpha", "meeting:review"),
    "/meetings/meeting%3Areview?projectId=project%3Aalpha"
  );
  assert.throws(() => meetingListPath(""), /project is required/i);
});

test("meeting edits emit only changed fields and preserve historical reference ordering", () => {
  const current = {
    ...baseMeeting,
    startsAt: "2026-08-18T17:00:00.123Z",
    endsAt: "2026-08-18T18:00:00.456Z",
    version: 7,
    participantIds: ["user-two", "user-one"],
    agendaItems: [{
      id: "agenda-one",
      title: "Launch decision",
      durationMinutes: 20,
      workItemIds: ["work-beta", "work-alpha"],
      notes: "Review evidence",
      outcome: ""
    }]
  };
  const normalized = {
    ...current,
    participantIds: ["user-one", "user-two"],
    agendaItems: [{
      ...current.agendaItems[0],
      presenterId: "",
      workItemIds: ["work-alpha", "work-beta"]
    }]
  };
  assert.deepEqual(meetingPatchPayload(current, normalized), {
    projectId: "project-alpha",
    version: 7
  });
  assert.deepEqual(meetingPatchPayload(current, {...normalized, title: "Updated review"}), {
    projectId: "project-alpha",
    version: 7,
    title: "Updated review"
  });
});
