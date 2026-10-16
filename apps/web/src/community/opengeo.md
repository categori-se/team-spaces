---
title: OpenGeo Studio [community edition]
sidebar: false
---

<nav class="context-links" aria-label="Community roadmap navigation">
  <a href="/">Team Spaces</a>
  <a href="/projects">Public projects</a>
  <a href="https://github.com/categori-se/opengeo-community" rel="noopener noreferrer">Community source</a>
  <a href="/app/projects">Sign in to manage projects</a>
</nav>

```js
import {publicCoordinationClient} from "../lib/api.js";
import {coordinationDashboard} from "../components/coordination.js";
import {errorView, pageHeader} from "../components/ui.js";
```

```js
display(pageHeader({
  eyebrow: "Public project roadmap",
  title: "OpenGeo Studio [community edition]",
  description: "Follow community development tasks, parity targets and accepted outcomes."
}));
const client = await publicCoordinationClient();
const refreshPage = () => location.reload();
const result = await client.coordination.get({initiativeId: "opengeo", signal: invalidation}).catch((error) => error);
```

```js
if (result instanceof Error) {
  display(errorView(result, refreshPage));
} else {
  display(coordinationDashboard(result, client, {
    closedStatusIds: result.workConfiguration?.statuses?.filter((status) => status.closed).map((status) => status.id) ?? ["done"],
    workConfiguration: result.workConfiguration,
    onRefresh: refreshPage
  }));
}
```
