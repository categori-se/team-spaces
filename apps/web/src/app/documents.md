---
title: Documents
---

<span id="public-demo-entry" hidden></span>

```js
import {apiClient} from "../lib/api.js";
import {actionPanel, buttonLink, documentFilterForm, documentUploadForm, documentWorkspace, errorView, pageHeader, publicDemoUploadNotice, toolbar, workspaceTopNav} from "../components/ui.js";
```

```js
display(workspaceTopNav());
const client = await apiClient();
const refreshPage = () => location.reload();
const params = new URLSearchParams(location.search);
const filters = {
  search: params.get("search") ?? "",
  projectId: params.get("projectId") ?? "",
  workItemId: params.get("workItemId") ?? "",
  category: params.get("category") ?? "",
  status: params.get("status") ?? ""
};
const documentsResult = await client.documents.list({...filters, signal: invalidation}).catch((error) => error);
const lookupResults = documentsResult instanceof Error
  ? []
  : await Promise.allSettled([
      client.projects.list({signal: invalidation}),
      client.planning.dashboard({signal: invalidation})
    ]);
```

```js
if (documentsResult instanceof Error) {
  display(errorView(documentsResult, refreshPage));
} else {
  const documents = documentsResult;
  const projects = lookupResults[0]?.status === "fulfilled" ? lookupResults[0].value : {items: []};
  const planning = lookupResults[1]?.status === "fulfilled" ? lookupResults[1].value : {items: []};
  const selectedProject = filters.projectId ? projects.items.find((project) => project.id === filters.projectId) : undefined;
  const selectedWorkItem = filters.workItemId ? planning.items.find((item) => item.id === filters.workItemId) : undefined;
  display(pageHeader({
    eyebrow: "Workspace",
    title: selectedWorkItem ? `${selectedWorkItem.title} documents` : selectedProject ? `${selectedProject.name} documents` : "Documents",
    description: client.isPublicDemo
      ? "Explore fictional briefs, decisions, designs, and evidence linked to the work they support."
      : "Files and decisions linked to the projects and tasks they support.",
    actions: client.isPublicDemo
      ? [buttonLink("Filter library", "#document-filters", {primary: true})]
      : [
          buttonLink("Upload document", "#upload-document", {primary: true}),
          buttonLink("Filter library", "#document-filters")
        ]
  }));
  display(actionPanel("Filter library", documentFilterForm({projects: projects.items, workItems: planning.items, filters}), {id: "document-filters", open: Boolean(filters.search || filters.projectId || filters.workItemId || filters.category || filters.status), meta: "Search, project, task, category, status"}));
  display(client.isPublicDemo
    ? publicDemoUploadNotice()
    : toolbar([
        actionPanel("Upload document", documentUploadForm(client, projects.items, {onSaved: refreshPage, selectedProjectId: filters.projectId, selectedWorkItemId: filters.workItemId, workItems: planning.items}), {id: "upload-document", open: !documents.items.length})
      ]));
  display(documentWorkspace(documents.items, client, {projects: projects.items, workItems: planning.items, onSaved: refreshPage}));
}
```
