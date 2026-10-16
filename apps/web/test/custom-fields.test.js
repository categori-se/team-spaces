// @ts-nocheck

import assert from "node:assert/strict";
import test from "node:test";
import {JSDOM} from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {url: "http://127.0.0.1:3000/app/time"});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  Element: dom.window.Element,
  FormData: dom.window.FormData,
  location: dom.window.location
});

const {planningResourceForm, profileForm, teamManagementPanel, timeEntryForm} = await import("../src/components/ui.js");

const capabilities = {
  timeEntryActivities: [{id: "research", name: "Research", active: true}],
  customFields: [
    {id: "billing-code", name: "Billing code", type: "string", entityType: "time-entry", required: true},
    {id: "release-link", name: "Release link", type: "link", entityType: "version", required: true},
    {id: "release-reviewers", name: "Release reviewers", type: "user", entityType: "version", multiSelect: true},
    {id: "clearance", name: "Clearance", type: "select", entityType: "user", required: true, options: [{id: "standard", name: "Standard"}, {id: "restricted", name: "Restricted"}]}
  ]
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("time entry form renders activity and configured fields and serializes typed values", async () => {
  const saved = [];
  const form = timeEntryForm({timeEntries: {create: async (body) => saved.push(body)}}, [{id: "project-one", name: "Project one"}], {capabilities});
  document.body.replaceChildren(form);
  assert.equal(form.querySelector("select[name='activityId']")?.value, "research");
  form.querySelector("input[name='custom__billing-code']").value = "R-42";
  form.dispatchEvent(new window.Event("submit", {bubbles: true, cancelable: true}));
  await settle();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].activityId, "research");
  assert.equal(saved[0].durationMinutes, 30);
  assert.deepEqual(saved[0].customFields, {"billing-code": "R-42"});
  assert.equal(Object.hasOwn(saved[0], "custom__billing-code"), false);
});

test("version form exposes configured fields only for versions and serializes them", async () => {
  const saved = [];
  const form = planningResourceForm({planningResources: {create: async (body) => (saved.push(body), {...body, id: "version-one"})}}, {id: "project-one"}, [{id: "project-one", name: "Project one"}], {capabilities});
  document.body.replaceChildren(form);
  const kind = form.querySelector("select[name='kind']");
  const releaseLink = form.querySelector("input[name='custom__release-link']");
  assert.equal(releaseLink.disabled, true);
  kind.value = "version";
  kind.dispatchEvent(new window.Event("change"));
  assert.equal(releaseLink.disabled, false);
  form.querySelector("input[name='name']").value = "Release 2";
  releaseLink.value = "https://example.test/releases/2";
  form.querySelector("input[name='custom__release-reviewers']").value = "user-one, user-two";
  form.dispatchEvent(new window.Event("submit", {bubbles: true, cancelable: true}));
  await settle();
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].customFields, {"release-link": "https://example.test/releases/2", "release-reviewers": ["user-one", "user-two"]});
});

test("profile and member administration preserve configured user fields", async () => {
  const profilePatches = [];
  const profile = profileForm({profile: {patch: async (body) => profilePatches.push(body)}}, {
    user: {name: "Avery"},
    membership: {customFields: {clearance: "standard"}}
  }, {capabilities});
  document.body.replaceChildren(profile);
  profile.querySelector("select[name='custom__clearance']").value = "restricted";
  profile.dispatchEvent(new window.Event("submit", {bubbles: true, cancelable: true}));
  await settle();
  assert.deepEqual(profilePatches[0].customFields, {clearance: "restricted"});

  const members = [];
  const panel = teamManagementPanel({memberships: {create: async (body) => members.push(body)}}, [], [], {capabilities});
  document.body.replaceChildren(panel);
  const memberForm = panel.querySelector(".team-add-member form");
  memberForm.querySelector("input[name='email']").value = "person@example.test";
  memberForm.querySelector("input[name='name']").value = "Person";
  memberForm.querySelector("select[name='custom__clearance']").value = "standard";
  memberForm.dispatchEvent(new window.Event("submit", {bubbles: true, cancelable: true}));
  await settle();
  assert.deepEqual(members[0].customFields, {clearance: "standard"});
});
