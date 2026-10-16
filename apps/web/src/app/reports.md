---
title: Reports
---

<span id="public-demo-entry" hidden></span>

```js
import {apiClient} from "../lib/api.js";
import {actionPanel, buttonLink, costReportDefinitionFilter, costReportView, errorView, pageHeader, planningDashboard, planningReportTables, portfolioHealthChart, projectTimeline, reportTables, resourcePlannerControls, resourcePlanView, securityBadgeView, toolbar, workspaceTopNav} from "../components/ui.js";
```

```js
display(workspaceTopNav());
const client = await apiClient();
const refreshPage = () => location.reload();
const definitionId = new URLSearchParams(location.search).get("definitionId") ?? "";
const reportParams = new URLSearchParams(location.search);
const reportResult = await Promise.all([
  client.reports.portfolioSummary({signal: invalidation}),
  client.reports.planningSummary({signal: invalidation}),
  client.reports.projectTimeline({signal: invalidation}),
  client.reports.costs({definitionId: definitionId || undefined, signal: invalidation}),
  client.reports.resources({week: reportParams.get("week") ?? undefined, projectId: reportParams.get("projectId") ?? undefined, skill: reportParams.get("skill") ?? undefined, signal: invalidation}),
  client.security.badge({signal: invalidation})
]).catch((error) => error);
```

```js
if (reportResult instanceof Error) {
  display(errorView(reportResult, refreshPage));
} else {
  const [summary, planning, timeline, costs, resources, security] = reportResult;
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
  display(actionPanel("Cost and budget report", toolbar([costReportDefinitionFilter(costs, definitionId), costReportView(costs)]), {open: true, meta: "Rates, planned and actual labor, units, and variance"}));
  display(actionPanel("Resource planner", toolbar([resourcePlannerControls(client, resources, {onSaved: refreshPage, canManage: ["workspace-admin", "portfolio-manager", "project-manager"].includes((await client.me()).membership?.role}), resourcePlanView(resources)]), {open: true, meta: "Weekly staffing, skills, capacity, allocation, and time off"}));
  display(actionPanel("Installation security", securityBadgeView(security), {meta: "Identity, alerts, upload, link, and provisioning controls"}));
}
```
