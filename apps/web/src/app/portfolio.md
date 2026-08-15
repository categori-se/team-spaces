---
title: Portfolio
---

```js
import {apiClient} from "../lib/api.js";
import {actionPanel, buttonLink, configureWorkTaxonomy, createPortfolioForm, createProjectForm, errorView, hierarchyTree, pageHeader, portfolioHealthChart, projectTable, workspaceTopNav} from "../components/ui.js";
```

```js
display(workspaceTopNav());
const client = await apiClient();
const refreshPage = () => location.reload();
const result = await Promise.all([
  client.bootstrap({signal: invalidation}),
  client.memberships.list({signal: invalidation})
]).catch((error) => error);
```

```js
if (result instanceof Error) {
  display(errorView(result, refreshPage));
} else {
  const [data, memberships] = result;
  configureWorkTaxonomy(data.workConfiguration);
  const projectData = {...data, memberships: memberships.items};
  display(pageHeader({
    title: "Portfolio",
    description: "Group projects and track health, progress, and target dates.",
    actions: [
      buttonLink("Add project", "#add-project", {primary: true}),
      buttonLink("Review projects", "/app/projects")
    ]
  }));
  display(hierarchyTree(data.portfolios, data.projects));
  display(actionPanel("Add portfolio", createPortfolioForm(client, {onSaved: refreshPage}), {id: "add-portfolio"}));
  display(actionPanel("Add project", createProjectForm(client, projectData, {onSaved: refreshPage}), {id: "add-project"}));
  display(actionPanel("Project list", projectTable(data.projects, {portfolios: data.portfolios}), {meta: `${data.projects.length} projects`}));
  display(actionPanel("Portfolio health", portfolioHealthChart(data.summary), {meta: "Chart"}));
}
```
