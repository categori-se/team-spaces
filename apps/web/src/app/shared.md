---
title: Shared task
---

```js
import {apiClient} from "../lib/api.js";
import {errorView, pageHeader, sharedWorkView, workspaceTopNav} from "../components/ui.js";
```

```js
display(workspaceTopNav());
const client = await apiClient();
const token = new URLSearchParams(location.search).get("token") ?? "";
const refreshPage = () => location.reload();
const shared = token ? await client.externalShares.get(token, {signal: invalidation}).catch((error) => error) : new Error("A share token is required.");
```

```js
if (shared instanceof Error) {
  display(errorView(shared, refreshPage));
} else {
  display(pageHeader({
    eyebrow: "Recipient-bound external share",
    title: shared.workItem.title,
    description: `${shared.project.name} shared this task with your signed-in identity. Internal comments and unrelated project data are excluded.`
  }));
  display(sharedWorkView(shared, client, {onSaved: refreshPage}));
}
```
