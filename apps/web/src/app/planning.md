---
title: Planning
---

<span id="public-demo-entry" hidden></span>

```js
import {apiClient} from "../lib/api.js";
import {actionPanel, buttonLink, configureWorkTaxonomy, cursorPager, errorView, intakePlanner, milestoneBoard, milestoneDefinitionForm, pageHeader, periodBoard, periodDefinitionForm, periodPlanTable, planningDashboard, planningWorkbench, taskCreatePanel, teamWorkloadBoard, toolbar, workflowStepDefinitionForm, workspaceTopNav, workstreamDefinitionForm} from "../components/ui.js";
```

```js
display(workspaceTopNav());
const client = await apiClient();
const refreshPage = () => location.reload();
const pageParams = new URLSearchParams(location.search);
const selectedProjectId = pageParams.get("projectId") ?? "";
const cursor = pageParams.get("cursor") ?? "";
const result = await Promise.all([
  client.planning.dashboard({projectId: selectedProjectId || undefined, cursor: cursor || undefined, signal: invalidation}),
  client.bootstrap({signal: invalidation}),
  client.memberships.list({signal: invalidation}),
  client.savedViews.list({signal: invalidation})
]).catch((error) => error);
```

```js
if (result instanceof Error) {
  display(errorView(result, refreshPage));
} else {
  const [planning, workspace, memberships, savedViews] = result;
  configureWorkTaxonomy(workspace.workConfiguration);
  const selectedProject = selectedProjectId ? workspace.projects.find((project) => project.id === selectedProjectId) : undefined;
  const visibleItems = planning.items;
  const currentPeriodId = planning.summary.currentPeriod?.id ?? "unscheduled";
  const periodItems = currentPeriodId === "unscheduled"
    ? visibleItems
    : visibleItems.filter((item) => (item.periodId || item.periodName || "unscheduled") === currentPeriodId);
  display(pageHeader({
    eyebrow: "Planning",
    title: selectedProject ? `${selectedProject.name} tasks` : "Task planning",
    description: `${selectedProject ? "Plan and update this project's tasks." : "Plan and update work across projects."}${planning.summaryScope === "page" ? " Summaries reflect this page; continue for more tasks." : planning.summaryScope === "legacy-transition" ? " Some workspace tasks are still being prepared for this view." : ""}`,
    actions: [
      buttonLink("New task", "#new-task", {primary: true})
    ]
  }));
  display(planningWorkbench(visibleItems, client, {
    onSaved: refreshPage,
    summary: planning.summary,
    memberships: memberships.items,
    savedViews: savedViews.items,
    selectedProjectId,
    workConfiguration: workspace.workConfiguration,
    canManageColumns: workspace.membership?.role === "workspace-admin" || client.isPublicDemo
  }));
  display(cursorPager(planning.pageInfo, {path: "/app/planning", params: {projectId: selectedProjectId}, hasCursor: Boolean(cursor)}));
  display(actionPanel("Create task", taskCreatePanel(client, workspace.projects, {onSaved: refreshPage, selectedProjectId, memberships: memberships.items, workItems: visibleItems, id: ""}), {id: "new-task", open: !visibleItems.length, meta: "Project, owner, dates, notes"}));
  const planningTools = [
    actionPanel("Planning setup", toolbar([
      actionPanel("Define time period", periodDefinitionForm(client, workspace.projects, {onSaved: refreshPage, selectedProjectId}), {meta: "Named delivery window"}),
      actionPanel("Define milestone", milestoneDefinitionForm(client, workspace.projects, {onSaved: refreshPage, selectedProjectId}), {meta: "Target outcome"}),
      actionPanel("Define workflow step", workflowStepDefinitionForm(client, workspace.projects, {onSaved: refreshPage, selectedProjectId, memberships: memberships.items}), {meta: "Custom process"}),
      actionPanel("Define workstream", workstreamDefinitionForm(client, workspace.projects, {onSaved: refreshPage, selectedProjectId, memberships: memberships.items}), {meta: "Focus area"}),
      actionPanel("Period plan", periodPlanTable(planning.summary), {meta: "Shared cadence"})
    ]), {id: "planning-fields", meta: "Periods, milestones, and workflow"})
  ];
  if (visibleItems.length) {
    planningTools.push(actionPanel("Planning insights", toolbar([
      actionPanel("Period health", planningDashboard(planning.summary), {meta: "Flow and completion"}),
      actionPanel("Status board", periodBoard(periodItems, client, {onSaved: refreshPage, summary: planning.summary}), {meta: "Current period"}),
      actionPanel("Intake groups", intakePlanner(visibleItems), {meta: "Ideas, bugs, maintenance"}),
      actionPanel("Team workload", teamWorkloadBoard(visibleItems, planning.summary), {meta: "Open assignments"}),
      actionPanel("Milestone board", milestoneBoard(visibleItems, planning.summary), {meta: "Target outcomes"})
    ]), {meta: "Health, workload, and delivery views"}));
  }
  display(toolbar(planningTools));
}
```
