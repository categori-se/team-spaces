// @ts-nocheck

import assert from "node:assert/strict";
import test from "node:test";
import {JSDOM} from "jsdom";
import {coordinationDashboard, coordinationDelegateForm, coordinationTaskForm} from "../src/components/coordination.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {url: "http://127.0.0.1:3000/app/coordination"});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  location: dom.window.location,
  history: dom.window.history,
  localStorage: dom.window.localStorage,
  sessionStorage: dom.window.sessionStorage
});

function fixture() {
  return {
    schemaVersion: 1,
    initiativeId: "opengeo",
    title: "OpenGeo Studio",
    audience: "private",
    sample: false,
    roles: [
      {id: "ux", name: "UI / UX owner", responsibility: "Consolidate shared interactions."},
      {id: "review", name: "Workflow reviewer", responsibility: "Verify complete user journeys."}
    ],
    projects: [
      {id: "community", name: "OpenGeo Studio [community edition]", coordination: {initiativeId: "opengeo", facet: "community"}},
      {id: "internal", name: "OpenGeo Studio", coordination: {initiativeId: "opengeo", facet: "internal"}}
    ],
    tasks: [
      {id: "ux-task", projectId: "community", title: "Consolidate map controls", version: 2, status: "ready", priority: "high", blockedBy: [], acceptanceCriteria: "Map actions use consistent controls.", coordination: {roleId: "ux", acceptanceState: "pending", nextAction: "Compare control patterns", scopePaths: ["private/source/path"], sourceId: "private-source", taskKey: "private-key", evidence: [{label: "Review", url: "https://example.test/review"}], run: {id: "private-run", state: "succeeded", sourceRevision: "private-revision", updatedAt: "2026-10-15T12:00:00Z", url: "http://localhost:8080/private-run"}}},
      {id: "review-task", projectId: "community", title: "Review project reopening", version: 1, status: "done", priority: "medium", blockedBy: [], coordination: {roleId: "review", acceptanceState: "review", nextAction: "Review reopening evidence", evidence: []}},
      {id: "accepted-task", projectId: "community", title: "Review saving", version: 1, status: "done", priority: "medium", blockedBy: [], coordination: {roleId: "review", acceptanceState: "accepted", evidence: [{label: "Passed", url: "https://example.test/passed"}]}},
      {id: "internal-task", projectId: "internal", title: "Private customer workflow", version: 1, status: "in-progress", priority: "high", blockedBy: [], coordination: {dependencies: [{projectId: "community", taskId: "review-task"}], roleId: "ux", acceptanceState: "pending", decision: "Private decision", nextAction: "Private action", evidence: [], run: {id: "internal-run", state: "running", updatedAt: "2026-10-15T12:00:00Z"}}}
    ],
    summary: {total: 4, accepted: 1, running: 1, blocked: 1, review: 1, ready: 1}
  };
}

function mount(element) {
  document.body.replaceChildren(element);
  return element;
}

