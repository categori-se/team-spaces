---
title: Project
---

```js
import {apiClient} from "../lib/api.js";
import {actionPanel, activityCommentForm, activityList, buttonLink, configureWorkTaxonomy, cursorPager, documentUploadForm, documentsTable, emptyView, errorView, pageHeader, projectDeliverySummary, projectEditForm, projectOverview, projectPlanningViews, projectStatusUpdateForm, projectTeamPanel, publicDemoUploadNotice, taskCreatePanel, toolbar, workBreakdownTree, workPackageDetails, workspaceTopNav} from "../components/ui.js";
```

```js
display(workspaceTopNav());
const client = await apiClient();
const refreshPage = () => location.reload();
const pageParams = new URLSearchParams(location.search);
const projectId = pageParams.get("id");
const cursor = pageParams.get("cursor") ?? "";
```

```js
if (!projectId) {
  display(pageHeader({
    eyebrow: "Project",
    title: "Select a project",
    description: "Choose a project to view its tasks, meetings, files, time, and activity."
  }));
  display(emptyView("Select a project from the project directory."));
} else {
  const project = await client.projects.get(projectId, {signal: invalidation}).catch((error) => error);
  if (project instanceof Error) {
    display(errorView(project, refreshPage));
  } else {
    const [lookups, memberships, workItems, activity, documents, timeEntries] = await Promise.all([
      client.bootstrap({signal: invalidation}),
      client.memberships.list({signal: invalidation}),
      client.workItems.list(projectId, {cursor: cursor || undefined, signal: invalidation}),
      client.activity.list({projectId, signal: invalidation}),
      client.documents.list({projectId, signal: invalidation}),
      client.timeEntries.list({projectId, signal: invalidation})
    ]);
    configureWorkTaxonomy(lookups.workConfiguration);
    display(pageHeader({
      eyebrow: "Project",
      title: project.name,
      description: project.description ?? "Project work, ownership, dates, and delivery context.",
      actions: [
        buttonLink("Create task", "#new-task", {primary: true}),
        buttonLink("Edit project", "#edit-project"),
        buttonLink("Meetings", `/app/meetings?projectId=${encodeURIComponent(project.id)}`),
        buttonLink("Task views", `/app/planning?projectId=${encodeURIComponent(project.id)}`)
      ]
    }));
    display(projectPlanningViews(project, workItems.items, client, {onSaved: refreshPage, memberships: memberships.items}));
    display(cursorPager(workItems.pageInfo, {path: "/app/project", params: {id: projectId}, hasCursor: Boolean(cursor)}));
    display(actionPanel("Create task", taskCreatePanel(client, [project], {onSaved: refreshPage, selectedProjectId: projectId, memberships: memberships.items, workItems: workItems.items, id: ""}), {id: "new-task", open: !workItems.items.length, meta: "Owner, dates, notes, dependencies"}));
    display(toolbar([
      actionPanel("Edit project", projectEditForm(client, project, lookups, memberships.items, {onSaved: refreshPage}), {id: "edit-project"}),
      actionPanel("Share status update", projectStatusUpdateForm(client, project, {onSaved: refreshPage}), {id: "status-update"}),
      actionPanel("Add collaboration note", activityCommentForm(client, project, workItems.items, {onSaved: refreshPage}), {id: "new-note"}),
      client.isPublicDemo ? "" : actionPanel("Upload document", documentUploadForm(client, projectId, {onSaved: refreshPage, workItems: workItems.items}), {id: "documents"})
    ]));
    if (client.isPublicDemo) display(publicDemoUploadNotice());
    display(workPackageDetails(workItems.items, client, {onSaved: refreshPage, memberships: memberships.items, documents: documents.items}));
    display(actionPanel("Project details", projectOverview(project, memberships.items), {meta: "Fields and ownership"}));
    display(actionPanel("Delivery signals", projectDeliverySummary(project, workItems.items, timeEntries.items), {id: "project-status", meta: "Progress, blockers, effort"}));
    display(actionPanel("Team", projectTeamPanel(project, workItems.items, memberships.items), {meta: "Roles and assignments"}));
    display(actionPanel("Task breakdown", workBreakdownTree(workItems.items), {meta: `${workItems.items.length} tasks on this page`}));
    display(actionPanel("Documents", documentsTable(documents.items, client, {onSaved: refreshPage, workItems: workItems.items}), {open: Boolean(documents.items.length), meta: `${documents.items.length} documents`}));
    display(actionPanel("Activity", activityList(activity.items), {meta: `${activity.items.length} events`}));
  }
}
```
