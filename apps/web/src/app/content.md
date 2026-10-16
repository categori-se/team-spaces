---
title: Project content
---

```js
import {apiClient} from "../lib/api.js";
import {actionPanel, buttonLink, collaborativeContentEditor, emptyActionView, errorView, pageHeader, projectContentDetail, projectContentFilter, projectContentForm, projectContentList, toolbar, workspaceTopNav} from "../components/ui.js";
```

```js
display(workspaceTopNav());
const client = await apiClient();
const refreshPage = () => location.reload();
const params = new URLSearchParams(location.search);
const projectId = params.get("projectId") ?? "";
const contentId = params.get("contentId") ?? "";
const kind = params.get("kind") ?? "";
const status = params.get("status") ?? "";
const search = params.get("search") ?? "";
const shell = await Promise.all([
  client.projects.list({limit: 100, signal: invalidation}),
  client.me({signal: invalidation})
]).catch((error) => error);
```

```js
if (shell instanceof Error) {
  display(errorView(shell, refreshPage));
} else {
  const [projects, me] = shell;
  const selectedProject = projects.items.find((project) => project.id === projectId) ?? projects.items[0];
  const selectedProjectId = selectedProject?.id ?? "";
  const canManage = !client.isPublicDemo && ["workspace-admin", "portfolio-manager", "project-manager", "member"].includes(me.membership?.role);
  display(pageHeader({
    eyebrow: "Knowledge and discussion",
    title: selectedProject ? `${selectedProject.name} content` : "Project content",
    description: "Publish hierarchical wiki pages, collaboratively versioned documents, news, and forum discussions.",
    actions: selectedProject ? [canManage ? buttonLink("Create content", "#new-content", {primary: true}) : undefined, buttonLink("Open project", `/app/project?id=${encodeURIComponent(selectedProject.id)}`)].filter(Boolean) : []
  }));
  display(actionPanel("Find content", projectContentFilter(projects.items, {projectId: selectedProjectId, kind, status, search}), {open: !selectedProject, meta: "Project, type, status, and full text"}));

  if (!selectedProject) {
    display(emptyActionView("Create a project first", "Project content is isolated within a project.", {label: "Open projects", href: "/app/projects"}));
  } else {
    const contentResult = await client.projectContent.list(selectedProject.id, {kind: kind || undefined, status: status || undefined, search: search || undefined, limit: 100, signal: invalidation}).catch((error) => error);
    if (contentResult instanceof Error) {
      display(errorView(contentResult, refreshPage));
    } else {
      const selected = contentId ? await client.projectContent.get(selectedProject.id, contentId, {signal: invalidation}).catch((error) => error) : undefined;
      const revisions = selected && !(selected instanceof Error)
        ? await client.projectContent.revisions(selectedProject.id, selected.id, {signal: invalidation}).catch((error) => error)
        : undefined;
      const presence = selected && !(selected instanceof Error)
        ? await client.projectContent.presence(selectedProject.id, selected.id, {signal: invalidation}).catch((error) => error)
        : undefined;
      if (selected instanceof Error || revisions instanceof Error || presence instanceof Error) {
        display(errorView(selected instanceof Error ? selected : revisions instanceof Error ? revisions : presence, refreshPage));
      } else {
        if (selected) {
          display(projectContentDetail(selected, revisions?.items ?? [], client, {project: selectedProject, onSaved: () => location.assign(`/app/content?projectId=${encodeURIComponent(selectedProject.id)}`)}));
          if (canManage && selected.status !== "locked") display(actionPanel("Collaborative editor", collaborativeContentEditor(client, selectedProject, selected, presence?.items ?? [], {onSaved: refreshPage}), {open: true, meta: "Live presence, Markdown preview, macros, and immutable revisions"}));
          if (canManage) display(actionPanel("Edit content", projectContentForm(client, selectedProject, {content: selected, availableContent: contentResult.items, onSaved: refreshPage}), {id: "edit-content", meta: "Optimistic, immutable revisions"}));
        }
        display(actionPanel("Content library", projectContentList(contentResult.items, selectedProject.id), {open: true, meta: `${contentResult.items.length} records`}));
        if (canManage) display(toolbar([
          actionPanel("Create content", projectContentForm(client, selectedProject, {availableContent: contentResult.items, onSaved: (saved) => location.assign(`/app/content?projectId=${encodeURIComponent(selectedProject.id)}&contentId=${encodeURIComponent(saved.id)}`)}), {id: "new-content", open: !contentResult.items.length || location.hash === "#new-content", meta: "Wiki, document, news, or forum"})
        ]));
      }
    }
  }
}
```
