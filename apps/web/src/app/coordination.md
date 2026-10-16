---
title: Coordination
---

```js
import {apiClient} from "../lib/api.js";
import {coordinationDashboard} from "../components/coordination.js";
import {errorView, pageHeader, workspaceTopNav} from "../components/ui.js";
```

```js
display(workspaceTopNav());
const client = await apiClient();
const refreshPage = () => location.reload();
const coordinationParams = new URLSearchParams(location.search);
const initiativeId = coordinationParams.get("initiativeId") || undefined;
const result = await client.coordination.get({initiativeId, signal: invalidation}).catch((error) => error);
```

```js
if (result instanceof Error) {
  display(errorView(result, refreshPage));
} else {
  const coordination = result;
  const canEdit = !client.isPublicDemo && coordination.canManage === true;
  const closedStatusIds = coordination.workConfiguration?.statuses?.filter((status) => status.closed).map((status) => status.id) ?? ["done"];
  display(pageHeader({
    eyebrow: "Private project coordination",
    title: coordination.title || "Coordination",
    description: "Follow task outcomes across owner roles, dependencies, and review. Filter by project or facet to see what can move next."
  }));
  display(coordinationDashboard(coordination, client, {canEdit, closedStatusIds, workConfiguration: coordination.workConfiguration, onRefresh: refreshPage, onSaved: refreshPage}));
}
```
