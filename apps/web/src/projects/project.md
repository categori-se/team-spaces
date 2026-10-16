---
title: Project roadmap
sidebar: false
---

<nav class="context-links" aria-label="Team Spaces navigation">
  <a href="/">Team Spaces</a>
  <a href="/projects">Public projects</a>
  <a href="/app/projects">Sign in to your workspace</a>
</nav>

```js
import {publicCoordinationClient} from "../lib/api.js";
import {coordinationDashboard} from "../components/coordination.js";
import {errorView, pageHeader} from "../components/ui.js";
```

```js
const params = new URLSearchParams(location.search);
const initiativeId = params.get("initiativeId");
const projectId = params.get("projectId");
const client = await publicCoordinationClient();
const result = await client.coordination.get({initiativeId, signal: invalidation}).then((data) => {
  const project = data.projects.find((item) => item.id === projectId);
  if (!project) throw new Error("This public project is unavailable.");
  return {...data, title: project.name, projects: [project], tasks: data.tasks.filter((task) => task.projectId === project.id), parityBaseline: data.projects.length === 1 ? data.parityBaseline : undefined};
}).catch((error) => error);
```

```js
if (result instanceof Error) display(errorView(result, () => location.reload()));
else {
  display(pageHeader({eyebrow: "Public project roadmap", title: result.title, description: "Follow this project’s tasks, priorities and accepted outcomes."}));
  display(coordinationDashboard(result, client, {
    closedStatusIds: result.workConfiguration?.statuses?.filter((status) => status.closed).map((status) => status.id) ?? ["done"],
    workConfiguration: result.workConfiguration,
    onRefresh: () => location.reload()
  }));
}
```
