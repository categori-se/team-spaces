// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {JSDOM} from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://127.0.0.1:3000/app?demo=1"
});

Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  Element: dom.window.Element,
  location: dom.window.location,
  history: dom.window.history,
  localStorage: dom.window.localStorage,
  sessionStorage: dom.window.sessionStorage,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  __TEAMSPACES_LOCAL_CONFIG__: {
    apiBaseUrl: "http://127.0.0.1:8787/api/v1",
    authMode: "cognito",
    appOrigin: "http://127.0.0.1:3000",
    cognito: {
      domain: "https://auth.example.test",
      clientId: "client-id",
      redirectUri: "http://127.0.0.1:3000/app"
    },
    publicDemo: {
      enabled: true,
      apiBaseUrl: "/api/v1/demo",
      resetsAt: "05:00 UTC"
    }
  }
});

const {activityList, documentsTable, documentWorkspace, meetingDetailView, publicDemoUploadNotice, publicDemoTeamOverview, workConfigurationSummary, workPackageDetails, workspaceTopNav} = await import("../src/components/ui.js");

function settleSessionControls() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("public demo navigation is clearly disclosed and omits sensitive or unavailable actions", async () => {
  const bar = workspaceTopNav();
  document.body.append(bar);
  await settleSessionControls();
  await settleSessionControls();

  const notice = bar.querySelector(".public-demo-notice");
  assert.ok(notice);
  assert.equal(notice.getAttribute("role"), "note");
  assert.match(notice.textContent, /Shared public demo/);
  assert.match(notice.textContent, /05:00 UTC/);
  assert.match(notice.textContent, /Do not enter sensitive or personal information/);

  const status = bar.querySelector("[data-auth-status='public-demo']");
  assert.ok(status);
  assert.match(status.textContent, /Public demo/);
  assert.match(status.textContent, /Resets at 05:00 UTC/);
  assert.equal([...bar.querySelectorAll("button")].some((button) => button.textContent === "Exit demo"), true);

  const createText = bar.querySelector("[data-header-menu='create'] .header-menu__panel").textContent;
  assert.match(createText, /Project/);
  assert.doesNotMatch(createText, /Document/);

  const manageText = bar.querySelector("[data-header-menu='manage'] .header-menu__panel").textContent;
  assert.match(manageText, /Workflows/);
  assert.doesNotMatch(manageText, /Accounts/);
  assert.doesNotMatch(manageText, /Security & secrets/);
  assert.doesNotMatch(manageText, /Profile and account configuration/);

  const accountText = bar.querySelector("[data-header-menu='account'] .header-menu__panel").textContent;
  assert.match(accountText, /Demo Visitor/);
  assert.match(accountText, /Five fictional members/);
  assert.match(accountText, /Workflow columns/);
  assert.doesNotMatch(accountText, /Account settings/);
  assert.doesNotMatch(accountText, /Security & secrets/);
});

test("public demo documents explain the file-transfer boundary without hiding metadata exploration", () => {
  const notice = publicDemoUploadNotice();
  assert.equal(notice.getAttribute("role"), "note");
  assert.match(notice.textContent, /file transfers are off/i);
  assert.match(notice.textContent, /edit metadata/);
  assert.match(notice.textContent, /archive or restore/);
  assert.match(notice.textContent, /upload and download/);
});

test("public demo document and task views omit upload and download actions", () => {
  const client = {
    isPublicDemo: true,
    documents: {
      patch: async () => undefined
    }
  };
  const workItem = {
    id: "work-demo",
    projectId: "project-demo",
    title: "Prepare launch review",
    status: "active",
    type: "task",
    version: 1
  };
  const document = {
    id: "document-demo",
    projectId: "project-demo",
    workItemId: workItem.id,
    name: "Launch decision log",
    filename: "launch-decisions.md",
    category: "decision",
    status: "ready",
    sizeBytes: 1400,
    sampleOnly: true,
    samplePreview: "DECISION RECORD\nUse the simplified launch path.\nOwner: Demo Visitor",
    version: 1
  };

  const table = documentsTable([document], client, {workItems: [workItem]});
  assert.doesNotMatch(table.textContent, /Download/);
  assert.match(table.textContent, /Archive/);

  const library = documentWorkspace([document], client, {
    projects: [{id: "project-demo", name: "Pilot Readiness"}],
    workItems: [workItem]
  });
  assert.doesNotMatch(library.textContent, /Download/);
  assert.match(library.textContent, /Sample record/i);
  assert.match(library.textContent, /Preview sample content/);
  assert.match(library.textContent, /Use the simplified launch path/);
  assert.match(library.textContent, /Edit details/);
  assert.match(library.textContent, /Archive/);

  const details = workPackageDetails([workItem], client);
  assert.doesNotMatch(details.textContent, /Attach document/);
  assert.match(details.textContent, /file transfers are off/i);
});

