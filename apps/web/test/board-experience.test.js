// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {JSDOM} from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://127.0.0.1:3000/app/planning"
});

Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  Element: dom.window.Element,
  location: dom.window.location,
  history: dom.window.history,
  localStorage: dom.window.localStorage,
  sessionStorage: dom.window.sessionStorage
});

const {
  boardColumnEffort,
  configureWorkTaxonomy,
  planningWorkbenchDefaultScope,
  planningWorkbenchView,
  prepareBoardStatusConfiguration
} = await import("../src/components/ui.js");

const configuration = {
  schemaVersion: 1,
  version: 3,
  defaultTypeId: "task",
  defaultStatusId: "intake",
  types: [{id: "task", label: "Task", active: true}],
  statuses: [
    {id: "intake", label: "Intake", active: true, closed: false},
    {id: "done", label: "Done", active: true, closed: true}
  ],
  transitions: [
    {fromStatusId: "intake", toStatusId: "done", roles: ["workspace-admin", "member"]},
    {fromStatusId: "done", toStatusId: "intake", roles: ["workspace-admin", "member"]}
  ]
};

test("board defaults to all tasks, keeps completed cards visible, and offers semantic move controls", async () => {
  configureWorkTaxonomy(configuration);
  const patches = [];
  const client = {
    workItems: {
      patch: async (projectId, id, patch) => {
        patches.push({projectId, id, patch});
        return {...patch, projectId, id};
      }
    },
    workConfiguration: {patch: async (payload) => payload},
    savedViews: {create: async (payload) => payload}
  };
  const items = [
    {id: "open", projectId: "project-one", projectName: "Launch", title: "Open task", type: "task", status: "intake", priority: "medium", assigneeName: "Avery", dueDate: "2026-08-24", periodName: "Launch sprint", customFields: {workflowStep: "Design", workstream: "Experience"}, effortPoints: 3, version: 2},
    {id: "closed", projectId: "project-one", title: "Completed task", type: "task", status: "done", effortPoints: 5, version: 4}
  ];
  const view = planningWorkbenchView(items, client, {
    summary: {wipLimit: 4},
    workConfiguration: configuration,
    canManageColumns: true
  });
  document.body.replaceChildren(view);

  assert.equal(planningWorkbenchDefaultScope, "all");
  assert.equal(view.querySelector("select[name='scope']")?.value, "all");
  const doneHeading = [...view.querySelectorAll(".planning-workbench__column h3")]
    .find((heading) => heading.textContent === "Done");
  assert.ok(doneHeading);
  assert.match(doneHeading.closest(".planning-workbench__column")?.textContent ?? "", /Completed task/);
  assert.match(view.querySelector(".planning-workbench__board-guide")?.textContent ?? "", /Showing all tasks, including completed work/);
  assert.deepEqual([...view.querySelectorAll(".list-view-tabs a, .list-view-tabs button")].map((item) => item.textContent), ["Board", "List"]);
  assert.deepEqual([...view.querySelector("select[name='layout']").options].map((option) => option.value), ["board", "table", "timeline", "calendar", "gantt", "workload", "dependencies", "gallery"]);
  assert.equal(view.querySelectorAll("#board-columns > summary").length, 1);
  assert.match(view.querySelector(".planning-workbench__effort-help")?.textContent ?? "", /Points are optional relative-size estimates, not hours/);

  const openCard = [...view.querySelectorAll("article.work-card")]
    .find((card) => card.textContent.includes("Open task"));
  assert.ok(openCard);
  assert.equal(openCard.getAttribute("role"), null, "the card is not a fake link containing nested links");
  assert.equal(openCard.getAttribute("tabindex"), null);
  assert.equal(openCard.querySelector("a.work-card__title")?.textContent, "Open task");
  assert.equal(openCard.classList.contains("work-card--compact"), true);
  assert.match(openCard.textContent, /Launch/);
  assert.match(openCard.textContent, /Avery/);
  assert.match(openCard.textContent, /Due 2026-08-24/);
  assert.match(openCard.textContent, /3 effort pts/);
  assert.doesNotMatch(openCard.textContent, /Launch sprint|Design|Experience|medium/i);
  const destination = openCard.querySelector("select[name='moveTo']");
  assert.equal(destination.options[0].textContent, "Move to…");
  destination.value = "done";
  destination.dispatchEvent(new window.Event("change"));
  openCard.querySelector("button.work-card__move-button").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(patches, [{
    projectId: "project-one",
    id: "open",
    patch: {status: "done", version: 2}
  }]);
  assert.match(view.querySelector(".planning-workbench__status")?.textContent ?? "", /Moved Open task to Done/);
  assert.match(view.querySelector("#board-columns")?.textContent ?? "", /Add, rename, reorder, or retire statuses/);
});

