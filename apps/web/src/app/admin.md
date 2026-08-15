---
title: Settings
---

<span id="public-demo-entry" hidden></span>

```js
import {apiClient} from "../lib/api.js";
import {accountManagementPanel, actionPanel, activityList, applicationDataSummary, buttonLink, configureWorkTaxonomy, documentsTable, errorView, membershipTable, pageHeader, profileForm, publicDemoTeamOverview, securityManagementPanel, teamManagementPanel, toolbar, viewTabs, workConfigurationEditor, workConfigurationSummary, workspaceTopNav} from "../components/ui.js";
```

```js
display(workspaceTopNav());
const client = await apiClient();
const refreshPage = () => location.reload();
const requestedSection = new URLSearchParams(location.search).get("section") ?? "";

function publicDemoSettingsNotice({fellBack = false} = {}) {
  const notice = document.createElement("section");
  notice.className = "public-demo-feature-notice";
  notice.setAttribute("role", "note");
  notice.setAttribute("aria-label", "Shared demo settings limits");
  const heading = document.createElement("strong");
  heading.textContent = fellBack ? "Showing shared demo settings" : "Shared demo settings";
  const copy = document.createElement("p");
  copy.textContent = `${fellBack ? "That settings area is not available here. " : ""}Accounts, Profile, Security, and member changes are disabled in the shared demo. Sign in to a private workspace to manage identity, access, and protected settings.`;
  notice.append(heading, copy);
  return notice;
}

async function loadSettingsSection(section) {
  if (section === "team") {
    const [memberships, projects] = await Promise.all([
      client.memberships.list({signal: invalidation}),
      client.projects.list({signal: invalidation})
    ]);
    const planning = client.isPublicDemo
      ? {items: (await Promise.all(projects.items.map((project) => client.workItems.list(project.id, {limit: 10, signal: invalidation})))).flatMap((page) => page.items)}
      : {items: []};
    return {memberships, projects, planning};
  }
  if (section === "accounts") {
    const [accounts, workspace] = await Promise.all([
      client.accounts.list({signal: invalidation}),
      client.workspace.get({signal: invalidation})
    ]);
    return {accounts, workspace};
  }
  if (section === "workflow") {
    return {workConfiguration: await client.workConfiguration.get({signal: invalidation})};
  }
  if (section === "security") {
    return {workspace: await client.workspace.get({signal: invalidation})};
  }
  if (section === "data") {
    if (client.isPublicDemo) {
      const [activity, documents, applicationData] = await Promise.all([
        client.activity.list({signal: invalidation}),
        client.documents.list({signal: invalidation}),
        client.applicationData.summary({signal: invalidation})
      ]);
      return {activity, documents, applicationData};
    }
    const [memberships, projects, activity, documents, applicationData] = await Promise.all([
      client.memberships.list({signal: invalidation}),
      client.projects.list({signal: invalidation}),
      client.activity.list({signal: invalidation}),
      client.documents.list({signal: invalidation}),
      client.applicationData.summary({signal: invalidation})
    ]);
    return {memberships, projects, activity, documents, applicationData};
  }
  return {};
}

const settingsResult = await (async () => {
  const me = await client.me({signal: invalidation});
  const isAdmin = me.membership?.role === "workspace-admin";
  const canManageWorkspace = isAdmin && !client.isPublicDemo;
  const sections = [
    {key: "team", label: "Team access", href: "/app/admin?section=team"},
    ...(canManageWorkspace ? [
      {key: "accounts", label: "Accounts", href: "/app/admin?section=accounts"}
    ] : []),
    ...(isAdmin || client.isPublicDemo ? [{key: "workflow", label: "Workflows", href: "/app/admin?section=workflow"}] : []),
    ...(!client.isPublicDemo ? [
      {key: "profile", label: "Profile", href: "/app/admin?section=profile"},
      {key: "security", label: "Security", href: "/app/admin?section=security"}
    ] : []),
    {key: "data", label: client.isPublicDemo ? "Data & activity" : "Data & audit", href: "/app/admin?section=data"}
  ];
  const requestedSectionIsAvailable = sections.some(({key}) => key === requestedSection);
  const publicDemoFallback = client.isPublicDemo && Boolean(requestedSection) && !requestedSectionIsAvailable;
  const section = requestedSectionIsAvailable
    ? requestedSection
    : (isAdmin || client.isPublicDemo) ? "team" : "profile";

  if (publicDemoFallback) {
    const canonicalUrl = new URL(location.href);
    canonicalUrl.searchParams.set("section", "team");
    history.replaceState(history.state, "", canonicalUrl);
  }

  const sectionData = await loadSettingsSection(section);
  return {me, isAdmin, canManageWorkspace, sections, section, publicDemoFallback, ...sectionData};
})().catch((error) => error);
```

