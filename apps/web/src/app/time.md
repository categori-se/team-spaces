---
title: Time
---

```js
import {apiClient} from "../lib/api.js";
import {actionPanel, buttonLink, csvExportButton, emptyActionView, errorView, pageHeader, timeEntryForm, timesheetTable, timerControl, toolbar, workspaceTopNav} from "../components/ui.js";
```

```js
display(workspaceTopNav());
const client = await apiClient();
const refreshPage = () => location.reload();
const selectedProjectId = new URLSearchParams(location.search).get("projectId") ?? "";
const data = await client.bootstrap({signal: invalidation});
const result = await client.timeEntries.list({projectId: selectedProjectId, signal: invalidation}).catch((error) => error);
```

```js
if (result instanceof Error) {
  display(errorView(result, refreshPage));
} else {
  const selectedProject = selectedProjectId ? data.projects.find((project) => project.id === selectedProjectId) : undefined;
  display(pageHeader({
    title: selectedProject ? `${selectedProject.name} time` : "Time",
    description: selectedProject ? "Record and review effort for this project." : "Record project time and review your timesheet.",
    actions: [
      buttonLink("Record time", "#record-time", {primary: true}),
      buttonLink("My tasks", "/app/work")
    ]
  }));
  display(timerControl());
  display(toolbar([
    actionPanel("Record time", timeEntryForm(client, data.projects, {onSaved: refreshPage, selectedProjectId}), {id: "record-time", open: !result.items.length}),
    csvExportButton("time-entries.csv", result.items)
  ]));
  if (!result.items.length) display(emptyActionView("No time entries recorded", "Use Record time to start the account timesheet.", {label: "Record time", href: "#record-time"}));
  display(timesheetTable(result.items, data.projects));
}
```
