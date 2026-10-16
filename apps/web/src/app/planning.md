---
title: Planning
---

<span id="public-demo-entry" hidden></span>

```js
import {apiClient} from "../lib/api.js";
import {actionPanel, baselineComparisonView, buttonLink, configureWorkTaxonomy, cursorPager, errorView, historicalBaselineForm, intakePlanner, milestoneBoard, milestoneDefinitionForm, pageHeader, periodBoard, periodDefinitionForm, periodPlanTable, planningDashboard, planningResourceForm, planningResourcesView, planningWorkbench, scheduleProjectControl, sprintBurndownView, taskCreatePanel, teamWorkloadBoard, toolbar, workflowStepDefinitionForm, workspaceTopNav, workstreamDefinitionForm} from "../components/ui.js";
```

```js
display(workspaceTopNav());
const client = await apiClient();
const refreshPage = () => location.reload();
const pageParams = new URLSearchParams(location.search);
const selectedProjectId = pageParams.get("projectId") ?? "";
const selectedResourceId = pageParams.get("resourceId") ?? "";
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
  const canManageProject = ["workspace-admin", "portfolio-manager", "project-manager"].includes(workspace.membership?.role);
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
    capabilities: workspace.capabilities,
    canManageColumns: workspace.membership?.role === "workspace-admin" || client.isPublicDemo
  }));
  display(cursorPager(planning.pageInfo, {path: "/app/planning", params: {projectId: selectedProjectId}, hasCursor: Boolean(cursor)}));
  display(actionPanel("Create task", taskCreatePanel(client, workspace.projects, {onSaved: refreshPage, selectedProjectId, memberships: memberships.items, workItems: visibleItems, capabilities: workspace.capabilities, id: ""}), {id: "new-task", open: !visibleItems.length, meta: "Project, owner, dates, notes, configured fields"}));
  if (selectedProject) {
    const resourceResult = await client.planningResources.list(selectedProject.id, {limit: 100, signal: invalidation}).catch((error) => error);
    if (resourceResult instanceof Error) {
      display(errorView(resourceResult, refreshPage));
    } else {
      const selectedResource = resourceResult.items.find((resource) => resource.id === selectedResourceId);
      const insight = selectedResource?.kind === "baseline"
        ? await client.planningResources.baselineComparison(selectedProject.id, selectedResource.id, {signal: invalidation}).catch((error) => error)
        : selectedResource?.kind === "sprint"
          ? await client.planningResources.burndown(selectedProject.id, selectedResource.id, {signal: invalidation}).catch((error) => error)
          : undefined;
      if (insight instanceof Error) display(errorView(insight, refreshPage));
      else if (selectedResource?.kind === "baseline") display(actionPanel(`Baseline: ${selectedResource.name}`, baselineComparisonView(insight), {open: true, meta: `Captured ${selectedResource.capturedAt?.slice(0, 10) ?? "snapshot"}`}));
      else if (selectedResource?.kind === "sprint") display(actionPanel(`Burndown: ${selectedResource.name}`, sprintBurndownView(insight), {open: true, meta: `${selectedResource.startDate} – ${selectedResource.endDate}`}));
      display(actionPanel("Project planning resources", planningResourcesView(resourceResult.items, client, visibleItems, {onSaved: refreshPage, capabilities: workspace.capabilities}), {open: true, meta: "Versions, sprints, baselines, calendars, and boards"}));
      display(actionPanel("Historical baseline comparison", historicalBaselineForm(client, selectedProject), {open: false, meta: "Yesterday or any retained date range"}));
      if (canManageProject) display(toolbar([
        actionPanel("Automatic scheduling", scheduleProjectControl(client, selectedProject, {onSaved: refreshPage}), {meta: "Calendars, dependencies, and rollups"}),
        actionPanel("Create planning resource", planningResourceForm(client, selectedProject, workspace.projects, {onSaved: refreshPage, capabilities: workspace.capabilities}), {id: "new-planning-resource", meta: "Version, sprint, baseline, calendar, or board"})
      ]));
    }
  }
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
