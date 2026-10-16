---
title: Overview
---

<span id="public-demo-entry" hidden aria-hidden="true"></span>

```js
import {apiClient} from "./lib/api.js";
import {applyWorkspaceCapabilities, buttonLink, configureWorkTaxonomy, errorView, loadingView, pageHeader, workspaceDashboard, workspaceTopNav} from "./components/ui.js";
```

```js
display(workspaceTopNav());
const client = await apiClient();
const refreshPage = () => location.reload();
```

```js
display(pageHeader({
  title: "Overview",
  description: "Your assigned work and the projects that need attention.",
  actions: [
    buttonLink("New task", "/app/planning#new-task", {primary: true}),
    buttonLink("New project", "/app/projects#new-project")
  ]
}));
```

```js
const result = await Promise.all([
  client.bootstrap({signal: invalidation}),
  client.workItems.assigned({signal: invalidation}),
  client.activity.list({signal: invalidation})
]).catch((error) => error);
```

```js
if (result instanceof Error) {
  display(errorView(result, refreshPage));
} else if (!result) {
  display(loadingView("Loading workspace"));
} else {
  const [data, assignments, activity] = result;
  configureWorkTaxonomy(data.workConfiguration);
  applyWorkspaceCapabilities(data.capabilities);
  display(workspaceDashboard(data, assignments.items, activity.items));
}
```