function metric(element, title) {
  return [...element.querySelectorAll(".metric")].find((item) => item.querySelector("span").textContent === title)?.querySelector("strong").textContent;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("private coordination distinguishes reviewed outcomes from runs and completed task status", () => {
  const board = mount(coordinationDashboard(fixture(), {isPublicDemo: false}));
  assert.equal(board.querySelectorAll(".coordination-lane").length, 2);
  assert.equal(metric(board, "Accepted outcomes"), "1");
  assert.equal(metric(board, "Awaiting review"), "1");
  assert.equal(metric(board, "Active attempts"), "1");
  assert.equal(metric(board, "Blocked"), "1");
  const pending = board.querySelector('[data-task-id="ux-task"]');
  assert.match(pending.textContent, /Acceptance pending/);
  assert.match(pending.textContent, /Latest attempt: Succeeded/);
  assert.match(pending.textContent, /private-revision/);
  assert.match(pending.textContent, /private\/source\/path/);
  assert.match(board.querySelector('[data-task-id="internal-task"]').textContent, /Review project reopening \(pending\)/);
  assert.equal(board.querySelector('a[href="/app/planning?projectId=community"]')?.textContent, "Open planning");
  assert.equal(board.querySelectorAll("form.coordination-task-form").length, 0, "viewers receive no edit controls");
  assert.equal(board.querySelector(".coordination-delegate-form"), null);
});

test("public coordination is read-only and defensively omits private data even from an unredacted payload", () => {
  const data = fixture();
  Object.assign(data, {audience: "public", sample: false, readOnly: true});
  data.tasks[0].coordination.parityIds = ["GEOLIBRE-001", "GEONODE-003"];
  data.tasks[0].coordination.dependencies = [{projectId: "internal", taskId: "internal-task"}];
  data.tasks[0].coordination.evidence[0].visibility = "public";
  data.tasks[0].title = "<img src=x onerror=alert(1)>";
  data.tasks[0].coordination.evidence.push(
    {label: "Unsafe", url: "javascript:alert(1)"},
    {label: "Local", url: "http://localhost:8080/private-evidence"},
    {label: "Credentials", url: "https://user:secret@example.test/private"}
  );
  const board = mount(coordinationDashboard(data, {isPublicCoordination: true}, {canManage: true, canEdit: true}));
  assert.match(board.textContent, /Read-only community roadmap/);
  assert.match(board.textContent, /OpenGeo Studio \[community edition\]/);
  assert.match(board.textContent, /GEOLIBRE-001, GEONODE-003/);
  assert.doesNotMatch(board.textContent, /Illustrative|sample|Public demo|dependency outcome/);
  assert.equal(metric(board, "Tasks"), "3");
  assert.equal(metric(board, "Active attempts"), undefined);
  assert.equal(board.querySelectorAll(".coordination-task").length, 3);
  assert.doesNotMatch(board.innerHTML, /Private customer workflow|Private decision|private-source|private-key|private-run|private-revision|private\/source\/path|internal-run|private-evidence|user:secret/);
  assert.equal(board.querySelector("img"), null);
  assert.match(board.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(board.querySelector('a[href="https://example.test/review"]')?.rel, "noopener noreferrer");
  assert.equal(board.querySelector('a[href^="javascript:"]'), null);
  assert.equal(board.querySelector('option[value="internal"]'), null);
  assert.equal(board.querySelector(".coordination-task-form"), null);
  assert.equal(board.querySelector(".coordination-delegate-form"), null);
  assert.equal(board.querySelector(".coordination-setup"), null);
  assert.equal([...board.querySelectorAll("button")].map((button) => button.textContent).join(), "Refresh progress");
  assert.equal(board.querySelector('a[href^="/app/planning"]'), null);
  assert.equal(board.querySelector(".coordination-project-sources"), null);
});

test("private project sources show canonical project names and recorded repository correspondence", () => {
  const data = fixture();
  data.projects[0].coordination.repository = {url: "https://github.com/categori-se/opengeo-community", branch: "main", visibility: "public"};
  data.projects[1].coordination.repository = {url: "https://github.com/categorise/opengeo", branch: "release/current", visibility: "private"};
  const board = mount(coordinationDashboard(data, {}));
  const sources = board.querySelector('[aria-label="Project sources"]');
  assert.match(sources.textContent, /OpenGeo Studio \[community edition\]/);
  assert.match(sources.textContent, /OpenGeo Studi[o]/);
  assert.match(sources.textContent, /mainPublic/);
  assert.match(sources.textContent, /release\/currentPrivate/);
  assert.equal(sources.querySelectorAll("a").length, 2);
  assert.equal(sources.querySelector('a[href="https://github.com/categori-se/opengeo-community"]')?.rel, "noopener noreferrer");
  assert.doesNotMatch(sources.textContent, /connected|synchronized|running/i);
});

test("facet and project filters update lanes and summary without requesting new work", () => {
  const board = mount(coordinationDashboard(fixture(), {isPublicDemo: false}));
  const facet = board.querySelector('[name="facet"]');
  const project = board.querySelector('[name="projectId"]');
  project.value = "community";
  project.dispatchEvent(new window.Event("change"));
  assert.equal(metric(board, "Tasks"), "3");
  facet.value = "internal";
  facet.dispatchEvent(new window.Event("change"));
  assert.equal(project.value, "", "a project outside the selected facet is cleared");
  assert.equal(project.querySelector('option[value="community"]'), null);
  assert.equal(board.querySelectorAll(".coordination-task").length, 1);
  assert.equal(metric(board, "Accepted outcomes"), "0");
  assert.equal(metric(board, "Blocked"), "1", "dependencies outside the active filter still resolve");
  assert.equal(metric(board, "Active attempts"), "1");
});

test("a done dependency still awaits explicit acceptance before dependent work is ready", () => {
  const data = fixture();
  data.tasks[0].blockedBy = ["review-task"];
  const board = mount(coordinationDashboard(data, {isPublicDemo: false}));
  assert.equal(metric(board, "Ready"), "0");
  assert.equal(metric(board, "Blocked"), "2");
  assert.match(board.querySelector('[data-task-id="ux-task"]').textContent, /dependency outcome awaits acceptance/);
});

test("intake and unclassified work remain backlog while decisions block readiness", () => {
  const data = fixture();
  data.tasks[0].status = "intake";
  data.tasks.push({id: "unclassified", projectId: "community", title: "Define the next slice", status: "awaiting-scope", coordination: {roleId: "ux", acceptanceState: "pending"}});
  data.tasks.push({id: "decision", projectId: "community", title: "Choose acceptance scope", status: "ready", coordination: {roleId: "ux", decision: "Choose the scoped journey", acceptanceState: "pending"}});
  const board = mount(coordinationDashboard(data, {}));
  assert.equal(metric(board, "Backlog"), "2");
  assert.equal(metric(board, "Ready"), "0");
  assert.equal(metric(board, "Blocked"), "2");
  assert.doesNotMatch(board.querySelector(".coordination-notice").textContent, /OpenGeo Studio \[community edition\]/);
});

test("recorded parity outcomes stay separate from accepted task outcomes", () => {
  const data = {...fixture(), parityBaseline: {pass: 24, partial: 25, exclusion: 1}};
  const board = mount(coordinationDashboard(data, {}));
  const baseline = board.querySelector('[aria-label="Recorded parity baseline"]');
  assert.equal(baseline.querySelector("h2").textContent, "Recorded parity baseline");
  assert.match(baseline.textContent, /tracked separately from task acceptance/);
  assert.equal(metric(baseline, "Pass"), "24");
  assert.equal(metric(baseline, "Partial"), "25");
  assert.equal(metric(baseline, "Exclusion"), "1");
  assert.equal(metric(board.querySelector(".coordination-metrics"), "Accepted outcomes"), "1");
  assert.equal(coordinationDashboard(fixture(), {}).querySelector(".coordination-parity-baseline"), null);
});

test("empty real coordination never creates starter work and refresh stays explicit", async () => {
  let refreshes = 0;
  const board = mount(coordinationDashboard({...fixture(), projects: [], tasks: []}, {
    isPublicDemo: false,
    coordination: {setup: async () => {throw new Error("Unexpected setup");}}
  }, {canManage: true, onRefresh: async () => {refreshes++; throw new Error("Refresh unavailable");}}));
  assert.match(board.textContent, /No coordination tasks are recorded/);
  assert.equal(board.querySelector(".coordination-setup"), null);
  assert.doesNotMatch(board.textContent, /starter|sample|demo/i);
  assert.equal(refreshes, 0);
  const refresh = [...board.querySelectorAll("button")].find((button) => button.textContent === "Refresh progress");
  refresh.click();
  await settle();
  assert.equal(refreshes, 1);
  assert.match(board.textContent, /Refresh unavailable/);
  assert.equal(refresh.disabled, false);
});

test("shared dependencies use both project and task identity and link only accessible tasks", () => {
  const data = fixture();
  data.tasks.push({...data.tasks[2], projectId: "internal", id: "review-task", title: "Unrelated accepted task"});
  data.tasks[0].coordination.dependencies = [{projectId: "community", taskId: "review-task"}, {projectId: "restricted-project", taskId: "secret-task"}];
  const board = mount(coordinationDashboard(data, {}));
  const card = board.querySelector('[data-task-id="ux-task"]');
  assert.match(card.textContent, /Review project reopening \(pending\)/);
  assert.match(card.textContent, /Restricted or unavailable task/);
  assert.doesNotMatch(card.textContent, /Unrelated accepted task|secret-task|restricted-project/);
  assert.equal(card.querySelector('a[href="/app/project?id=community#review-task"]')?.textContent, "Review project reopening (pending)");
  assert.match(card.textContent, /2 dependency outcomes await acceptance/);
});

test("public dependencies resolve only among projected community peers", () => {
  const data = fixture();
  Object.assign(data, {audience: "public", sample: false, readOnly: true});
  data.projects.push({id: "shared-community", name: "Shared community tools", coordination: {facet: "community"}});
  data.tasks.push({id: "shared-tool", projectId: "shared-community", title: "Complete shared save support", status: "ready", coordination: {roleId: "ux", acceptanceState: "pending"}});
  data.tasks[0].blockedBy = ["shared-tool", "hidden-task"];
  const board = mount(coordinationDashboard(data, {isPublicCoordination: true}));
  const card = board.querySelector('[data-task-id="ux-task"]');
  assert.match(card.textContent, /Complete shared save support \(pending\)/);
  assert.match(card.textContent, /1 dependency outcome awaits acceptance/);
  assert.doesNotMatch(card.textContent, /hidden-task|Restricted or unavailable/);
  assert.equal(card.querySelector('a[href^="/app/"]'), null);
});

test("coordination edits preserve execution metadata and task version while recording review evidence", async () => {
  const data = fixture();
  const task = data.tasks[0];
  task.coordination.evidence[0].visibility = "public";
  const calls = [];
  let saved = 0;
  const form = mount(coordinationTaskForm(task, {workItems: {patch: async (...args) => {
    calls.push(args);
    return {...task, version: 3};
  }}}, {roles: data.roles, onSaved: () => saved++}));
  form.elements.roleId.value = "review";
  form.elements.status.value = "done";
  form.elements.priority.value = "critical";
  form.elements.nextAction.value = " Publish accepted evidence ";
  form.elements.decision.value = "";
  form.elements.acceptanceState.value = "accepted";
  assert.equal(calls.length, 0);
  form.dispatchEvent(new window.Event("submit", {cancelable: true}));
  await settle();
  assert.equal(saved, 1);
  assert.equal(calls.length, 1);
  const [projectId, id, body] = calls[0];
  assert.equal(projectId, "community");
  assert.equal(id, "ux-task");
  assert.equal(body.version, 2);
  assert.equal(body.status, "done", "completion and acceptance can be submitted together");
  assert.equal(body.priority, "critical");
  assert.equal(body.coordination.roleId, "review");
  assert.equal(body.coordination.nextAction, "Publish accepted evidence");
  assert.equal(body.coordination.acceptanceState, "accepted");
  assert.deepEqual(body.coordination.run, task.coordination.run);
  assert.deepEqual(body.coordination.scopePaths, ["private/source/path"]);
  assert.equal(body.coordination.sourceId, "private-source");
  assert.equal(body.coordination.taskKey, "private-key");
  assert.deepEqual(body.coordination.evidence, [{label: "Review", url: "https://example.test/review", visibility: "public"}], "editing preserves an existing evidence publication choice");
});

test("acceptance requires completed work with safe evidence and reports conflicts", async () => {
  const data = fixture();
  const task = data.tasks[1];
  task.status = "ready";
  let patches = 0;
  const form = mount(coordinationTaskForm(task, {workItems: {patch: async () => {
    patches++;
    throw Object.assign(new Error("Conflict"), {status: 409});
  }}}, {roles: data.roles}));
  form.elements.acceptanceState.value = "accepted";
  form.dispatchEvent(new window.Event("submit", {cancelable: true}));
  await settle();
  assert.equal(patches, 0);
  assert.match(form.textContent, /Choose a completed task status/);
  [...form.querySelectorAll("button")].find((button) => button.textContent === "Add evidence link").click();
  form.querySelector('[name="evidenceLabel"]').value = "Evidence";
  form.querySelector('[name="evidenceUrl"]').value = "javascript:alert(1)";
  form.dispatchEvent(new window.Event("submit", {cancelable: true}));
  await settle();
  assert.equal(patches, 0);
  assert.match(form.textContent, /Each evidence link needs a label/);
  form.elements.status.value = "done";
  form.querySelector('[name="evidenceUrl"]').value = "http://localhost:8080/evidence";
  form.dispatchEvent(new window.Event("submit", {cancelable: true}));
  await settle();
  assert.equal(patches, 1);
  assert.match(form.textContent, /This task changed. Refresh before saving again/);
  assert.equal(form.querySelector('[type="submit"]').disabled, false);
});

test("delegation creates a role-owned outcome only on submit and prevents duplicate work", async () => {
  const data = fixture();
  const calls = [];
  let resolveCreate;
  let saved = 0;
  const form = mount(coordinationDelegateForm({workItems: {create: (...args) => {
    calls.push(args);
    return new Promise((resolve) => resolveCreate = resolve);
  }}}, {
    projects: data.projects,
    roles: data.roles,
    workConfiguration: {defaultTypeId: "task", defaultStatusId: "intake", statuses: [{id: "ready", active: true, closed: false}]},
    onSaved: () => saved++
  }));
  form.elements.projectId.value = "internal";
  form.elements.title.value = " Consolidate layer controls ";
  form.elements.roleId.value = "ux";
  form.elements.priority.value = "high";
  form.elements.acceptanceCriteria.value = " Layer actions have consistent labels and keyboard access. ";
  form.elements.nextAction.value = " Review the current layer controls ";
  assert.equal(calls.length, 0);
  form.dispatchEvent(new window.Event("submit", {cancelable: true}));
  form.dispatchEvent(new window.Event("submit", {cancelable: true}));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["internal", {
    title: "Consolidate layer controls",
    type: "task",
    status: "ready",
    priority: "high",
    acceptanceCriteria: "Layer actions have consistent labels and keyboard access.",
    coordination: {roleId: "ux", nextAction: "Review the current layer controls", decision: "", acceptanceState: "pending", scopePaths: [], evidence: []}
  }]);
  assert.equal(form.querySelector('[type="submit"]').disabled, true);
  resolveCreate({id: "new-task"});
  await settle();
  assert.equal(saved, 1);
  assert.equal(form.elements.title.value, "");
  assert.equal(form.querySelector('[type="submit"]').disabled, false);
  assert.match(form.textContent, /Delegated task created/);
});

test("delegation validates an outcome and reports API failure without losing the draft", async () => {
  const data = fixture();
  let creates = 0;
  const form = mount(coordinationDelegateForm({workItems: {create: async () => {
    creates++;
    throw new Error("Creation unavailable");
  }}}, {projects: data.projects, roles: data.roles}));
  form.dispatchEvent(new window.Event("submit", {cancelable: true}));
  await settle();
  assert.equal(creates, 0);
  assert.match(form.textContent, /describe the task outcome and acceptance criteria/);
  form.elements.title.value = "Review saving";
  form.elements.acceptanceCriteria.value = "Save and reopen the project.";
  form.dispatchEvent(new window.Event("submit", {cancelable: true}));
  await settle();
  assert.equal(creates, 1);
  assert.match(form.textContent, /Creation unavailable/);
  assert.equal(form.elements.title.value, "Review saving");
  assert.equal(form.querySelector('[type="submit"]').disabled, false);
  const manager = coordinationDashboard(data, {isPublicDemo: false}, {canEdit: true});
  assert.ok(manager.querySelector(".coordination-delegate-form"));
  assert.equal(manager.querySelectorAll(".coordination-task-form").length, 4);
});

test("coordination API uses isolated public requests without private headers and keeps setup explicit", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.__TEAMSPACES_LOCAL_CONFIG__ = {
    apiBaseUrl: "http://127.0.0.1:8787/api/v1",
    authMode: "cognito",
    appOrigin: "http://127.0.0.1:3000",
    publicDemo: {enabled: true, apiBaseUrl: "/api/v1/demo"}
  };
  globalThis.fetch = async (url, options) => {
    calls.push({url, options});
    return new Response(JSON.stringify({data: fixture()}), {status: 200, headers: {"content-type": "application/json"}});
  };
  localStorage.setItem("teamspaces.accountId", "private-account");
  sessionStorage.setItem("teamspaces.session", JSON.stringify({accessToken: "private-token", expiresAt: Date.now() + 900_000}));
  try {
    const {apiClient} = await import("../src/lib/api.js");
    const client = await apiClient();
    const controller = new AbortController();
    await client.coordination.get({initiativeId: "opengeo", signal: controller.signal});
    assert.equal(calls[0].url, "http://127.0.0.1:8787/api/v1/coordination?initiativeId=opengeo");
    assert.equal(calls[0].options.headers.authorization, "Bearer private-token");
    assert.equal(calls[0].options.signal, controller.signal);
    await client.coordination.setup({initiativeId: "opengeo", facet: "internal"});
    assert.equal(calls[1].options.method, "POST");
    assert.equal(calls[1].url, "http://127.0.0.1:8787/api/v1/coordination/setup");
    assert.deepEqual(JSON.parse(calls[1].options.body), {initiativeId: "opengeo", facet: "internal"});
    history.replaceState(null, "", "/app/coordination#public-demo-entry");
    const publicClient = await apiClient();
    await publicClient.coordination.get({initiativeId: "opengeo"});
    assert.equal(calls[2].url, "/api/v1/demo/coordination?initiativeId=opengeo");
    assert.equal(calls[2].options.headers.authorization, undefined);
    assert.equal(calls[2].options.headers["x-teamspaces-account-id"], undefined);
    assert.equal(calls[2].options.headers["x-demo-user-id"], undefined);
    assert.match(sessionStorage.getItem("teamspaces.session"), /private-token/, "public browsing preserves private login tokens");
    assert.equal(localStorage.getItem("teamspaces.accountId"), "private-account");
    const {signOut, currentSession} = await import("../src/lib/auth.js");
    globalThis.location = {href: "http://127.0.0.1:3000/app/coordination", hostname: "127.0.0.1", origin: "http://127.0.0.1:3000"};
    await signOut();
    assert.equal(globalThis.location.href, "/", "the existing Exit demo control returns to the landing page");
    assert.equal(sessionStorage.getItem("teamspaces.public-demo"), null);
    assert.match(sessionStorage.getItem("teamspaces.session"), /private-token/);
    assert.equal((await currentSession()).mode, "cognito", "exiting the demo restores the private session");
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.location = dom.window.location;
    delete globalThis.__TEAMSPACES_LOCAL_CONFIG__;
    delete globalThis[Symbol.for("teamspaces.auth.callback-promise")];
    sessionStorage.clear();
    localStorage.clear();
  }
});

