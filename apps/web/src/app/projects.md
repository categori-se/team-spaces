---
title: Projects
---

<span id="public-demo-entry" hidden></span>

```js
import {apiClient} from "../lib/api.js";
import {actionPanel, buttonLink, configureWorkTaxonomy, createProjectForm, csvExportButton, errorView, pageHeader, projectFilterForm, projectListWorkbench, projectTemplateGallery, savedViewForm, taskCreatePanel, toolbar, workspaceTopNav} from "../components/ui.js";
```

```js
display(workspaceTopNav());
const client = await apiClient();
const refreshPage = () => location.reload();
const params = new URLSearchParams(location.search);
const search = params.get("search") ?? "";
const health = params.get("health") ?? "";
const status = params.get("status") ?? "";
const view = params.get("view") ?? "grid";
```

```js
const result = await Promise.all([
  client.bootstrap({signal: invalidation}),
  client.memberships.list({signal: invalidation}),
  client.projects.list({search, health, status, signal: invalidation}),
  client.planning.dashboard({signal: invalidation})
]).catch((error) => error);
```

```js
if (result instanceof Error) {
  display(errorView(result, refreshPage));
} else {
  const [bootstrap, memberships, projectsResult, planning] = result;
  configureWorkTaxonomy(bootstrap.workConfiguration);
  const projectData = {...bootstrap, memberships: memberships.items};
  const projects = projectsResult.items;
  display(pageHeader({
    title: "Projects",
    description: "Project spaces, owners, dates, health, and delivery work.",
    actions: [
      buttonLink("New project", "#new-project", {primary: true}),
      buttonLink("New task", "#new-task")
    ]
  }));
  display(actionPanel("Filter projects", projectFilterForm({search, health, status}), {id: "filters", open: Boolean(search || health || status), meta: "Search, health, and status"}));
  display(projectListWorkbench(projects, {portfolios: bootstrap.portfolios}, {view}));
  display(toolbar([
    actionPanel("New project", createProjectForm(client, projectData, {onSaved: refreshPage}), {id: "new-project", meta: "Name, owner, portfolio, health"}),
    actionPanel("Create task", taskCreatePanel(client, bootstrap.projects, {onSaved: refreshPage, memberships: memberships.items, workItems: planning.items, id: ""}), {id: "new-task", meta: "Project, owner, dates, notes"}),
    actionPanel("Templates", projectTemplateGallery(client, projectData, {onSaved: refreshPage}), {meta: "Issue, launch, onboarding"}),
    savedViewForm(client, "projects", {search, health, status}),
    csvExportButton("projects.csv", projects)
  ]));
}
```