test("column effort copy explains totals without implying zero progress in open status bins", () => {
  const items = [
    {status: "intake", effortPoints: 2},
    {status: "intake", effortPoints: 5}
  ];
  assert.deepEqual(boardColumnEffort(items, "status"), {
    label: "7 effort points",
    description: "7 relative-size estimates in this column; effort points are not hours."
  });
  assert.deepEqual(boardColumnEffort([], "status"), {
    label: "No effort estimated",
    description: "Effort points are optional relative-size estimates, not hours."
  });
});

test("new columns gain transitions and occupied columns cannot be retired", () => {
  const statuses = [
    ...configuration.statuses,
    {id: "review", label: "Review", active: true, closed: false}
  ];
  const withReview = prepareBoardStatusConfiguration(configuration, statuses);
  const keys = new Set(withReview.transitions.map((transition) => `${transition.fromStatusId}:${transition.toStatusId}`));
  assert.ok(keys.has("intake:review"));
  assert.ok(keys.has("review:intake"));
  assert.ok(keys.has("done:review"));
  assert.ok(keys.has("review:done"));

  const retiredDone = configuration.statuses.map((status) => (
    status.id === "done" ? {...status, active: false} : status
  ));
  assert.throws(
    () => prepareBoardStatusConfiguration(configuration, retiredDone, {itemCounts: {done: 1}}),
    /Move every task out of Done/
  );
  const retired = prepareBoardStatusConfiguration(configuration, retiredDone);
  assert.equal(retired.transitions.some((transition) => transition.toStatusId === "done"), false);
  assert.equal(retired.transitions.some((transition) => transition.fromStatusId === "done" && transition.toStatusId === "intake"), true);
});

test("cards in a retired column remain visible and can move out but not in", () => {
  const retiredConfiguration = {
    ...configuration,
    statuses: [
      ...configuration.statuses,
      {id: "legacy", label: "Legacy", active: false, closed: false}
    ],
    transitions: [
      ...configuration.transitions,
      {fromStatusId: "legacy", toStatusId: "intake", roles: ["workspace-admin"]}
    ]
  };
  configureWorkTaxonomy(retiredConfiguration);
  const client = {
    workItems: {patch: async () => ({})},
    savedViews: {create: async (payload) => payload}
  };
  const view = planningWorkbenchView([
    {id: "new", projectId: "project-one", title: "New task", type: "task", status: "intake", version: 1},
    {id: "old", projectId: "project-one", title: "Legacy task", type: "task", status: "legacy", version: 1}
  ], client, {summary: {wipLimit: 4}});
  const retiredHeading = [...view.querySelectorAll(".planning-workbench__column h3")]
    .find((heading) => heading.textContent === "Legacy");
  const retiredColumn = retiredHeading?.closest(".planning-workbench__column");
  assert.ok(retiredColumn?.classList.contains("is-retired"));
  assert.match(retiredColumn?.textContent ?? "", /Legacy task/);
  assert.match(retiredColumn?.textContent ?? "", /Retired · move cards out/);
  assert.deepEqual(
    [...retiredColumn.querySelectorAll("select[name='moveTo'] option")].map((option) => option.value),
    ["", "intake", "done"]
  );
  const activeColumn = [...view.querySelectorAll(".planning-workbench__column")]
    .find((column) => column.querySelector("h3")?.textContent === "Intake");
  assert.equal(
    [...activeColumn.querySelectorAll("select[name='moveTo'] option")].some((option) => option.value === "legacy"),
    false
  );
  configureWorkTaxonomy(configuration);
});
