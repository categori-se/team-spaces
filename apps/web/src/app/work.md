---
title: My Tasks
---

<span id="public-demo-entry" hidden></span>

```js
import {apiClient} from "../lib/api.js";
import {buttonLink, configureWorkTaxonomy, emptyActionView, errorView, pageHeader, workListWorkbench, workspaceTopNav} from "../components/ui.js";
```

```js
display(workspaceTopNav());
const client = await apiClient();
const refreshPage = () => location.reload();
const view = new URLSearchParams(location.search).get("view") ?? "grid";
const result = await Promise.all([
  client.workItems.assigned({signal: invalidation}),
  client.workConfiguration.get({signal: invalidation})
]).catch((error) => error);
```

```js
if (result instanceof Error) {
  display(errorView(result, refreshPage));
} else if (!result[0].items.length) {
  configureWorkTaxonomy(result[1]);
  display(pageHeader({
    title: "My tasks",
    description: "Your assigned work, organized for action.",
    actions: [buttonLink("New task", "/app/planning#new-task", {primary: true})]
  }));
  display(emptyActionView("No assigned tasks", "Once tasks are assigned to you, they will appear here.", {label: "Create task", href: "/app/planning#new-task"}));
} else {
  const [workItems, workConfiguration] = result;
  configureWorkTaxonomy(workConfiguration);
  display(pageHeader({
    title: "My tasks",
    description: "Your assigned work, organized for action.",
    actions: [
      buttonLink("New task", "/app/planning#new-task", {primary: true}),
      buttonLink("Record time", "/app/time#record-time")
    ]
  }));
  display(workListWorkbench(workItems.items, client, {onSaved: refreshPage, view}));
}
```