test("public project source links require explicit public visibility and hide private board addresses", () => {
  const data=fixture();
  data.projects[0].coordination.repository={url:"https://github.com/core/community",visibility:"public"};
  data.projects[0].coordination.githubProject={url:"https://github.com/orgs/core/projects/2",visibility:"public"};
  data.projects[1].coordination.githubProject={url:"https://github.com/users/private/projects/1",visibility:"private"};
  const board=mount(coordinationDashboard({...data,audience:"public",readOnly:true},{isPublicCoordination:true}));
  const sources=board.querySelector('[aria-label="Project sources"]');
  assert.equal(sources.querySelector('a[href="https://github.com/orgs/core/projects/2"]')?.textContent,"Open GitHub board");
  assert.doesNotMatch(sources.innerHTML,/users\/private|Branch|Repository visibility/);
  data.projects[0].coordination.githubProject.visibility="private";
  const restricted=mount(coordinationDashboard({...data,audience:"public",readOnly:true},{isPublicCoordination:true}));
  assert.ok(!restricted.innerHTML.includes("orgs/core/projects/2"));
});

test("named historical parity remains separate from current accepted work", () => {
  const board=mount(coordinationDashboard({...fixture(),parityBaseline:{pass:39,partial:0,exclusion:3,reference:"Reference PM 17.7.2 — local source/test baseline"}},{}));
  const baseline=board.querySelector('[aria-label="Recorded parity baseline"]');
  assert.match(baseline.textContent,/Reference PM 17.7.2/);
  assert.match(baseline.textContent,/separately from task acceptance/);
  assert.equal(metric(board,"Accepted outcomes"),"1");
});