test("public demo meeting detail demonstrates lifecycle, decisions, and named follow-ups", () => {
  const client = {meetings: {patch: async () => undefined}};
  const memberships = [
    {userId: "avery", name: "Avery Chen"},
    {userId: "jordan", name: "Jordan Lee"}
  ];
  const workItems = [{
    id: "analytics",
    projectId: "onboarding",
    title: "Define activation analytics events",
    status: "ready",
    assigneeId: "jordan",
    assigneeName: "Jordan Lee",
    dueDate: "2026-08-27"
  }];
  const view = meetingDetailView({
    id: "meeting-one",
    projectId: "onboarding",
    title: "Activation design stand-up",
    status: "in-progress",
    participantIds: ["avery", "jordan"],
    agendaItems: [{
      id: "measurement",
      title: "Measurement plan",
      presenterId: "jordan",
      durationMinutes: 15,
      notes: "Agree on the activation signal.",
      outcome: "Track profile completion and first key action.",
      workItemIds: ["analytics"]
    }],
    minutes: "Jordan owns the analytics follow-up."
  }, client, {memberships, workItems, canManage: true});

  assert.equal(view.querySelector(".meeting-lifecycle [aria-current='step']")?.textContent, "In progress");
  assert.match(view.textContent, /Decision \/ outcome/);
  assert.match(view.textContent, /Track profile completion/);
  assert.match(view.textContent, /Linked follow-ups/);
  assert.match(view.textContent, /Jordan Lee/);
  assert.match(view.textContent, /Due 2026-08-27/);
  assert.equal(view.querySelector(".meeting-followup a")?.getAttribute("href"), "/app/project?id=onboarding#analytics");
});

test("public demo settings summaries connect people to assignments and explain the workflow", () => {
  const team = publicDemoTeamOverview([
    {userId: "visitor", name: "Demo Visitor", title: "Demo visitor", role: "workspace-admin"},
    {userId: "avery", name: "Avery Chen", title: "Product designer", role: "member", projectIds: ["onboarding"]}
  ], [{id: "onboarding", name: "Mobile onboarding refresh"}], [{
    id: "prototype",
    projectId: "onboarding",
    title: "Prototype progressive profile setup",
    status: "in-progress",
    assigneeId: "avery"
  }]);
  assert.match(team.textContent, /Who is doing what/);
  assert.match(team.textContent, /Mobile onboarding refresh/);
  assert.match(team.textContent, /1 open assignment/);
  assert.equal(team.querySelector("a")?.getAttribute("href"), "/app/project?id=onboarding#prototype");

  const workflow = workConfigurationSummary({
    defaultTypeId: "task",
    defaultStatusId: "intake",
    types: [{id: "task", label: "Task", active: true}, {id: "risk", label: "Risk", active: true}],
    statuses: [
      {id: "intake", label: "Intake", active: true, closed: false},
      {id: "done", label: "Done", active: true, closed: true}
    ],
    transitions: [{fromStatusId: "intake", toStatusId: "done"}]
  });
  assert.match(workflow.textContent, /Current workflow/);
  assert.match(workflow.textContent, /Intake/);
  assert.match(workflow.textContent, /Initial/);
  assert.match(workflow.textContent, /Completed/);
  assert.match(workflow.textContent, /1 transition/);

  const activity = activityList([{
    timestamp: "2026-08-14T16:30:00.000Z",
    actorName: "Avery Chen",
    projectId: "onboarding",
    entityType: "meeting",
    entityId: "activation-review",
    eventType: "meeting.updated",
    summary: "Captured decisions and assigned follow-ups",
    changedFields: ["agendaItems", "minutes"]
  }]);
  assert.match(activity.textContent, /Meeting Updated/);
  assert.match(activity.textContent, /Changed: Agenda Items, Minutes/);
  assert.equal(activity.querySelector("a")?.getAttribute("href"), "/app/meetings?projectId=onboarding&meetingId=activation-review");
});
