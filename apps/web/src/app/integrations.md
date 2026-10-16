---
title: Integrations
---

```js
import {apiClient} from "../lib/api.js";
import {actionPanel, buttonLink, directorySyncForm, errorView, externalShareForm, externalSharesTable, integrationCatalogSummary, integrationLinkForm, integrationLinksTable, jiraImportForm, outboundLinkCheckForm, pageHeader, providerIntegrationPanel, providerPermissionSyncForm, repositoriesTable, repositorySyncForm, repositoryTreeView, toolbar, webhookDeliveryPanel, workspaceTopNav, xwikiPageForm} from "../components/ui.js";
```

```js
display(workspaceTopNav());
const client = await apiClient();
const refreshPage = () => location.reload();
const integrationParams = new URLSearchParams(location.search);
const repositoryId = integrationParams.get("repositoryId") ?? "";
const repositoryPath = integrationParams.get("repositoryPath") ?? "";
const shell = await Promise.all([
  client.me({signal: invalidation}),
  client.projects.list({limit: 100, signal: invalidation}),
  client.planning.dashboard({limit: 100, signal: invalidation}),
  client.integrations.catalog({signal: invalidation}),
  client.integrations.links({signal: invalidation}),
  client.repositories.list({signal: invalidation})
]).catch((error) => error);
```

```js
if (shell instanceof Error) {
  display(errorView(shell, refreshPage));
} else {
  const [me, projects, planning, catalog, links, repositories] = shell;
  const canManage = !client.isPublicDemo && ["workspace-admin", "portfolio-manager", "project-manager", "member"].includes(me.membership?.role);
  const isAdmin = !client.isPublicDemo && me.membership?.role === "workspace-admin";
  const adminData = isAdmin
    ? await Promise.all([client.externalShares.list({signal: invalidation}), client.webhooks.deliveries({signal: invalidation})]).catch((error) => error)
    : [{items: []}, {items: []}];
  if (adminData instanceof Error) {
    display(errorView(adminData, refreshPage));
  } else {
    const [shares, deliveries] = adminData;
    display(pageHeader({
      eyebrow: "Interoperability hub",
      title: "Integrations and secure sharing",
      description: "Connect development, file, repository, issue, wiki, and collaboration systems to projects and tasks. Govern external access, navigation, directory sync, and outbound events from one place.",
      actions: [buttonLink("Configure capabilities", "/app/admin?section=capabilities"), canManage ? buttonLink("Link external record", "#link-record", {primary: true}) : undefined].filter(Boolean)
    }));
    display(actionPanel("Configured services", integrationCatalogSummary(catalog), {open: true, meta: `${catalog.connectors.length} connectors`}));
    display(actionPanel("Authenticated provider browser", providerIntegrationPanel(client, {projects: projects.items, workItems: planning.items, connectors: catalog.connectors, admin: isAdmin, onSaved: refreshPage}), {open: true, meta: "Provider-side files, pull requests, merge requests, and wiki pages"}));
    display(actionPanel("Linked records", integrationLinksTable(links.items, client, {onSaved: refreshPage}), {open: true, meta: `${links.items.length} links`}));
    display(actionPanel("Git and SVN repositories", repositoriesTable(repositories.items), {open: true, meta: `${repositories.items.length} repositories`}));
    if (repositoryId) {
      const tree = await client.repositories.tree(repositoryId, {path: repositoryPath, signal: invalidation}).catch((error) => error);
      display(tree instanceof Error ? errorView(tree, refreshPage) : actionPanel("Repository browser", repositoryTreeView(tree), {open: true, meta: tree.revision ?? tree.ref}));
    }
    display(actionPanel("Outbound-link policy check", outboundLinkCheckForm(client), {meta: "Allow, warn, capture, or block"}));

    if (canManage) {
      display(toolbar([
        actionPanel("Link external record", integrationLinkForm(client, {projects: projects.items, workItems: planning.items, connectors: catalog.connectors, onSaved: refreshPage}), {id: "link-record", open: !links.items.length, meta: "Development, files, folders, repositories, issues, wiki, collaboration"}),
        actionPanel("Import Jira issues", jiraImportForm(client, {projects: projects.items, connectors: catalog.connectors, onSaved: refreshPage}), {id: "jira-import", meta: "Bounded migration batches"})
      ]));
    }

    if (isAdmin) {
      display(actionPanel("Synchronize repository browser", repositorySyncForm(client, repositories.items, {onSaved: refreshPage}), {id: "repository-sync", meta: "Git or SVN tree mirror"}));
      display(actionPanel("Managed storage permissions", providerPermissionSyncForm(client, {projects: projects.items, connectors: catalog.connectors, onSaved: refreshPage}), {id: "provider-permissions", meta: "Reconcile project membership with provider access"}));
      display(actionPanel("Create an XWiki page", xwikiPageForm(client, {projects: projects.items, workItems: planning.items, connectors: catalog.connectors, onSaved: refreshPage}), {id: "xwiki-create", meta: "Create and link knowledge from a task"}));
      display(actionPanel("External task shares", externalSharesTable(shares.items, client, {onSaved: refreshPage}), {open: true, meta: `${shares.items.length} shares`}));
      display(toolbar([
        actionPanel("Share a task", externalShareForm(client, {projects: projects.items, workItems: planning.items, onSaved: refreshPage}), {id: "share-task", meta: "Recipient-bound read or comment access"}),
        actionPanel("Directory synchronization", directorySyncForm(client, {onSaved: refreshPage}), {id: "directory-sync", meta: "Verified LDAPS query, scheduled reconciliation, or normalized SCIM recovery"})
      ]));
      display(actionPanel("Webhook deliveries", webhookDeliveryPanel(client, catalog.webhooks, deliveries.items, {onSaved: refreshPage}), {id: "webhooks", meta: `${deliveries.items.length} deliveries`}));
    }
  }
}
```
