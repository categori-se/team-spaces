---
title: Public projects
sidebar: false
---

<nav class="context-links" aria-label="Team Spaces navigation">
  <a href="/">Team Spaces</a>
  <a href="/app/projects">Sign in to your workspace</a>
</nav>

```js
import {publicCoordinationClient} from "./lib/api.js";
import {publicProjectDirectory} from "./components/public-projects.js";
import {errorView, pageHeader} from "./components/ui.js";
```

```js
display(pageHeader({title: "Public projects", description: "Explore the projects teams have chosen to share. Public project pages are read-only."}));
const client = await publicCoordinationClient();
const result = await client.projects.list({signal: invalidation}).catch((error) => error);
```

```js
if (result instanceof Error) display(errorView(result, () => location.reload()));
else display(publicProjectDirectory(result));
```
