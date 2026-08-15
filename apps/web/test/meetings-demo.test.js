// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {meetingTourMeetingId, meetingTourProjectId} from "../src/lib/public-demo-tour.js";

test("public demo meeting tour prefers mobile onboarding, then watch health, then list order", () => {
  const projects = [
    {id: "launch", name: "Customer portal", health: "watch"},
    {id: "mobile-onboarding", name: "Mobile onboarding refresh", health: "on-track"},
    {id: "compliance", name: "SOC 2 readiness", health: "at-risk"}
  ];

  assert.equal(meetingTourProjectId(projects, {isPublicDemo: true}), "mobile-onboarding");
  assert.equal(meetingTourProjectId(projects.slice(0, 1), {isPublicDemo: true}), "launch");
  assert.equal(meetingTourProjectId(projects.slice(2), {isPublicDemo: true}), "compliance");
});

test("explicit project links win and authenticated visitors retain project selection behavior", () => {
  const projects = [{id: "mobile-onboarding", name: "Mobile onboarding refresh", health: "on-track"}];

  assert.equal(meetingTourProjectId(projects, {
    requestedProjectId: "deep-linked-project",
    isPublicDemo: true
  }), "deep-linked-project");
  assert.equal(meetingTourProjectId(projects, {isPublicDemo: false}), "");
});

test("public demo meeting tour prefers live work, then recorded decisions, then open meetings", () => {
  const open = {id: "open", status: "open", minutes: "", agendaItems: []};
  const decided = {id: "decided", status: "closed", minutes: "Decision recorded", agendaItems: []};
  const live = {id: "live", status: "in_progress", minutes: "", agendaItems: []};

  assert.equal(meetingTourMeetingId([open, decided, live], {isPublicDemo: true}), "live");
  assert.equal(meetingTourMeetingId([open, decided], {isPublicDemo: true}), "decided");
  assert.equal(meetingTourMeetingId([open], {isPublicDemo: true}), "open");
  assert.equal(meetingTourMeetingId([{id: "draft", status: "draft"}], {isPublicDemo: true}), "draft");
});

test("agenda outcomes count as records while explicit meetings and creation links remain authoritative", () => {
  const meetings = [
    {id: "open", status: "open"},
    {id: "outcome", status: "closed", agendaItems: [{outcome: "Ship the simplified flow."}]}
  ];

  assert.equal(meetingTourMeetingId(meetings, {isPublicDemo: true}), "outcome");
  assert.equal(meetingTourMeetingId(meetings, {
    requestedMeetingId: "deep-linked-meeting",
    isPublicDemo: true,
    newMeetingRequested: true
  }), "deep-linked-meeting");
  assert.equal(meetingTourMeetingId(meetings, {
    isPublicDemo: true,
    newMeetingRequested: true
  }), "");
  assert.equal(meetingTourMeetingId(meetings, {isPublicDemo: false}), "");
});
