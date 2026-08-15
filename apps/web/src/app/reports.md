---
title: Reports
---

<span id="public-demo-entry" hidden></span>

```js
import {apiClient} from "../lib/api.js";
import {actionPanel, buttonLink, errorView, pageHeader, planningDashboard, planningReportTables, portfolioHealthChart, projectTimeline, reportTables, workspaceTopNav} from "../components/ui.js";
```

```js
display(workspaceTopNav());
const client = await apiClient();
const refreshPage = () => location.reload();
const reportResult = await Promise.all([
  client.reports.portfolioSummary({signal: invalidation}),
  client.reports.planningSummary({signal: invalidation}),
  client.reports.projectTimeline({signal: invalidation})
]).catch((error) => error);
```

```js
if (reportResult instanceof Error) {
  display(errorView(reportResult, refreshPage));
} else {
  const [summary, planning, timeline] = reportResult;
  display(pageHeader({
    title: "Reports",
    description: "Portfolio health, schedule, progress, and workload.",
    actions: [buttonLink("Open task planning", "/app/planning")]
  }));
  display(portfolioHealthChart(summary));
  display(projectTimeline(timeline.items));
  display(actionPanel("Planning report", planningDashboard(planning), {meta: "Flow and period details"}));
  display(actionPanel("Planning tables", planningReportTables(planning), {meta: "Periods and milestones"}));
  display(actionPanel("Portfolio tables", reportTables(summary), {meta: "Status, phase, task counts"}));
}
```
