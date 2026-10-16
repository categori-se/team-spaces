---
title: Search
---

```js
import {apiClient} from "../lib/api.js";
import {errorView, globalSearchForm, globalSearchResults, pageHeader, workspaceTopNav} from "../components/ui.js";
```

```js
display(workspaceTopNav());
const client = await apiClient();
const query = new URLSearchParams(location.search).get("q") ?? "";
const result = await client.search.global({q: query, signal: invalidation}).catch((error) => error);
```

```js
display(pageHeader({
  eyebrow: "Workspace",
  title: "Global search",
  description: "Find projects, tasks, meetings, and document metadata you are allowed to access."
}));
display(globalSearchForm(query));
if (result instanceof Error) display(errorView(result, () => location.reload()));
else display(globalSearchResults(result.items, result.query));
```