```js
if (settingsResult instanceof Error) {
  display(errorView(settingsResult, refreshPage));
} else {
  const {me, isAdmin, canManageWorkspace, sections, section, publicDemoFallback, accounts, workspace, memberships, projects, planning, activity, documents, applicationData, workConfiguration} = settingsResult;
  if (workConfiguration) configureWorkTaxonomy(workConfiguration);
  const sectionCopy = {
    team: ["Team access", client.isPublicDemo ? "Meet the five fictional teammates behind the sample work." : isAdmin ? "Manage members, roles, and project access." : "Review the people and access in this workspace."],
    accounts: ["Accounts", "Switch workspaces and manage the current account."],
    workflow: ["Workflows", client.isPublicDemo ? "Try the task types, status columns, and transitions used by the sample team." : "Shape the task types, statuses, and transitions your team uses."],
    profile: ["Your profile", "Keep your workspace identity and regional preferences current."],
    security: ["Security", "Review authentication, protected storage, and permissions."],
    data: [client.isPublicDemo ? "Data & activity" : "Data & audit", client.isPublicDemo ? "Follow sample changes and inspect document metadata without exposing real files." : "Review workspace records, documents, and recent activity."]
  };
  const actions = {
    team: canManageWorkspace ? [buttonLink("Add member", "/app/admin?section=team#add-member", {primary: true})] : [],
    accounts: [
      buttonLink("Create account", "/app/admin?section=accounts#create-account", {primary: true}),
      buttonLink("Account settings", "/app/admin?section=accounts#account-settings")
    ],
    workflow: [],
    profile: [],
    security: [],
    data: [buttonLink(client.isPublicDemo ? "Open sample documents" : "Open documents", "/app/documents")]
  };
  display(pageHeader({
    eyebrow: "Workspace settings",
    title: sectionCopy[section][0],
    description: sectionCopy[section][1],
    actions: actions[section]
  }));
  display(viewTabs(sections, section));
  if (client.isPublicDemo) display(publicDemoSettingsNotice({fellBack: publicDemoFallback}));

  if (section === "team") {
    if (client.isPublicDemo) {
      display(publicDemoTeamOverview(memberships.items, projects.items, planning.items));
      display(actionPanel("Role and project access", membershipTable(memberships.items, projects.items), {id: "members", meta: `${memberships.items.length} fictional people`}));
    } else {
      display(canManageWorkspace
        ? teamManagementPanel(client, memberships.items, projects.items, {onSaved: refreshPage, showHeading: false})
        : actionPanel("Workspace members", membershipTable(memberships.items, projects.items), {open: true, id: "members"}));
    }
  } else if (section === "accounts") {
    display(accountManagementPanel(client, {accounts: accounts.items, currentAccountId: accounts.currentAccountId, workspace, onSaved: refreshPage, showHeading: false}));
  } else if (section === "workflow") {
    if (client.isPublicDemo) display(workConfigurationSummary(workConfiguration));
    display(actionPanel(client.isPublicDemo ? "Edit workflow configuration" : "Task types and status columns", workConfigurationEditor(client, workConfiguration, {onSaved: refreshPage}), {open: !client.isPublicDemo, id: "work-configuration", meta: client.isPublicDemo ? "Advanced · safe to edit · resets daily" : "Types, statuses, transitions"}));
  } else if (section === "profile") {
    display(actionPanel("Profile details", profileForm(client, me, {onSaved: refreshPage}), {open: true, id: "profile"}));
  } else if (section === "security") {
    display(securityManagementPanel({workspace, me, showHeading: false}));
  } else if (section === "data") {
    display(applicationDataSummary(applicationData, {sampleDocuments: client.isPublicDemo}));
    const dataPanels = [
      actionPanel("Recent activity", activityList(activity.items.slice(0, 25)), {open: true, id: "activity", meta: client.isPublicDemo ? `${Math.min(activity.items.length, 25)} sample changes` : `${Math.min(activity.items.length, 25)} changes`}),
      actionPanel(client.isPublicDemo ? "Sample document metadata" : "Documents", documentsTable(documents.items, client, {onSaved: refreshPage, workItems: []}), {id: "document-inventory", meta: client.isPublicDemo ? `${documents.items.length} records · file transfers off` : `${documents.items.length} documents`})
    ];
    if (!client.isPublicDemo) {
      dataPanels.unshift(actionPanel("Members", membershipTable(memberships.items, projects.items), {id: "members", meta: `${memberships.items.length} people`}));
    }
    display(toolbar(dataPanels));
  }
}
```
