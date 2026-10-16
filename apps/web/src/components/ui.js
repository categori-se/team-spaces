// @ts-nocheck

import * as Plot from "@observablehq/plot";
import {beginSignIn, currentSession, handleAuthCallback, signOut} from "../lib/auth.js";

const svgTags = new Set(["circle", "ellipse", "line", "path", "polyline", "rect", "svg"]);

function el(tag, attrs = {}, children = []) {
  const node = svgTags.has(tag)
    ? document.createElementNS("http://www.w3.org/2000/svg", tag)
    : document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.setAttribute("class", String(value));
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function field(label, input) {
  return el("label", {class: "field"}, [el("span", {}, label), input]);
}

function textInput(name, placeholder = "", value = "") {
  return el("input", {name, placeholder, value});
}

function textareaInput(name, placeholder = "", value = "") {
  return el("textarea", {name, placeholder, rows: "3"}, value);
}

function selectInput(name, options, value = "") {
  const select = el("select", {name});
  replaceSelectOptions(select, options, value);
  return select;
}

function replaceSelectOptions(select, options, value = "") {
  select.replaceChildren();
  for (const option of options) {
    const optionValue = option.value ?? option;
    const label = option.label ?? (option || "Any");
    select.append(el("option", {value: optionValue}, label));
  }
  select.value = value;
}

function titleCase(value = "") {
  return String(value).replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value) {
  return value ? String(value).slice(0, 10) : "";
}

const dayMs = 24 * 60 * 60 * 1000;
export const maxMeetingPayloadBytes = 32 * 1024;

function dateMillis(value) {
  const text = formatDate(value);
  if (!text) return undefined;
  const time = new Date(`${text}T00:00:00Z`).getTime();
  return Number.isFinite(time) ? time : undefined;
}

function daysBetween(start, end) {
  return Math.round((end - start) / dayMs);
}

function formatHours(minutes = 0) {
  return `${Math.round(Number(minutes ?? 0) / 60 * 10) / 10}h`;
}

function projectHref(projectId, hash = "") {
  const suffix = hash ? `#${encodeURIComponent(hash)}` : "";
  return `/app/project?id=${encodeURIComponent(projectId)}${suffix}`;
}

function workItemHref(item) {
  return item.projectId ? projectHref(item.projectId, item.id) : `#${encodeURIComponent(item.id)}`;
}

function miniLinks(items = []) {
  return el("div", {class: "mini-links"}, items.filter((item) => item?.href).map((item) => (
    el("a", {href: item.href}, item.label)
  )));
}

function badge(value, tone = "neutral") {
  return el("span", {class: `badge badge--${tone}`}, titleCase(value));
}

function authStatusLabel(session) {
  if (!session) return "Checking session";
  if (session.authenticated && session.mode === "public-demo") return "Public demo";
  if (session.authenticated && session.mode === "demo") return "Demo access";
  if (session.authenticated && session.mode === "ldap") return "Directory session";
  if (session.authenticated) return "Signed in";
  return "Signed out";
}

function authStatusClass(session) {
  if (!session) return "checking";
  if (session.authenticated && session.mode === "public-demo") return "public-demo";
  if (session.authenticated && session.mode === "demo") return "demo";
  if (session.authenticated) return "signed-in";
  return "signed-out";
}

function authStatusMeta(session) {
  if (!session) return "One moment";
  if (session.authenticated && session.mode === "public-demo") {
    return session.publicDemo?.resetsAt ? `Resets at ${session.publicDemo.resetsAt}` : "Resets daily";
  }
  if (session.authenticated && session.mode === "demo") return "Local mode";
  if (session.authenticated && session.mode === "ldap") return "Verified LDAPS sign in";
  if (session.authenticated) return "Secure session";
  return "Sign in required";
}

export function authStatusIndicator(session) {
  const state = authStatusClass(session);
  return el("span", {
    class: `auth-status auth-status--${state}`,
    role: "status",
    "aria-live": "polite",
    "data-auth-status": state
  }, [
    el("span", {class: "auth-status__dot", "aria-hidden": "true"}),
    el("span", {class: "auth-status__label"}, authStatusLabel(session)),
    el("small", {}, authStatusMeta(session))
  ]);
}

function authActionButton(session) {
  if (!session) return el("button", {class: "button", type: "button", disabled: "true"}, "Checking...");
  const signedIn = Boolean(session?.authenticated);
  const isPublicDemo = session?.mode === "public-demo";
  const idleLabel = isPublicDemo ? "Exit demo" : signedIn ? "Sign out" : "Sign in";
  const busyLabel = isPublicDemo ? "Leaving demo..." : signedIn ? "Signing out..." : "Signing in...";
  const button = el("button", {class: `button${signedIn ? " button--ghost" : ""}`, type: "button"}, idleLabel);
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = busyLabel;
    try {
      await (signedIn ? signOut() : beginSignIn());
    } catch (error) {
      button.disabled = false;
      button.textContent = idleLabel;
      button.setAttribute("aria-label", error.message ?? "Authentication action failed");
    }
  });
  return button;
}

export function authControls(session) {
  return el("div", {class: "auth-controls"}, [
    authStatusIndicator(session),
    authActionButton(session)
  ]);
}

function decodeJwtPayload(token = "") {
  try {
    const payload = token.split(".")[1];
    if (!payload) return {};
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(atob(normalized));
  } catch {
    return {};
  }
}

function sessionIdentity(session) {
  if (!session) return {name: "Checking session", email: "One moment", mode: "pending"};
  if (session.authenticated && session.mode === "public-demo") {
    return {name: "Demo Visitor", email: "Shared sample workspace", mode: "public-demo"};
  }
  if (session.authenticated && session.mode === "demo") return {name: "Demo Admin", email: "admin@team-spaces.example", mode: "demo"};
  if (!session.authenticated) return {name: "Signed out", email: "Authentication required", mode: "cognito"};
  const claims = decodeJwtPayload(session.idToken);
  const email = claims.email ?? claims["cognito:username"] ?? "Signed-in user";
  return {
    name: claims.name ?? claims.given_name ?? email,
    email,
    mode: session.mode ?? "cognito"
  };
}

function menuLink(item) {
  return el("a", {href: item.href, class: "header-menu__item", role: "menuitem"}, [
    el("strong", {}, item.label),
    item.meta ? el("span", {}, item.meta) : ""
  ]);
}

let headerMenuSequence = 0;

function headerMenuTrigger(label, icon, panelId) {
  const triggerId = `${panelId}-trigger`;
  const chevron = uiIcon("chevron-down");
  chevron.setAttribute("class", "ui-icon header-menu__chevron");
  return el("summary", {
    id: triggerId,
    "aria-controls": panelId,
    "aria-expanded": "false",
    "aria-haspopup": "menu"
  }, [
    uiIcon(icon),
    el("span", {class: "header-menu__label"}, label),
    chevron
  ]);
}

function initializeHeaderMenu(menu) {
  const summary = menu.querySelector(":scope > summary");
  const syncExpandedState = () => summary?.setAttribute("aria-expanded", String(menu.open));
  menu.addEventListener("toggle", () => {
    if (menu.open) {
      const bar = menu.closest(".workspace-top-nav");
      for (const peer of bar?.querySelectorAll(".header-menu[open]") ?? []) {
        if (peer !== menu) {
          peer.open = false;
          peer.querySelector(":scope > summary")?.setAttribute("aria-expanded", "false");
        }
      }
    }
    syncExpandedState();
  });
  syncExpandedState();
  return menu;
}

function headerMenu(label, items = [], {icon = "settings"} = {}) {
  const panelId = `teamspaces-header-menu-${++headerMenuSequence}`;
  const summary = headerMenuTrigger(label, icon, panelId);
  return initializeHeaderMenu(el("details", {class: "header-menu", "data-header-menu": label.toLowerCase()}, [
    summary,
    el("div", {
      class: "header-menu__panel",
      id: panelId,
      role: "menu",
      "aria-labelledby": summary.id
    }, items.map(menuLink))
  ]));
}

function accountMenu(session) {
  const identity = sessionIdentity(session);
  const publicDemo = session?.mode === "public-demo";
  const items = publicDemo
    ? [
        {label: "Sample team", href: "/app/admin?section=team", meta: "Five fictional members and assignments"},
        {label: "Workflow columns", href: "/app/admin?section=workflow", meta: "Edit demo task types and statuses"},
        {label: "Demo activity", href: "/app/admin?section=data", meta: "Explore records and change history"}
      ]
    : [
        {label: "Profile", href: "/app/admin?section=profile", meta: "Name, role, preferences"},
        {label: "Account settings", href: "/app/admin?section=accounts", meta: "Workspace name, type, retention"},
        {label: "Team access", href: "/app/admin?section=team", meta: "Members, roles, project scopes"},
        {label: "Security & secrets", href: "/app/admin?section=security", meta: "Auth, storage, secret handling"},
        {label: "Data inventory", href: "/app/admin?section=data", meta: "Records, documents, activity"}
      ];
  const panelId = `teamspaces-header-menu-${++headerMenuSequence}`;
  const summary = headerMenuTrigger("Account", "profile", panelId);
  return initializeHeaderMenu(el("details", {
    class: "header-menu header-menu--account",
    "data-header-menu": "account"
  }, [
    summary,
    el("div", {
      class: "header-menu__panel",
      id: panelId,
      role: "menu",
      "aria-labelledby": summary.id
    }, [
      el("div", {class: "header-menu__identity", role: "presentation"}, [
        el("strong", {}, identity.name),
        el("span", {}, identity.email),
        el("small", {}, titleCase(identity.mode))
      ]),
      ...items.map(menuLink)
    ])
  ]));
}

const themeStorageKey = "teamspaces.theme";

function storedTheme() {
  try {
    const theme = localStorage.getItem(themeStorageKey);
    return theme === "dark" || theme === "light" ? theme : "";
  } catch {
    return "";
  }
}

function systemPrefersDark() {
  return Boolean(globalThis.matchMedia?.("(prefers-color-scheme: dark)")?.matches);
}

function effectiveTheme() {
  return storedTheme() || (systemPrefersDark() ? "dark" : "light");
}

function applyThemePreference(theme = storedTheme()) {
  if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function iconControl({label, icon, href, onClick}) {
  const attrs = {class: "icon-tray__item", title: label, "aria-label": label};
  const node = href ? el("a", {...attrs, href}, []) : el("button", {...attrs, type: "button"}, []);
  node.append(uiIcon(icon), el("span", {class: "icon-tray__label"}, label));
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

function themeToggleButton() {
  applyThemePreference();
  const button = iconControl({label: "Switch color theme", icon: effectiveTheme() === "dark" ? "sun" : "moon"});
  const sync = () => {
    const dark = effectiveTheme() === "dark";
    const label = dark ? "Switch to light mode" : "Switch to dark mode";
    button.setAttribute("title", label);
    button.setAttribute("aria-label", label);
    button.replaceChildren(uiIcon(dark ? "sun" : "moon"), el("span", {class: "icon-tray__label"}, label));
  };
  button.addEventListener("click", () => {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(themeStorageKey, next);
    } catch {
      // Ignore storage failures; the current document can still update.
    }
    applyThemePreference(next);
    sync();
  });
  globalThis.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", sync);
  sync();
  return button;
}

function headerTools() {
  return el("div", {class: "header-tools icon-tray", role: "toolbar", "aria-label": "Workspace utilities"}, [
    themeToggleButton()
  ]);
}

function headerSessionControls(session) {
  return el("div", {class: "header-session"}, [
    accountMenu(session),
    authControls(session)
  ]);
}

const createMenuItems = [
  {label: "Project", href: "/app/projects#new-project", meta: "Owner, portfolio, dates"},
  {label: "Task", href: "/app/planning#new-task", meta: "Status, owner, notes, documents"},
  {label: "Meeting", href: "/app/meetings#new-meeting", meta: "Participants, agenda, minutes"},
  {label: "Document", href: "/app/documents#upload-document", meta: "Project and task files"},
  {label: "Time entry", href: "/app/time#record-time", meta: "Project effort"}
];

function createMenuItemsForSession(session) {
  if (session?.mode !== "public-demo") return createMenuItems;
  return createMenuItems.filter((item) => item.label !== "Document");
}

const manageMenuItems = [
  {label: "Accounts", href: "/app/admin?section=accounts", meta: "Personal, team, client workspaces"},
  {label: "Team members", href: "/app/admin?section=team", meta: "Roles and project access"},
  {label: "Projects", href: "/app/projects", meta: "Delivery records"},
  {label: "Meetings", href: "/app/meetings", meta: "Project agendas and minutes"},
  {label: "Documents", href: "/app/documents", meta: "Workspace library"},
  {label: "Integrations", href: "/app/integrations", meta: "Connectors, repositories, sharing, and webhooks"},
  {label: "Workflows", href: "/app/admin?section=workflow", meta: "Task types, statuses, transitions"},
  {label: "Settings", href: "/app/admin?section=profile", meta: "Profile and account configuration"},
  {label: "Security & secrets", href: "/app/admin?section=security", meta: "Authentication and protected config"},
  {label: "Data & audit", href: "/app/admin?section=data", meta: "Inventory and history"}
];

function manageMenuItemsForSession(session) {
  if (session?.mode !== "public-demo") return manageMenuItems;
  return manageMenuItems
    .filter((item) => !["Accounts", "Settings", "Security & secrets"].includes(item.label))
    .map((item) => item.label === "Team members"
      ? {...item, meta: "View five fictional members and assignments"}
      : item);
}

export function publicDemoNotice(session) {
  if (session?.mode !== "public-demo") return "";
  const reset = session.publicDemo?.resetsAt ? ` at ${session.publicDemo.resetsAt}` : "";
  return el("aside", {
    class: "public-demo-notice",
    role: "note",
    "aria-label": "Public demo information"
  }, [
    el("strong", {}, "Shared public demo"),
    el("span", {}, `Explore and edit the sample workspace. Changes reset daily${reset}; editing may pause if the shared limit is reached.`),
    el("span", {class: "public-demo-notice__privacy"}, "Do not enter sensitive or personal information.")
  ]);
}

export function publicDemoUploadNotice() {
  return el("section", {
    class: "public-demo-feature-notice",
    role: "note",
    "aria-label": "Public demo file transfer limits"
  }, [
    el("strong", {}, "Sample document records — file transfers are off"),
    el("p", {}, "Open the embedded fictional previews, follow their project and task links, edit metadata, and archive or restore records. Private workspaces add protected upload and download through S3.")
  ]);
}

function statusTone(value) {
  if (closedWorkStatuses.has(value)) return "good";
  return {
    active: "good",
    complete: "good",
    done: "good",
    "on-track": "good",
    watch: "watch",
    ready: "watch",
    "in-progress": "info",
    proposed: "neutral",
    intake: "neutral",
    paused: "neutral",
    "at-risk": "danger",
    blocked: "danger",
    critical: "danger",
    high: "watch"
  }[value] ?? "neutral";
}

const workTypes = ["task", "feature", "bug", "milestone", "risk", "issue"];
const workStatusList = ["intake", "ready", "in-progress", "blocked", "done"];
const workTypeLabels = new Map(workTypes.map((id) => [id, titleCase(id)]));
const workStatusLabels = new Map([
  ["intake", "Intake"],
  ["ready", "Ready"],
  ["in-progress", "In progress"],
  ["blocked", "Blocked"],
  ["done", "Done"]
]);
const configuredWorkTypeIds = new Set(workTypes);
const configuredWorkStatusIds = new Set(workStatusList);
const closedWorkStatuses = new Set(["done"]);
let configuredDefaultTypeId = "task";
let configuredDefaultStatusId = "intake";
const intakeGroupList = ["ideas", "bugs", "maintenance", "ready"];
const projectStatusList = ["proposed", "active", "paused", "complete", "archived"];
const healthStateList = ["on-track", "watch", "at-risk", "blocked"];
const priorityList = ["low", "medium", "high", "critical"];
function workPriorityOptions(capabilities = {}, current = "") {
  const configured = (capabilities.priorities ?? []).filter((priority) => priority.active !== false).map((priority) => ({value: priority.id, label: priority.name ?? priority.label ?? titleCase(priority.id)}));
  const options = configured.length ? configured : priorityList.map((value) => ({value, label: titleCase(value)}));
  if (current && !options.some((option) => option.value === current)) options.push({value: current, label: titleCase(current)});
  return options;
}
const projectModuleOptions = ["work", "meetings", "documents", "time", "wiki", "news", "forums"]
  .map((value) => ({value, label: titleCase(value)}));
const workRelationTypeList = ["predecessor", "successor", "blocks", "blocked-by", "duplicates", "duplicated-by", "related"];
const lifecyclePhaseList = ["Proposed", "Approved", "Planning", "Execution", "Closing", "Closed"];
const accountTypeOptions = [
  {value: "personal", label: "Personal"},
  {value: "team", label: "Team"},
  {value: "client", label: "Client"}
];
const roleOptions = [
  {value: "workspace-admin", label: "Workspace admin"},
  {value: "portfolio-manager", label: "Portfolio manager"},
  {value: "project-manager", label: "Project manager"},
  {value: "member", label: "Member"},
  {value: "viewer", label: "Viewer"}
];
const documentCategories = ["brief", "decision", "design", "contract", "evidence", "other"];
const meetingStatusList = ["draft", "open", "in-progress", "closed", "cancelled"];
const meetingStatusTransitions = Object.freeze({
  draft: ["open", "cancelled"],
  open: ["in-progress", "closed", "cancelled"],
  "in-progress": ["open", "closed", "cancelled"],
  closed: ["open"],
  cancelled: ["open"]
});

function intakeGroupLabel(value) {
  return {
    ideas: "Ideas",
    bugs: "Bugs",
    maintenance: "Maintenance",
    ready: "Ready for planning",
    unbucketed: "Unbucketed"
  }[value] ?? titleCase(value);
}

function workTypeLabel(value = "") {
  return workTypeLabels.get(value) ?? titleCase(value);
}

function workStatusLabel(value = "") {
  return workStatusLabels.get(value) ?? titleCase(value);
}

function workTypeOptions(currentValue = "") {
  const values = currentValue && !workTypes.includes(currentValue) ? [...workTypes, currentValue] : workTypes;
  return values.map((value) => ({
    value,
    label: `${workTypeLabel(value)}${configuredWorkTypeIds.has(value) && !workTypes.includes(value) ? " (inactive)" : ""}`
  }));
}

function workStatusOptions(currentValue = "") {
  const values = currentValue && !workStatusList.includes(currentValue) ? [...workStatusList, currentValue] : workStatusList;
  return values.map((value) => ({
    value,
    label: `${workStatusLabel(value)}${configuredWorkStatusIds.has(value) && !workStatusList.includes(value) ? " (inactive)" : ""}`
  }));
}

function workTypeValues(items = []) {
  return [...new Set([...workTypes, ...items.map((item) => item?.type).filter(Boolean)])];
}

function workStatusValues(items = []) {
  return [...new Set([...workStatusList, ...items.map((item) => item?.status).filter(Boolean)])];
}

export function configureWorkTaxonomy(configuration = {}) {
  const types = Array.isArray(configuration?.types)
    ? configuration.types.filter((item) => item && typeof item.id === "string" && typeof item.label === "string")
    : [];
  const statuses = Array.isArray(configuration?.statuses)
    ? configuration.statuses.filter((item) => item && typeof item.id === "string" && typeof item.label === "string")
    : [];
  if (!types.length || !statuses.length) return;

  workTypeLabels.clear();
  configuredWorkTypeIds.clear();
  for (const type of types) {
    workTypeLabels.set(type.id, type.label);
    configuredWorkTypeIds.add(type.id);
  }
  workTypes.splice(0, workTypes.length, ...types.filter((type) => type.active).map((type) => type.id));

  workStatusLabels.clear();
  configuredWorkStatusIds.clear();
  closedWorkStatuses.clear();
  for (const status of statuses) {
    workStatusLabels.set(status.id, status.label);
    configuredWorkStatusIds.add(status.id);
    if (status.closed) closedWorkStatuses.add(status.id);
  }
  workStatusList.splice(0, workStatusList.length, ...statuses.filter((status) => status.active).map((status) => status.id));

  configuredDefaultTypeId = workTypes.includes(configuration.defaultTypeId) ? configuration.defaultTypeId : workTypes[0];
  configuredDefaultStatusId = workStatusList.includes(configuration.defaultStatusId) ? configuration.defaultStatusId : workStatusList[0];
}

function isClosedWorkStatus(status) {
  return status === "complete" || closedWorkStatuses.has(status);
}

function displayCustomFields(fields = {}, exclude = []) {
  const excluded = new Set(exclude);
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !excluded.has(key)));
}

function csvList(value = []) {
  return Array.isArray(value) ? value.filter(Boolean).join(", ") : String(value ?? "");
}

function formatKeyValueLines(record = {}) {
  return Object.entries(record).map(([key, value]) => `${key}: ${value}`).join("\n");
}

function parseKeyValueLines(text = "") {
  return Object.fromEntries(String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.search(/[:=]/);
      if (index < 0) return [line, ""];
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    })
    .filter(([key]) => key));
}

function formatWorkRelations(relations = [], byId = new Map()) {
  return relations.map((relation) => `${relation.type}: ${byId.get(relation.targetId)?.title ?? relation.targetId}${relation.lagDays ? `: ${relation.lagDays}` : ""}`).join("\n");
}

function parseWorkRelationLines(text = "", workItems = []) {
  const titleIds = new Map(workItems.map((item) => [String(item.title).toLowerCase(), item.id]));
  return String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [rawType, rawTarget, rawLag] = line.split(":").map((part) => part.trim());
    const type = rawType.toLowerCase().replaceAll(" ", "-");
    if (!workRelationTypeList.includes(type) || !rawTarget) throw new Error(`Use relation lines like "predecessor: task-id: 2". Invalid line: ${line}`);
    const targetId = titleIds.get(rawTarget.toLowerCase()) ?? rawTarget;
    const lagDays = rawLag ? Number(rawLag) : 0;
    if (!Number.isInteger(lagDays) || lagDays < -3650 || lagDays > 3650) throw new Error(`Relation lag must be a whole number of days: ${line}`);
    return {type, targetId, lagDays};
  });
}

function formValues(form) {
  const data = {};
  for (const [key, value] of new FormData(form).entries()) {
    if (data[key] === undefined) data[key] = value;
    else if (Array.isArray(data[key])) data[key].push(value);
    else data[key] = [data[key], value];
  }
  return data;
}

function memberOptions(memberships = [], emptyLabel = "Unassigned") {
  return [
    {value: "", label: emptyLabel},
    ...memberships.map((membership) => ({
      value: membership.userId,
      label: membership.name ?? membership.email ?? membership.userId
    }))
  ];
}

function memberName(memberships = [], userId) {
  if (!userId) return "Unassigned";
  const match = memberships.find((membership) => membership.userId === userId);
  return match?.name ?? match?.email ?? userId;
}

function teamOptions(capabilities = {}) {
  return [
    {value: "", label: "No team"},
    ...(capabilities.groups ?? []).map((group) => ({value: group.id, label: group.name ?? group.label ?? group.id}))
  ];
}

function teamName(capabilities = {}, teamId) {
  if (!teamId) return "No team";
  const match = (capabilities.groups ?? []).find((group) => group.id === teamId);
  return match?.name ?? match?.label ?? teamId;
}

function csvValues(value = "") {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function projectOptions(projects = [], emptyLabel = "Select project") {
  return [
    {value: "", label: emptyLabel},
    ...projects.map((project) => ({value: project.id, label: project.name ?? project.id}))
  ];
}

function taskOptions(workItems = [], projectId = "", emptyLabel = "No linked task") {
  const filtered = projectId ? workItems.filter((item) => item.projectId === projectId) : workItems;
  return [
    {value: "", label: emptyLabel},
    ...filtered.map((item) => ({
      value: item.id,
      label: `${item.projectName ? `${item.projectName} / ` : ""}${item.title ?? item.id}`
    }))
  ];
}

function workItemLookup(workItems = []) {
  return new Map(workItems.map((item) => [item.id, item]));
}

function multiSelectInput(name, options, values = []) {
  const selected = new Set(Array.isArray(values) ? values : csvValues(csvList(values)));
  const select = el("select", {name, multiple: "true", size: String(Math.min(5, Math.max(2, options.length)))});
  for (const option of options) {
    const optionValue = option.value ?? option;
    const attrs = {value: optionValue};
    if (selected.has(optionValue)) attrs.selected = "true";
    select.append(el("option", attrs, option.label ?? optionValue));
  }
  return el("div", {class: "multi-select"}, [
    el("input", {type: "hidden", name, value: ""}),
    select
  ]);
}

function progressBar(value = 0) {
  const normalized = Math.max(0, Math.min(100, Number(value) || 0));
  return el("div", {
    class: "progress",
    role: "progressbar",
    "aria-label": "Completion",
    "aria-valuemin": "0",
    "aria-valuemax": "100",
    "aria-valuenow": String(normalized)
  }, [
    el("span", {style: `width: ${normalized}%`}),
    el("strong", {}, `${normalized}%`)
  ]);
}

export function pageHeader({eyebrow = "Workspace", title, description = "", actions = []}) {
  return el("section", {class: "page-header"}, [
    el("div", {}, [
      el("p", {class: "eyebrow"}, eyebrow),
      el("h1", {}, title),
      description ? el("p", {class: "page-header__description"}, description) : ""
    ]),
    actions.length ? el("div", {class: "page-header__actions"}, actions) : ""
  ]);
}

export function buttonLink(label, href, {primary = false} = {}) {
  return el("a", {class: `button${primary ? " button--primary" : ""}`, href}, label);
}

export function cursorPager(pageInfo = {}, {path = location.pathname, params = {}, hasCursor = false, resourceName = "task"} = {}) {
  if (!hasCursor && !pageInfo.hasNextPage) return "";
  const nextParams = new URLSearchParams(params instanceof URLSearchParams ? params : undefined);
  if (!(params instanceof URLSearchParams)) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") nextParams.set(key, String(value));
    }
  }
  if (pageInfo.endCursor) nextParams.set("cursor", pageInfo.endCursor);
  const nextHref = `${path}${nextParams.size ? `?${nextParams}` : ""}`;
  const previous = hasCursor
    ? el("button", {class: "button", type: "button", onclick: () => history.back()}, "Previous page")
    : "";
  return el("nav", {class: "cursor-pager", "aria-label": `${titleCase(resourceName)} pages`}, [
    el("span", {}, `Showing one ${resourceName} page at a time.`),
    el("div", {class: "cursor-pager__actions"}, [
      previous,
      pageInfo.hasNextPage ? buttonLink("Next page", nextHref, {primary: true}) : ""
    ])
  ]);
}

export function focusSurface({title, description = "", actions = [], steps = []} = {}) {
  return el("section", {class: "focus-surface"}, [
    el("div", {class: "focus-surface__main"}, [
      title ? el("h2", {}, title) : "",
      description ? el("p", {}, description) : "",
      actions.length ? el("div", {class: "focus-surface__actions"}, actions) : ""
    ]),
    steps.length
      ? el("ol", {class: "focus-surface__steps", "aria-label": "Common workflow"}, steps.map((step) => (
        el("li", {}, [
          step.href ? el("a", {href: step.href}, step.label) : el("strong", {}, step.label),
          step.meta ? el("span", {}, step.meta) : ""
        ])
      )))
      : ""
  ]);
}

export function emptyActionView(title, description = "", action = undefined) {
  return el("div", {class: "state state--empty state--action"}, [
    el("strong", {}, title),
    description ? el("span", {}, description) : "",
    action?.href ? buttonLink(action.label, action.href, {primary: true}) : ""
  ]);
}

function uiIcon(name = "settings") {
  const icon = el("svg", {
    class: "ui-icon",
    viewBox: "0 0 24 24",
    width: "18",
    height: "18",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false"
  });
  const shapes = {
    profile: [
      el("circle", {cx: "12", cy: "8", r: "4"}),
      el("path", {d: "M4 21a8 8 0 0 1 16 0"})
    ],
    accounts: [
      el("rect", {x: "3", y: "5", width: "18", height: "16", rx: "2"}),
      el("path", {d: "M7 9h10M7 13h7M7 17h5"})
    ],
    team: [
      el("circle", {cx: "9", cy: "8", r: "3"}),
      el("path", {d: "M3 21a6 6 0 0 1 12 0"}),
      el("path", {d: "M16 11a3 3 0 1 0 0-6"}),
      el("path", {d: "M18 21a6 6 0 0 0-3-5.2"})
    ],
    settings: [
      el("circle", {cx: "12", cy: "12", r: "3"}),
      el("path", {d: "M12 2l1.2 2.4 2.6.4.5 2.6 2.1 1.6-1.2 2.4 1.2 2.4-2.1 1.6-.5 2.6-2.6.4L12 22l-1.2-2.4-2.6-.4-.5-2.6-2.1-1.6 1.2-2.4-1.2-2.4 2.1-1.6.5-2.6 2.6-.4L12 2z"})
    ],
    sliders: [
      el("path", {d: "M4 6h3M11 6h9"}),
      el("circle", {cx: "9", cy: "6", r: "2"}),
      el("path", {d: "M4 12h9M17 12h3"}),
      el("circle", {cx: "15", cy: "12", r: "2"}),
      el("path", {d: "M4 18h1M9 18h11"}),
      el("circle", {cx: "7", cy: "18", r: "2"})
    ],
    sun: [
      el("circle", {cx: "12", cy: "12", r: "4"}),
      el("path", {d: "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"})
    ],
    moon: [
      el("path", {d: "M20 14.5A8 8 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z"})
    ],
    sidebar: [
      el("rect", {x: "3", y: "4", width: "18", height: "16", rx: "2"}),
      el("path", {d: "M8 4v16M12 9h5M12 13h5"})
    ],
    security: [
      el("path", {d: "M12 3l7 4v5c0 5-3 8-7 9-4-1-7-4-7-9V7l7-4z"})
    ],
    data: [
      el("ellipse", {cx: "12", cy: "5", rx: "7", ry: "3"}),
      el("path", {d: "M5 5v14c0 1.7 3.1 3 7 3s7-1.3 7-3V5"}),
      el("path", {d: "M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"})
    ],
    add: [
      el("path", {d: "M12 5v14M5 12h14"})
    ],
    "chevron-down": [
      el("path", {d: "M7 10l5 5 5-5"})
    ],
    document: [
      el("path", {d: "M6 3h8l4 4v14H6z"}),
      el("path", {d: "M14 3v5h5M9 13h6M9 17h6"})
    ],
    activity: [
      el("path", {d: "M4 12h4l2-6 4 12 2-6h4"})
    ]
  };
  icon.append(...(shapes[name] ?? shapes.settings));
  return icon;
}

export function iconTray(items = [], {label = "Tools", compact = false} = {}) {
  const links = items.filter((item) => item?.href);
  if (!links.length) return "";
  return el("nav", {class: `icon-tray${compact ? " icon-tray--compact" : ""}`, "aria-label": label}, links.map((item) => {
    const attrs = {class: "icon-tray__item", href: item.href, title: item.label, "aria-label": item.label};
    if (item.current) attrs["aria-current"] = "page";
    return el("a", attrs, [
      uiIcon(item.icon),
      el("span", {class: "icon-tray__label"}, item.label)
    ]);
  }));
}

export function accountToolsTray({compact = false} = {}) {
  return iconTray([
    {label: "Profile", href: "/app/admin?section=profile", icon: "profile"},
    {label: "Accounts", href: "/app/admin?section=accounts", icon: "accounts"},
    {label: "Team access", href: "/app/admin?section=team", icon: "team"},
    {label: "Workflows", href: "/app/admin?section=workflow", icon: "settings"},
    {label: "Security", href: "/app/admin?section=security", icon: "security"},
    {label: "Data inventory", href: "/app/admin?section=data", icon: "data"}
  ], {label: "Account tools", compact});
}

export function viewTabs(items, active) {
  return el("nav", {class: "view-tabs", "aria-label": "Workspace views"}, items.map((item) => (
    el("a", {href: item.href, class: item.key === active ? "is-active" : ""}, item.label)
  )));
}

export function toolbar(items = []) {
  return el("div", {class: "toolbar"}, items);
}

export function actionPanel(title, content, {open = false, meta = "", id = ""} = {}) {
  const attrs = {class: "action-panel"};
  if (open || (id && location.hash === `#${id}`)) attrs.open = "true";
  if (id) attrs.id = id;
  const panel = el("details", attrs, [
    el("summary", {}, [
      el("span", {}, title),
      meta ? el("small", {}, meta) : ""
    ])
  ]);
  panel.append(content);
  if (id) {
    window.addEventListener("hashchange", () => {
      if (location.hash === `#${id}`) panel.open = true;
    });
  }
  return panel;
}

export function loadingView(text) {
  return el("div", {class: "state", role: "status", "aria-live": "polite", "aria-busy": "true"}, text);
}

export function emptyView(text) {
  return el("div", {class: "state state--empty"}, text);
}

export function errorView(error, onRetry) {
  return el("div", {class: "state state--error", role: "alert", "aria-live": "assertive"}, [
    el("strong", {}, error.message ?? "Request failed"),
    el("button", {class: "button", type: "button", onclick: onRetry}, "Retry")
  ]);
}

function topMenuSummary(menu) {
  return menu?.querySelector(":scope > summary");
}

function closeTopMenu(menu, {restoreFocus = false} = {}) {
  if (!menu) return;
  menu.open = false;
  const summary = topMenuSummary(menu);
  summary?.setAttribute("aria-expanded", "false");
  if (restoreFocus) summary?.focus();
}

function topMenuItems(menu) {
  return [...(menu?.querySelectorAll(".header-menu__panel [role='menuitem']") ?? [])];
}

function closeTopMenuPeers(bar, activeMenu = undefined) {
  for (const menu of bar.querySelectorAll(".header-menu[open]")) {
    if (menu !== activeMenu) closeTopMenu(menu);
  }
}

function openTopMenu(bar, menu) {
  closeTopMenuPeers(bar, menu);
  menu.open = true;
  topMenuSummary(menu)?.setAttribute("aria-expanded", "true");
}

function closestElement(target, selector) {
  return typeof target?.closest === "function" ? target.closest(selector) : undefined;
}

export function initializeTopMenuBar(bar) {
  const ownerDocument = bar.ownerDocument;
  const outsidePointerHandler = (event) => {
    if (!bar.isConnected) {
      ownerDocument.removeEventListener("pointerdown", outsidePointerHandler);
      ownerDocument.removeEventListener("keydown", keyHandler);
      ownerDocument.removeEventListener("focusin", focusHandler);
      return;
    }
    if (!bar.contains(event.target)) closeTopMenuPeers(bar);
  };
  const focusHandler = (event) => {
    if (!bar.isConnected) return;
    const focusedMenu = closestElement(event.target, ".header-menu");
    if (!bar.contains(event.target)) closeTopMenuPeers(bar);
    else closeTopMenuPeers(bar, focusedMenu);
  };
  const keyHandler = (event) => {
    if (!bar.isConnected) return;
    const menu = closestElement(event.target, ".header-menu");
    const summary = closestElement(event.target, ".header-menu > summary");
    const item = closestElement(event.target, "[role='menuitem']");
    const openMenu = bar.querySelector(".header-menu[open]");

    if (event.key === "Escape" && openMenu) {
      event.preventDefault();
      closeTopMenu(openMenu, {restoreFocus: true});
      return;
    }
    if (!menu || !bar.contains(menu)) return;

    if (summary && summary.parentElement === menu) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        openTopMenu(bar, menu);
        const items = topMenuItems(menu);
        items[event.key === "ArrowDown" ? 0 : items.length - 1]?.focus();
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const summaries = [...bar.querySelectorAll(".header-menu > summary")];
        const index = summaries.indexOf(summary);
        const offset = event.key === "ArrowRight" ? 1 : -1;
        closeTopMenu(menu);
        summaries[(index + offset + summaries.length) % summaries.length]?.focus();
      }
      return;
    }

    if (!item) return;
    const items = topMenuItems(menu);
    const index = items.indexOf(item);
    let nextIndex;
    if (event.key === "ArrowDown") nextIndex = (index + 1) % items.length;
    else if (event.key === "ArrowUp") nextIndex = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex !== undefined) {
      event.preventDefault();
      items[nextIndex]?.focus();
    }
  };

  bar.addEventListener("click", (event) => {
    const summary = closestElement(event.target, ".header-menu > summary");
    const menu = summary?.parentElement;
    if (menu && bar.contains(menu) && !menu.open) closeTopMenuPeers(bar, menu);
    const link = closestElement(event.target, ".header-menu__item");
    if (link) closeTopMenu(closestElement(link, ".header-menu"));
  });
  ownerDocument.addEventListener("pointerdown", outsidePointerHandler);
  ownerDocument.addEventListener("keydown", keyHandler);
  ownerDocument.addEventListener("focusin", focusHandler);
  return bar;
}

export function workspaceTopNav() {
  let cachedBranding = {};
  try {
    cachedBranding = JSON.parse(localStorage.getItem("teamspaces.workspaceBranding") ?? "{}");
  } catch {
    // Use the product identity until workspace branding is loaded.
  }
  const sessionHost = el("div", {class: "workspace-top-nav__session"}, headerSessionControls(undefined));
  const createMenu = headerMenu("Create", createMenuItems, {icon: "add"});
  const manageMenu = headerMenu("Manage", manageMenuItems, {icon: "sliders"});
  const noticeHost = el("div", {class: "workspace-top-nav__notice"});
  const bar = initializeTopMenuBar(el("header", {class: "workspace-top-nav app-header"}, [
    el("div", {class: "app-header__bar"}, [
      el("a", {class: "app-header__brand", href: "/app"}, [
        cachedBranding.logoUrl ? el("img", {class: "app-header__brand-logo", src: cachedBranding.logoUrl, alt: ""}) : "",
        el("strong", {}, cachedBranding.organizationName || "Team Spaces"),
        el("span", {}, "Workspace")
      ]),
      el("div", {class: "app-header__menus"}, [
        headerTools(),
        createMenu,
        manageMenu,
        sessionHost
      ])
    ]),
    noticeHost
  ]));
  const capabilityListener = (event) => {
    if (!bar.isConnected) {
      window.removeEventListener("teamspaces:capabilities", capabilityListener);
      return;
    }
    applyWorkspaceCapabilities(event.detail ?? {});
  };
  window.addEventListener("teamspaces:capabilities", capabilityListener);
  handleAuthCallback()
    .catch(() => undefined)
    .then(() => currentSession())
    .then((session) => {
      sessionHost.replaceChildren(headerSessionControls(session));
      if (session.mode === "public-demo") {
        createMenu.replaceWith(headerMenu("Create", createMenuItemsForSession(session), {icon: "add"}));
        manageMenu.replaceWith(headerMenu("Manage", manageMenuItemsForSession(session), {icon: "sliders"}));
        noticeHost.replaceChildren(publicDemoNotice(session));
      }
    })
    .catch(() => sessionHost.replaceChildren(headerSessionControls({authenticated: false, mode: "cognito"})));
  return bar;
}

export const authBar = workspaceTopNav;

export function contextLinks(title, items = []) {
  const links = items.filter((item) => item?.href);
  if (!links.length) return "";
  return el("section", {class: "context-links"}, [
    el("div", {class: "section-heading"}, el("h2", {}, title)),
    el("div", {class: "context-links__grid"}, links.map((item) => (
      el("a", {href: item.href, class: "context-link"}, [
        el("strong", {}, item.label),
        item.meta ? el("span", {}, item.meta) : ""
      ])
    )))
  ]);
}

export function workspaceActionLinks() {
  return contextLinks("Next actions", [
    {label: "Review projects", href: "/app/projects", meta: "Open the portfolio work list"},
    {label: "Plan tasks", href: "/app/planning", meta: "Shape periods, workflow steps, milestones, and assignments"},
    {label: "Attach documents", href: "/app/documents", meta: "Link evidence to delivery"},
    {label: "Record time", href: "/app/time", meta: "Capture effort by project"}
  ]);
}

export function projectActionLinks(project) {
  if (!project?.id) return "";
  return contextLinks("Project actions", [
    {label: "Create task", href: projectHref(project.id, "new-task"), meta: "Define the smallest unit of project work"},
    {label: "Attach evidence", href: `/app/documents?projectId=${encodeURIComponent(project.id)}`, meta: "Upload briefs, decisions, and contracts"},
    {label: "Record time", href: `/app/time?projectId=${encodeURIComponent(project.id)}`, meta: "Log effort against this project"},
    {label: "Open task views", href: `/app/planning?projectId=${encodeURIComponent(project.id)}`, meta: "See boards, lists, dates, assignments, and dependencies"}
  ]);
}

function entries(record) {
  return Object.entries(record ?? {}).map(([name, value]) => ({name, value}));
}

export function portfolioHealthChart(summary) {
  const data = entries(summary.byHealth);
  const healthColors = new Map([
    ["on-track", "#2da44e"],
    ["watch", "#bf8700"],
    ["at-risk", "#d97706"],
    ["blocked", "#cf222e"]
  ]);
  const chart = Plot.plot({
    width: 720,
    height: 220,
    marginLeft: 90,
    x: {grid: true, label: "Projects"},
    y: {label: null},
    marks: [
      Plot.barX(data, {x: "value", y: "name", fill: (row) => healthColors.get(row.name) ?? "#6e7781", rx: 2}),
      Plot.text(data, {x: "value", y: "name", text: "value", dx: 12})
    ]
  });
  const table = dataTable(["Health", "Projects"], data.map((row) => [badge(row.name, statusTone(row.name)), row.value]));
  return el("section", {class: "viz-band", id: "portfolio-health"}, [el("h2", {}, "Projects by health"), el("div", {class: "chart-scroll"}, chart), table]);
}

export function projectTimeline(projects) {
  const rows = projects.filter((project) => project.startDate && project.targetDate);
  if (!rows.length) return emptyView("No dated projects yet.");
  const chart = Plot.plot({
    width: 780,
    height: Math.max(180, rows.length * 30 + 50),
    marginLeft: 140,
    x: {type: "time", grid: true},
    y: {label: null},
    marks: [
      Plot.barX(rows, {
        x1: (d) => new Date(d.startDate),
        x2: (d) => new Date(d.targetDate),
        y: "name",
        fill: (d) => d.health === "at-risk" || d.health === "blocked" ? "#d95d4f" : "#2986cc",
        rx: 2
      }),
      Plot.dot(rows, {x: (d) => new Date(d.targetDate), y: "name", fill: "#151923"})
    ]
  });
  const table = dataTable(["Project", "Start", "Target", "Health"], rows.map((project) => [
    project.name,
    formatDate(project.startDate),
    formatDate(project.targetDate),
    badge(project.health ?? "on-track", statusTone(project.health ?? "on-track"))
  ]));
  return el("section", {class: "viz-band"}, [el("h2", {}, "Project timeline"), el("div", {class: "chart-scroll"}, chart), table]);
}

function dataTable(headers, rows) {
  const isKeyValue = headers.length === 2 && headers[0] === "Field" && headers[1] === "Value";
  const headerLabel = (header) => typeof header === "string"
    ? header
    : header?.getAttribute?.("data-column-label") ?? header?.textContent ?? "";
  return el("div", {class: `table-frame${isKeyValue ? " table-frame--key-value" : ""}`}, el("table", {class: "data-table"}, [
    el("thead", {}, el("tr", {}, headers.map((header) => el("th", {scope: "col"}, header)))),
    el("tbody", {}, rows.map((row) => el("tr", {}, row.map((cell, index) => (
      el("td", {"data-label": headerLabel(headers[index])}, cell ?? "")
    )))))
  ]));
}

export function projectTable(projects, lookups = {}) {
  const portfolios = new Map((lookups.portfolios ?? []).map((item) => [item.id, item.name]));
  const rows = projects.map((project) => [
    el("div", {class: "object-cell"}, [
      el("a", {href: `/app/project?id=${encodeURIComponent(project.id)}`}, project.name),
      el("span", {}, portfolios.get(project.portfolioId) || "No portfolio"),
      miniLinks([
        {label: "Tasks", href: projectHref(project.id, "new-task")},
        {label: "Docs", href: `/app/documents?projectId=${encodeURIComponent(project.id)}`},
        {label: "Time", href: `/app/time?projectId=${encodeURIComponent(project.id)}`}
      ])
    ]),
    badge(project.status, statusTone(project.status)),
    badge(project.health, statusTone(project.health)),
    badge(project.priority, statusTone(project.priority)),
    project.phase,
    formatDate(project.targetDate),
    progressBar(project.percentComplete)
  ]);
  return dataTable(["Project", "Status", "Health", "Priority", "Phase", "Target", "Progress"], rows);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function datePlus(days = 0) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function listViewTabs(items, active, onSelect) {
  return el("nav", {class: "view-tabs list-view-tabs", "aria-label": "List views"}, items.map((item) => (
    onSelect
      ? el("button", {type: "button", class: item.key === active ? "is-active" : "", "aria-pressed": item.key === active ? "true" : "false", onclick: () => onSelect(item.key)}, item.label)
      : el("a", {href: "#", class: item.key === active ? "is-active" : ""}, item.label)
  )));
}

function dueTone(date, status = "") {
  if (!date || isClosedWorkStatus(status)) return "neutral";
  const today = todayIso();
  const soon = datePlus(14);
  if (date < today) return "danger";
  if (date <= soon) return "watch";
  return "neutral";
}

function dueText(date, status = "") {
  if (!date) return "No date";
  if (isClosedWorkStatus(status)) return `Closed ${formatDate(date)}`;
  const today = todayIso();
  const soon = datePlus(14);
  if (date < today) return `Overdue ${formatDate(date)}`;
  if (date <= soon) return `Due soon ${formatDate(date)}`;
  return `Due ${formatDate(date)}`;
}

function projectTone(project) {
  if (["blocked", "at-risk"].includes(project.health) || dueTone(project.targetDate, project.status) === "danger") return "danger";
  if (project.health === "watch" || project.priority === "high" || project.priority === "critical" || dueTone(project.targetDate, project.status) === "watch") return "watch";
  if (project.status === "complete" || project.health === "on-track") return "good";
  return "neutral";
}

function workTone(item) {
  if (item.status === "blocked" || (item.blockedBy ?? []).length || dueTone(item.dueDate, item.status) === "danger") return "danger";
  if (["high", "critical"].includes(item.priority) || dueTone(item.dueDate, item.status) === "watch") return "watch";
  if (isClosedWorkStatus(item.status)) return "good";
  if (item.status === "in-progress") return "info";
  return "neutral";
}

function listRules(title, rules) {
  return el("section", {class: "list-rules"}, [
    el("div", {class: "section-heading"}, el("h2", {}, title)),
    el("div", {class: "list-rules__grid"}, rules.map((rule) => (
      el(rule.href ? "a" : "div", {class: `list-rule list-rule--${rule.tone ?? "neutral"}`, href: rule.href}, [
        el("strong", {}, String(rule.count)),
        el("span", {}, rule.label),
        rule.meta ? el("small", {}, rule.meta) : ""
      ])
    )))
  ]);
}

function projectListCard(project, lookups = {}) {
  const portfolios = new Map((lookups.portfolios ?? []).map((item) => [item.id, item.name]));
  const tone = projectTone(project);
  return el("article", {class: `list-card list-card--${tone}`}, [
    el("div", {class: "list-card__top"}, [
      badge(project.health, statusTone(project.health)),
      badge(project.priority, statusTone(project.priority))
    ]),
    el("a", {class: "list-card__title", href: projectHref(project.id)}, project.name),
    project.description ? el("p", {}, project.description) : "",
    el("div", {class: "list-card__facts"}, [
      el("span", {}, project.phase ?? "No phase"),
      el("span", {}, dueText(project.targetDate, project.status)),
      el("span", {}, portfolios.get(project.portfolioId) || "No portfolio")
    ]),
    progressBar(project.percentComplete ?? 0),
    miniLinks([
      {label: "Tasks", href: projectHref(project.id, "new-task")},
      {label: "Planning", href: `/app/planning?projectId=${encodeURIComponent(project.id)}`},
      {label: "Docs", href: `/app/documents?projectId=${encodeURIComponent(project.id)}`}
    ])
  ]);
}

function projectGalleryView(projects, lookups = {}) {
  return projects.length
    ? el("div", {class: "list-gallery"}, projects.map((project) => projectListCard(project, lookups)))
    : emptyView("No projects match this view.");
}

function projectCalendarView(projects) {
  const rows = [...projects].sort((a, b) => String(a.targetDate ?? "9999-12-31").localeCompare(String(b.targetDate ?? "9999-12-31")));
  return el("section", {class: "list-calendar"}, rows.map((project) => (
    el("a", {class: `calendar-row calendar-row--${projectTone(project)}`, href: projectHref(project.id)}, [
      el("time", {}, formatDate(project.targetDate) || "No target"),
      el("strong", {}, project.name),
      el("span", {}, `${project.phase ?? "No phase"} / ${titleCase(project.health ?? "unknown")}`),
      badge(dueText(project.targetDate, project.status), dueTone(project.targetDate, project.status))
    ])
  )));
}

function projectStatusView(projects) {
  return el("section", {class: "list-board"}, healthStateList.map((health) => {
    const columnProjects = projects.filter((project) => project.health === health);
    return el("div", {class: "list-board__column"}, [
      el("div", {class: "list-board__header"}, [
        el("h3", {}, titleCase(health)),
        el("span", {}, String(columnProjects.length))
      ]),
      ...columnProjects.map((project) => projectListCard(project))
    ]);
  }));
}

export function projectListWorkbench(projects = [], lookups = {}, {view = "grid"} = {}) {
  let currentView = ["grid", "gallery", "calendar", "health", "timeline"].includes(view) ? view : "grid";
  const blocked = projects.filter((project) => ["blocked", "at-risk"].includes(project.health)).length;
  const dueSoon = projects.filter((project) => ["danger", "watch"].includes(dueTone(project.targetDate, project.status))).length;
  const noOwner = projects.filter((project) => !project.ownerId).length;
  const tabs = el("div", {class: "list-view-tabs-host"});
  const content = el("div", {class: "list-workbench__content"});
  const views = [
    {key: "grid", label: "List"},
    {key: "gallery", label: "Cards"},
    {key: "calendar", label: "Calendar"},
    {key: "health", label: "Health"},
    {key: "timeline", label: "Timeline"}
  ];
  const viewContent = () => ({
    grid: projects.length ? projectTable(projects, lookups) : emptyView("No projects match the current filters."),
    gallery: projectGalleryView(projects, lookups),
    calendar: projectCalendarView(projects),
    health: projectStatusView(projects),
    timeline: projectTimeline(projects)
  })[currentView];
  const render = () => {
    tabs.replaceChildren(listViewTabs(views, currentView, (nextView) => {
      currentView = nextView;
      render();
    }));
    content.replaceChildren(viewContent());
    globalThis.requestAnimationFrame?.(() => tabs.querySelector(".is-active")?.scrollIntoView({block: "nearest", inline: "nearest"}));
  };
  const root = el("section", {class: "list-workbench", id: "project-views"}, [
    el("div", {class: "section-heading"}, [
      el("div", {}, [
        el("h2", {}, "Project views"),
        el("p", {}, "Open a project to manage its tasks, documents, notes, and status.")
      ]),
      tabs
    ]),
    content,
    actionPanel("Project signals", listRules("Signals", [
      {label: "Blocked or at risk", count: blocked, tone: blocked ? "danger" : "good", meta: "Health rule"},
      {label: "Due within 14 days or overdue", count: dueSoon, tone: dueSoon ? "watch" : "good", meta: "Target-date rule"},
      {label: "Missing owner", count: noOwner, tone: noOwner ? "watch" : "good", meta: "Accountability rule"}
    ]), {meta: `${blocked + dueSoon + noOwner} signals`})
  ]);
  render();
  return root;
}

const projectTemplates = Object.freeze([
  {
    key: "issue-tracker",
    title: "Issue tracker",
    description: "Track intake, severity, ownership, remediation, and closeout.",
    project: {health: "watch", priority: "high", phase: "Execution", targetDays: 30, tags: ["issue-tracker", "operations"]},
    work: [
      {title: "Triage new issue intake", type: "issue", status: "ready", priority: "high", effortPoints: 2, dueDays: 2, intakeGroup: "bugs"},
      {title: "Confirm severity and owner", type: "task", status: "ready", priority: "high", effortPoints: 1, dueDays: 4, intakeGroup: "bugs"},
      {title: "Publish remediation plan", type: "task", status: "intake", priority: "medium", effortPoints: 3, dueDays: 10, intakeGroup: "ready"},
      {title: "Verify fix and close issue", type: "task", status: "intake", priority: "medium", effortPoints: 2, dueDays: 20, intakeGroup: "ready"}
    ]
  },
  {
    key: "launch-plan",
    title: "Launch plan",
    description: "Coordinate milestones, launch readiness, dependencies, and evidence.",
    project: {health: "on-track", priority: "high", phase: "Planning", targetDays: 45, tags: ["launch", "milestone"]},
    work: [
      {title: "Define launch scope and success metrics", type: "feature", status: "ready", priority: "high", effortPoints: 3, dueDays: 5, intakeGroup: "ideas"},
      {title: "Create launch readiness milestone", type: "milestone", status: "ready", priority: "high", effortPoints: 1, dueDays: 21, milestoneName: "Launch readiness"},
      {title: "Review go-live risks", type: "risk", status: "intake", priority: "medium", effortPoints: 2, dueDays: 28, intakeGroup: "ready"},
      {title: "Attach launch evidence and decisions", type: "task", status: "intake", priority: "medium", effortPoints: 2, dueDays: 35, intakeGroup: "ready"}
    ]
  },
  {
    key: "team-onboarding",
    title: "Team onboarding",
    description: "Manage account setup, first-week tasks, enablement, and handoffs.",
    project: {health: "on-track", priority: "medium", phase: "Planning", targetDays: 21, tags: ["onboarding", "team"]},
    work: [
      {title: "Confirm team roster and roles", type: "task", status: "ready", priority: "medium", effortPoints: 1, dueDays: 2},
      {title: "Prepare workspace access checklist", type: "task", status: "ready", priority: "medium", effortPoints: 2, dueDays: 5},
      {title: "Schedule kickoff and working agreements", type: "task", status: "intake", priority: "medium", effortPoints: 2, dueDays: 7},
      {title: "Collect first-week feedback", type: "feature", status: "intake", priority: "low", effortPoints: 2, dueDays: 14}
    ]
  },
  {
    key: "asset-rollout",
    title: "Asset rollout",
    description: "Track assets, assignments, repair states, check-outs, and returns.",
    project: {health: "watch", priority: "medium", phase: "Execution", targetDays: 35, tags: ["assets", "operations"]},
    work: [
      {title: "Inventory assets and owners", type: "task", status: "ready", priority: "medium", effortPoints: 3, dueDays: 7, customFields: {listView: "Asset inventory"}},
      {title: "Define check-out and return process", type: "task", status: "intake", priority: "medium", effortPoints: 2, dueDays: 14, customFields: {listView: "Asset workflow"}},
      {title: "Flag repair or missing assets", type: "issue", status: "intake", priority: "high", effortPoints: 2, dueDays: 21, customFields: {listView: "Asset exceptions"}}
    ]
  }
]);

export function projectTemplateGallery(client, data = {}, {onSaved} = {}) {
  const status = el("p", {class: "form-status", role: "status", "aria-live": "polite"});
  const createFromTemplate = async (template, button) => {
    button.disabled = true;
    status.className = "form-status";
    status.textContent = `Creating ${template.title}...`;
    try {
      const project = await client.projects.create({
        name: `${template.title} ${todayIso()}`,
        description: template.description,
        portfolioId: data.portfolios?.[0]?.id,
        ownerId: data.memberships?.[0]?.userId,
        status: "active",
        health: template.project.health,
        priority: template.project.priority,
        phase: template.project.phase,
        startDate: todayIso(),
        targetDate: datePlus(template.project.targetDays),
        percentComplete: 0,
        tags: template.project.tags
      }, {idempotencyKey: crypto.randomUUID()});
      for (const item of template.work) {
        await client.workItems.create(project.id, {
          title: item.title,
          description: item.description ?? template.description,
          type: item.type,
          status: item.status,
          priority: item.priority,
          effortPoints: item.effortPoints,
          dueDate: item.dueDays ? datePlus(item.dueDays) : undefined,
          intakeGroup: item.intakeGroup,
          milestoneName: item.milestoneName,
          periodName: item.periodName,
          customFields: {template: template.title, ...(item.customFields ?? {})},
          tags: [template.key]
        }, {idempotencyKey: crypto.randomUUID()});
      }
      status.className = "form-status ok";
      status.textContent = "Template created.";
      onSaved?.();
      location.href = projectHref(project.id);
    } catch (error) {
      button.disabled = false;
      status.className = "form-status error";
      status.textContent = error.message;
    }
  };
  return el("section", {class: "template-panel"}, [
    el("div", {class: "section-heading"}, [
      el("h2", {}, "Start from template"),
      el("span", {class: "badge"}, "List-ready")
    ]),
    el("div", {class: "template-grid"}, projectTemplates.map((template) => {
      const button = el("button", {class: "button button--primary", type: "button"}, "Use template");
      button.addEventListener("click", () => createFromTemplate(template, button));
      return el("article", {class: "template-card"}, [
        el("strong", {}, template.title),
        el("p", {}, template.description),
        el("div", {class: "badge-row"}, [
          badge(template.project.phase, "neutral"),
          badge(template.project.health, statusTone(template.project.health)),
          badge(`${template.work.length} tasks`, "info")
        ]),
        button
      ]);
    })),
    status
  ]);
}

export function dashboardFocus(data) {
  const today = new Date().toISOString().slice(0, 10);
  const items = data.projects
    .filter((project) => ["watch", "at-risk", "blocked"].includes(project.health) || (project.targetDate && project.targetDate < today))
    .slice(0, 5);
  if (!items.length) return emptyActionView("No projects need attention", "Create or open project work when you are ready to add more detail.", {label: "Open projects", href: "/app/projects"});
  return el("section", {class: "focus-list", id: "needs-attention"}, [
    el("h2", {}, "Projects needing attention"),
    ...items.map((project) => el("a", {href: `/app/project?id=${encodeURIComponent(project.id)}`, class: "focus-row"}, [
      el("span", {}, project.name),
      badge(project.health, statusTone(project.health)),
      el("small", {}, project.targetDate ? `Target ${formatDate(project.targetDate)}` : "No target")
    ]))
  ]);
}

const assignedPriorityRank = Object.freeze({critical: 0, high: 1, medium: 2, low: 3});

function assignedDueRank(item, today) {
  if (!item.dueDate || isClosedWorkStatus(item.status)) return 3;
  const due = Date.parse(`${formatDate(item.dueDate)}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(due) || !Number.isFinite(now)) return 3;
  if (due < now) return 0;
  if (due <= now + (14 * dayMs)) return 1;
  return 2;
}

function assignedAttentionRank(item, today) {
  if (item.status === "blocked" || (item.blockedBy ?? []).length) return 0;
  const due = assignedDueRank(item, today);
  if (due < 2) return due + 1;
  if (item.status === "in-progress") return 3;
  return 4;
}

/**
 * Keep the task-prioritization model independent from the DOM so dashboard and
 * My tasks use the same predictable ordering.
 */
export function filterAssignedWorkItems(items = [], {search = "", scope = "open", sort = "attention", today = new Date().toISOString().slice(0, 10)} = {}) {
  const term = String(search).trim().toLowerCase();
  const filtered = items.filter((item) => {
    const matchesSearch = !term || [item.title, item.description, item.projectName, ...(item.tags ?? [])]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(term));
    if (!matchesSearch) return false;
    if (scope === "all") return true;
    if (scope === "open") return !isClosedWorkStatus(item.status);
    if (scope === "blocked") return item.status === "blocked" || Boolean((item.blockedBy ?? []).length);
    if (scope === "due") return assignedDueRank(item, today) < 2;
    return item.status === scope;
  });
  return [...filtered].sort((left, right) => {
    if (sort === "updated") return String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")) || String(left.title).localeCompare(String(right.title));
    if (sort === "due") {
      const dueOrder = assignedDueRank(left, today) - assignedDueRank(right, today)
        || String(left.dueDate ?? "9999-12-31").localeCompare(String(right.dueDate ?? "9999-12-31"));
      if (dueOrder) return dueOrder;
    } else {
      const attentionOrder = assignedAttentionRank(left, today) - assignedAttentionRank(right, today);
      if (attentionOrder) return attentionOrder;
    }
    return (assignedPriorityRank[left.priority] ?? 4) - (assignedPriorityRank[right.priority] ?? 4)
      || String(left.dueDate ?? "9999-12-31").localeCompare(String(right.dueDate ?? "9999-12-31"))
      || String(left.title).localeCompare(String(right.title));
  });
}

export function dashboardAssignments(items = []) {
  const openItems = filterAssignedWorkItems(items, {scope: "open"});
  return el("section", {class: "focus-list assignment-focus", id: "my-work"}, [
    el("div", {class: "section-heading"}, [
      el("div", {}, [
        el("h2", {}, "My tasks"),
        el("p", {}, openItems.length ? `${openItems.length} open assignment${openItems.length === 1 ? "" : "s"}, ordered by attention.` : "No open assignments.")
      ]),
      miniLinks([{label: "View all", href: "/app/work"}])
    ]),
    ...(openItems.length
      ? openItems.slice(0, 6).map((item) => el("a", {href: workItemHref(item), class: "focus-row"}, [
        el("span", {class: "object-cell"}, [
          el("strong", {}, item.title),
          item.projectName ? el("small", {}, item.projectName) : ""
        ]),
        badge(workStatusLabel(item.status), statusTone(item.status)),
        el("small", {}, item.dueDate ? `Due ${formatDate(item.dueDate)}` : titleCase(item.priority ?? "medium"))
      ]))
      : [emptyView("You have no open assigned tasks.")])
  ]);
}

export function workspaceDashboard(data, assignments = [], activity = []) {
  const configured = data.capabilities?.dashboard?.widgets ?? ["my-work", "project-health", "upcoming", "activity"];
  const widgets = configured.map((widget) => typeof widget === "string" ? {id: widget, type: widget} : widget).filter((widget) => widget.enabled !== false);
  const upcoming = [...data.projects].filter((project) => project.targetDate).sort((a, b) => String(a.targetDate).localeCompare(String(b.targetDate))).slice(0, 8);
  const render = (widget) => {
    const type = widget.type ?? widget.id;
    if (type === "my-work") return dashboardAssignments(assignments);
    if (["project-health", "needs-attention"].includes(type)) return dashboardFocus(data);
    if (type === "upcoming") return actionPanel(widget.title ?? "Upcoming project targets", upcoming.length ? projectTable(upcoming, {portfolios: data.portfolios}) : emptyView("No project targets are scheduled."), {open: true, meta: `${upcoming.length} projects`});
    if (type === "activity") return actionPanel(widget.title ?? "Recent activity", activityList(activity.slice(0, Number(widget.limit ?? 10))), {open: true, meta: `${Math.min(activity.length, Number(widget.limit ?? 10))} changes`});
    if (["projects", "project-list"].includes(type)) return actionPanel(widget.title ?? "Projects", projectTable(data.projects, {portfolios: data.portfolios}), {open: true, meta: `${data.projects.length} projects`});
    if (type === "portfolio-summary") return dataTable(["Portfolio signal", "Value"], [["Active projects", data.summary?.totalActiveProjects ?? 0], ["At risk", data.summary?.atRiskProjects ?? 0], ["Open work", data.summary?.planning?.totalItems ?? 0]]);
    return el("section", {class: "public-demo-feature-notice", role: "note"}, `Dashboard widget “${type}” is configured but has no renderer.`);
  };
  return el("section", {class: "workspace-dashboard", "data-widget-count": widgets.length}, widgets.map(render));
}

function saveStatus(form, text, kind = "") {
  let status = form.querySelector(".form-status");
  if (!status) {
    status = el("p", {class: "form-status", role: "status", "aria-live": "polite"});
    form.append(status);
  }
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.className = `form-status ${kind}`;
  status.textContent = text;
}

export function createPortfolioForm(client, {onSaved} = {}) {
  const form = el("form", {class: "editor-form"}, [
    field("Name", textInput("name", "Growth Portfolio")),
    field("Description", textInput("description", "Optional")),
    el("button", {class: "button button--primary", type: "submit"}, "Create portfolio")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    try {
      await client.portfolios.create({name: data.get("name"), description: data.get("description")}, {idempotencyKey: crypto.randomUUID()});
      form.reset();
      saveStatus(form, "Portfolio created.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

function configuredLifecyclePhases(capabilities = {}) {
  const phases = capabilities.lifecycle?.phases ?? [];
  return phases.length ? phases.map((phase) => ({value: phase.label ?? phase.id, label: phase.label ?? titleCase(phase.id)})) : lifecyclePhaseList;
}

export function createProjectForm(client, data, {onSaved} = {}) {
  const portfolioOptions = [{value: "", label: "None"}, ...data.portfolios.map((item) => ({value: item.id, label: item.name}))];
  const owners = memberOptions(data.memberships ?? []);
  const parentOptions = projectOptions(data.projects ?? [], "No parent project");
  const modules = multiSelectInput("modules", projectModuleOptions, projectModuleOptions.map(({value}) => value));
  const template = el("input", {name: "template", type: "checkbox"});
  const form = el("form", {class: "editor-form editor-form--wide"}, [
    field("Name", textInput("name", "Customer onboarding pilot")),
    field("Description", textareaInput("description", "What outcome should this project deliver?")),
    field("Portfolio", selectInput("portfolioId", portfolioOptions)),
    field("Parent project", selectInput("parentProjectId", parentOptions)),
    field("Owner", selectInput("ownerId", owners)),
    field("Status", selectInput("status", projectStatusList, "active")),
    field("Health", selectInput("health", healthStateList, "on-track")),
    field("Priority", selectInput("priority", priorityList, "medium")),
    field("Phase", selectInput("phase", configuredLifecyclePhases(data.capabilities), data.capabilities?.lifecycle?.phases?.[0]?.label ?? "Planning")),
    field("Start", el("input", {name: "startDate", type: "date"})),
    field("Target", el("input", {name: "targetDate", type: "date"})),
    field("Progress", el("input", {name: "percentComplete", type: "number", min: "0", max: "100", value: "0"})),
    field("Modules", modules),
    field("Reusable template", el("span", {class: "check-row"}, [template, "List this project as a reusable template"])),
    ...configuredCustomFieldEditors(data.capabilities, {}, "project"),
    field("Tags", textInput("tags", "pilot, launch")),
    el("button", {class: "button button--primary", type: "submit"}, "Create project")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = formValues(form);
    formData.modules = [...modules.selectedOptions].map((option) => option.value);
    formData.template = template.checked;
    formData.customFields = configuredCustomFieldValues(formData, data.capabilities, {}, "project");
    try {
      await client.projects.create(formData, {idempotencyKey: crypto.randomUUID()});
      form.reset();
      saveStatus(form, "Project created.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function projectEditForm(client, project, data = {}, memberships = [], {onSaved} = {}) {
  const capabilities = data.capabilities ?? {};
  const portfolioOptions = [{value: "", label: "None"}, ...(data.portfolios ?? []).map((item) => ({value: item.id, label: item.name}))];
  const parentOptions = projectOptions((data.projects ?? []).filter((item) => item.id !== project.id), "No parent project");
  const modules = multiSelectInput("modules", projectModuleOptions, project.modules ?? projectModuleOptions.map(({value}) => value));
  const template = el("input", {name: "template", type: "checkbox"});
  template.checked = Boolean(project.template);
  const form = el("form", {class: "editor-form editor-form--wide"}, [
    field("Name", textInput("name", "Project name", project.name ?? "")),
    field("Description", textareaInput("description", "Project description", project.description ?? "")),
    field("Portfolio", selectInput("portfolioId", portfolioOptions, project.portfolioId ?? "")),
    field("Parent project", selectInput("parentProjectId", parentOptions, project.parentProjectId ?? "")),
    field("Owner", selectInput("ownerId", memberOptions(memberships), project.ownerId ?? "")),
    field("Status", selectInput("status", projectStatusList, project.status ?? "active")),
    field("Health", selectInput("health", healthStateList, project.health ?? "on-track")),
    field("Priority", selectInput("priority", priorityList, project.priority ?? "medium")),
    field("Phase", selectInput("phase", configuredLifecyclePhases(data.capabilities), project.phase ?? "Planning")),
    field("Start", el("input", {name: "startDate", type: "date", value: formatDate(project.startDate)})),
    field("Target", el("input", {name: "targetDate", type: "date", value: formatDate(project.targetDate)})),
    field("Progress", el("input", {name: "percentComplete", type: "number", min: "0", max: "100", value: String(project.percentComplete ?? 0)})),
    field("Modules", modules),
    field("Reusable template", el("span", {class: "check-row"}, [template, "List this project as a reusable template"])),
    ...configuredCustomFieldEditors(capabilities, project.customFields ?? {}, "project"),
    field("Tags", textInput("tags", "pilot, launch", csvList(project.tags))),
    el("button", {class: "button button--primary", type: "submit"}, "Save project")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formValues(form);
    data.modules = [...modules.selectedOptions].map((option) => option.value);
    data.template = template.checked;
    data.customFields = configuredCustomFieldValues(data, capabilities, project.customFields ?? {}, "project");
    data.version = project.version;
    try {
      await client.projects.patch(project.id, data);
      saveStatus(form, "Project saved.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function projectLifecycleControls(client, project, {onSaved} = {}) {
  const status = el("p", {class: "form-status", role: "status", "aria-live": "polite"});
  const favorite = el("button", {class: "button", type: "button"}, project.favorite ? "Remove favorite" : "Add favorite");
  const archive = el("button", {class: "button", type: "button"}, project.archived ? "Restore project" : "Archive project");
  const copyName = textInput("copyName", "Copy name", `${project.name} copy`);
  const includeTasks = el("input", {name: "includeTasks", type: "checkbox"});
  includeTasks.checked = true;
  const copy = el("button", {class: "button button--primary", type: "button"}, "Copy project");
  const confirmDelete = el("input", {name: "confirmDelete", type: "checkbox"});
  const remove = el("button", {class: "button", type: "button", disabled: "true"}, "Delete project");
  confirmDelete.addEventListener("change", () => { remove.disabled = !confirmDelete.checked; });
  const run = async (button, action, success) => {
    button.disabled = true;
    status.className = "form-status";
    status.textContent = "Saving...";
    try {
      await action();
      status.className = "form-status ok";
      status.textContent = success;
      onSaved?.();
    } catch (error) {
      button.disabled = false;
      status.className = "form-status error";
      status.textContent = error.message;
    }
  };
  favorite.addEventListener("click", () => run(favorite, () => client.projects.patch(project.id, {version: project.version, favorite: !project.favorite}), "Favorite updated."));
  archive.addEventListener("click", () => run(archive, () => project.archived
    ? client.projects.restore(project.id, {version: project.version})
    : client.projects.archive(project.id, {version: project.version}), project.archived ? "Project restored." : "Project archived."));
  copy.addEventListener("click", () => run(copy, async () => {
    const created = await client.projects.copy(project.id, {name: copyName.value, includeTasks: includeTasks.checked});
    location.href = projectHref(created.id);
  }, "Project copied."));
  remove.addEventListener("click", () => run(remove, async () => {
    await client.projects.delete(project.id, {version: project.version});
    location.href = "/app/projects";
  }, "Project deleted."));
  return el("section", {class: "lifecycle-controls"}, [
    el("div", {class: "button-row"}, [favorite, archive]),
    field("Copy name", copyName),
    field("Copy options", el("span", {class: "check-row"}, [includeTasks, "Include up to 100 tasks"])),
    copy,
    el("details", {class: "danger-zone"}, [
      el("summary", {}, "Delete project"),
      el("p", {}, "Deleted projects are removed from normal views. Subprojects must be moved or deleted first."),
      el("label", {class: "check-row"}, [confirmDelete, "I understand this action removes the project"]),
      remove
    ]),
    status
  ]);
}

function initiationRequestField(definition) {
  const name = `request__${definition.id}`;
  if (definition.type === "date") return el("input", {name, type: "date", required: definition.required ? "true" : undefined});
  if (definition.type === "boolean") return selectInput(name, [{value: "", label: "Not set"}, {value: "true", label: "Yes"}, {value: "false", label: "No"}], "");
  if (definition.type === "select") return selectInput(name, [{value: "", label: "Select"}, ...customFieldOptions(definition.options)], "");
  return definition.multiline ? textareaInput(name, definition.helpText ?? "") : el("input", {name, type: definition.type === "number" ? "number" : "text", placeholder: definition.helpText ?? "", required: definition.required ? "true" : undefined});
}

export function projectInitiationPanel(client, project, capabilities = {}, {onSaved, currentUserId = ""} = {}) {
  const configuration = capabilities.lifecycle?.initiation ?? {};
  if (!configuration.enabled) return emptyView("Project initiation is not enabled for this workspace.");
  const status = badge(project.initiationStatus ?? "draft", project.initiationStatus === "approved" ? "good" : project.initiationStatus === "rejected" ? "danger" : "watch");
  const form = el("form", {class: "editor-form"}, [
    ...((configuration.requestFields ?? []).map((definition) => field(`${definition.name ?? titleCase(definition.id)}${definition.required ? " *" : ""}`, initiationRequestField(definition)))),
    field("Submission note", textareaInput("note", "Context for reviewers")),
    el("button", {class: "button button--primary", type: "submit", disabled: ["submitted", "approved"].includes(project.initiationStatus) ? "true" : undefined}, project.initiationStatus === "changes-requested" ? "Resubmit request" : "Submit for review")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = formValues(form);
    const requestData = {};
    for (const definition of configuration.requestFields ?? []) {
      let value = values[`request__${definition.id}`];
      if (definition.type === "boolean" && value !== "") value = value === "true";
      if (definition.type === "number" && value !== "") value = Number(value);
      if (value !== "" && value !== undefined) requestData[definition.id] = value;
    }
    try {
      await client.projects.submitInitiation(project.id, {version: project.version, requestData, templateProjectId: configuration.templateProjectId || undefined, note: values.note});
      saveStatus(form, "Initiation request submitted.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  const review = el("form", {class: "editor-form"}, [
    field("Review comment", textareaInput("comment", "Decision rationale")),
    el("div", {class: "button-row"}, ["approved", "changes-requested", "rejected"].map((decision) => {
      const button = el("button", {class: decision === "approved" ? "button button--primary" : "button", type: "button", disabled: ["submitted", "changes-requested"].includes(project.initiationStatus) ? undefined : "true"}, titleCase(decision));
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await client.projects.reviewInitiation(project.id, {version: project.version, decision, comment: new FormData(review).get("comment")});
          saveStatus(review, `Request ${decision.replaceAll("-", " ")}.`, decision === "approved" ? "ok" : "error");
          onSaved?.();
        } catch (error) {
          button.disabled = false;
          saveStatus(review, error.message, "error");
        }
      });
      return button;
    }))
  ]);
  const reviewerIds = configuration.reviewerIds ?? [];
  const canReview = !reviewerIds.length || reviewerIds.includes(currentUserId);
  return el("section", {class: "project-initiation"}, [
    el("div", {class: "badge-row"}, [status, project.templateSourceProjectId ? badge("Template applied", "info") : ""]),
    project.initiationRequest ? dataTable(["Submission", "Value"], [["Submitted by", project.initiationRequest.submittedBy], ["Submitted", formatDate(project.initiationRequest.submittedAt)], ["Template", project.initiationRequest.templateProjectId ?? "None"], ...Object.entries(project.initiationRequest.requestData ?? {}).map(([key, value]) => [titleCase(key), Array.isArray(value) ? value.join(", ") : String(value)])]) : "",
    form,
    canReview ? actionPanel("Review request", review, {open: project.initiationStatus === "submitted", meta: `${(project.initiationApprovals ?? []).length} decisions`}) : el("p", {}, "A configured reviewer must decide this request."),
    project.initiationAuditArtifact ? el("details", {}, [el("summary", {}, "Audit artifact"), el("pre", {}, JSON.stringify(project.initiationAuditArtifact, null, 2))]) : ""
  ]);
}

export function projectLifecycleGatesPanel(client, project, capabilities = {}, {onSaved, currentUserId = ""} = {}) {
  const phases = capabilities.lifecycle?.phases ?? [];
  const approvals = new Map((project.lifecycleGateApprovals ?? []).map((approval) => [approval.gateId, approval]));
  const rows = phases.flatMap((phase) => (phase.gates ?? []).map((rawGate) => {
    const gate = typeof rawGate === "string" ? {id: rawGate, name: titleCase(rawGate)} : rawGate;
    const approval = approvals.get(gate.id);
    const canReview = !gate.reviewerIds?.length || gate.reviewerIds.includes(currentUserId);
    const approve = el("button", {class: "button", type: "button", disabled: approval || !canReview ? "true" : undefined}, approval ? "Approved" : canReview ? "Approve" : "Reviewer required");
    approve.addEventListener("click", async () => {
      approve.disabled = true;
      try {
        await client.projects.approveGate(project.id, gate.id, {version: project.version, comment: "Approved from project lifecycle panel"});
        onSaved?.();
      } catch (error) {
        approve.disabled = false;
        approve.textContent = error.message;
      }
    });
    return [phase.label ?? phase.id, gate.name ?? gate.id, gate.description ?? "", approval ? `${approval.reviewerId} · ${formatDate(approval.approvedAt)}` : "Pending", approve];
  }));
  return rows.length ? dataTable(["Destination phase", "Gate", "Evidence", "Approval", ""], rows) : emptyView("No lifecycle gates are configured.");
}

export function projectTeamPanel(project, items = [], memberships = []) {
  const projectMemberIds = new Set([
    project.ownerId,
    ...items.flatMap((item) => [item.assigneeId, item.reporterId, ...(item.watcherIds ?? [])])
  ].filter(Boolean));
  const rows = memberships
    .filter((membership) => projectMemberIds.has(membership.userId))
    .map((membership) => {
      const assigned = items.filter((item) => item.assigneeId === membership.userId);
      const watching = items.filter((item) => (item.watcherIds ?? []).includes(membership.userId));
      const connections = [
        project.ownerId === membership.userId ? "Owner" : "",
        assigned.length ? `${assigned.length} assigned` : "",
        watching.length ? `${watching.length} watching` : ""
      ].filter(Boolean).join(", ");
      return [
        el("div", {class: "object-cell"}, [
          el("strong", {}, membership.name ?? membership.email ?? membership.userId),
          el("span", {}, membership.email ?? membership.userId)
        ]),
        badge(membership.role ?? "member", "neutral"),
        connections || "Member",
        assigned.filter((item) => !isClosedWorkStatus(item.status)).length
      ];
    });
  return el("section", {class: "team-panel"}, [
    el("div", {class: "section-heading"}, [
      el("h2", {}, "Project team"),
      miniLinks([{label: "Add member", href: "/app/admin"}])
    ]),
    rows.length ? dataTable(["Person", "Role", "Connection", "Open tasks"], rows) : emptyView("Assign an owner or task to build the project team.")
  ]);
}

export function hierarchyTree(portfolios, projects) {
  const root = el("section", {class: "hierarchy", id: "portfolio-hierarchy"});
  root.append(el("h2", {}, "Portfolio hierarchy"));
  for (const portfolio of portfolios) {
    const direct = projects.filter((project) => project.portfolioId === portfolio.id);
    const details = el("details", {open: "true"}, [el("summary", {}, `${portfolio.name} (${direct.length})`)]);
    if (direct.length) details.append(el("ul", {}, direct.map((project) => el("li", {}, [
      el("a", {href: `/app/project?id=${project.id}`}, project.name),
      miniLinks([{label: "Tasks", href: projectHref(project.id, "new-task")}])
    ]))));
    root.append(details);
  }
  return root;
}

export function projectOverview(project, memberships = []) {
  return el("section", {class: "entity-summary"}, [
    el("div", {class: "entity-summary__heading"}, [
      el("h2", {}, project.name),
      el("div", {class: "badge-row"}, [
        badge(project.status, statusTone(project.status)),
        badge(project.health, statusTone(project.health)),
        badge(project.priority, statusTone(project.priority))
      ])
    ]),
    dataTable(["Field", "Value"], [
      ["Phase", project.phase],
      ["Progress", progressBar(project.percentComplete)],
      ["Target", formatDate(project.targetDate) || "Not set"],
      ["Owner", memberName(memberships, project.ownerId)],
      ["Parent project", project.parentProjectId || "Top level"],
      ["Modules", (project.modules ?? projectModuleOptions.map(({value}) => value)).map(titleCase).join(", ")],
      ["Template", project.template ? "Reusable template" : "Standard project"],
      ["Favorite", project.favorite ? "Yes" : "No"],
      ["Start", formatDate(project.startDate) || "Not set"],
      ["Updated", formatDate(project.updatedAt) || ""],
      ...Object.entries(project.customFields ?? {}).map(([name, value]) => [titleCase(name.replace(/__score$/, " score")), Array.isArray(value) ? value.join(", ") : String(value)]),
      ["Tags", (project.tags ?? []).join(", ")]
    ])
  ]);
}

export function projectDeliverySummary(project, workItems = [], timeEntries = []) {
  const active = workItems.filter((item) => !isClosedWorkStatus(item.status));
  const blocked = workItems.filter((item) => item.status === "blocked");
  const milestones = workItems.filter((item) => item.type === "milestone" && !isClosedWorkStatus(item.status));
  const estimateMinutes = workItems.reduce((sum, item) => sum + Number(item.estimateMinutes ?? 0), 0);
  const recordedMinutes = workItems.reduce((sum, item) => sum + Number(item.recordedMinutes ?? 0), 0)
    + timeEntries.reduce((sum, entry) => sum + Number(entry.durationMinutes ?? 0), 0);
  const donePoints = workItems.filter((item) => isClosedWorkStatus(item.status)).reduce((sum, item) => sum + Number(item.effortPoints ?? 0), 0);
  const totalPoints = workItems.reduce((sum, item) => sum + Number(item.effortPoints ?? 0), 0);
  return el("section", {class: "project-command"}, [
    dataTable(["Signal", "Value"], [
      ["Open tasks", active.length],
      ["Blocked", blocked.length],
      ["Milestones", milestones.length],
      ["Effort points", `${donePoints} / ${totalPoints}`],
      ["Estimate", formatHours(estimateMinutes)],
      ["Recorded", formatHours(recordedMinutes)]
    ]),
    blocked.length ? el("div", {class: "risk-strip"}, blocked.slice(0, 4).map((item) => el("a", {href: `#${item.id}`}, [
      badge("Blocked", "danger"),
      el("span", {}, item.title)
    ]))) : el("div", {class: "risk-strip risk-strip--clear"}, "No blocked tasks.")
  ]);
}

export function workBreakdownTree(items = []) {
  if (!items.length) return emptyView("No tasks yet.");
  const byId = new Map(items.map((item) => [item.id, item]));
  const children = new Map();
  for (const item of items) {
    if (item.parentId && byId.has(item.parentId)) children.set(item.parentId, [...(children.get(item.parentId) ?? []), item]);
  }
  const roots = items.filter((item) => !item.parentId || !byId.has(item.parentId));
  const renderNode = (item) => {
    const nested = children.get(item.id) ?? [];
    return el("li", {}, [
      el("div", {class: "wbs-row"}, [
        el("a", {href: workItemHref(item)}, item.title),
        badge(workTypeLabel(item.type), "neutral"),
        badge(workStatusLabel(item.status), statusTone(item.status)),
        item.assigneeName || item.assigneeId ? el("small", {}, item.assigneeName ?? item.assigneeId) : ""
      ]),
      nested.length ? el("ul", {}, nested.map(renderNode)) : ""
    ]);
  };
  return el("section", {class: "wbs"}, [
    el("div", {class: "section-heading"}, el("h2", {}, "Task breakdown")),
    el("ul", {}, roots.map(renderNode))
  ]);
}

export function projectRoadmapPanel(items = []) {
  const milestones = [...new Set(items.map((item) => item.milestoneName || "Unplanned"))].sort();
  const rows = milestones.map((milestone) => {
    const milestoneItems = items.filter((item) => (item.milestoneName || "Unplanned") === milestone);
    const points = milestoneItems.reduce((sum, item) => sum + Number(item.effortPoints ?? 0), 0);
    const done = milestoneItems.filter((item) => isClosedWorkStatus(item.status)).reduce((sum, item) => sum + Number(item.effortPoints ?? 0), 0);
    const target = milestoneItems.map((item) => item.dueDate).filter(Boolean).sort()[0] ?? "";
    return [milestone, progressBar(points ? Math.round(done / points * 100) : 0), `${done} / ${points}`, formatDate(target), milestoneItems.length];
  });
  const milestoneItems = items.filter((item) => item.type === "milestone").sort((a, b) => String(a.dueDate ?? "").localeCompare(String(b.dueDate ?? "")));
  return el("section", {class: "roadmap-panel"}, [
    el("div", {class: "section-heading"}, el("h2", {}, "Roadmap")),
    dataTable(["Milestone", "Progress", "Effort", "Next date", "Work"], rows.length ? rows : [["Unplanned", progressBar(0), "0 / 0", "", 0]]),
    milestoneItems.length ? dataTable(["Milestone item", "Status", "Due"], milestoneItems.map((item) => [
      item.title,
      badge(workStatusLabel(item.status), statusTone(item.status)),
      formatDate(item.dueDate)
    ])) : emptyView("No milestones.")
  ]);
}

function priorityWeight(value) {
  return {critical: 4, high: 3, medium: 2, low: 1}[value] ?? 0;
}

function workProgressPercent(item = {}) {
  if (isClosedWorkStatus(item.status)) return 100;
  if (item.status === "in-progress") return 50;
  if (item.status === "blocked") return 25;
  return 0;
}

function workDurationText(start, end) {
  if (start === undefined || end === undefined) return "Unscheduled";
  const days = Math.max(1, daysBetween(Math.min(start, end), Math.max(start, end)) + 1);
  return `${days}d`;
}

function sortedWorkItems(items = []) {
  return [...items].sort((a, b) => Number(a.rank ?? 0) - Number(b.rank ?? 0)
    || String(a.startDate ?? a.dueDate ?? "9999-12-31").localeCompare(String(b.startDate ?? b.dueDate ?? "9999-12-31"))
    || String(a.title ?? "").localeCompare(String(b.title ?? "")));
}

function hierarchicalWorkItems(items = []) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const children = new Map();
  for (const item of items) {
    if (item.parentId && byId.has(item.parentId)) children.set(item.parentId, [...(children.get(item.parentId) ?? []), item]);
  }
  const roots = sortedWorkItems(items.filter((item) => !item.parentId || !byId.has(item.parentId)));
  const ordered = [];
  const visited = new Set();
  const visit = (item, level) => {
    if (!item || visited.has(item.id)) return;
    visited.add(item.id);
    ordered.push({item, level});
    for (const child of sortedWorkItems(children.get(item.id) ?? [])) visit(child, level + 1);
  };
  for (const item of roots) visit(item, 0);
  for (const item of sortedWorkItems(items)) visit(item, 0);
  return ordered;
}

function isMilestoneItem(item = {}) {
  return item.type === "milestone" || item.customFields?.planningType === "milestone";
}

function isCriticalScheduleItem(item = {}) {
  return item.status === "blocked"
    || item.priority === "critical"
    || dueTone(item.dueDate, item.status) === "danger"
    || Boolean(item.blockedBy?.length);
}

function planningGroupLabel(groupBy, item, memberships = []) {
  if (groupBy === "status") return workStatusLabel(item.status ?? configuredDefaultStatusId);
  if (groupBy === "assignee") return memberName(memberships, item.assigneeId);
  if (groupBy === "period") return item.periodName || "Unscheduled";
  if (groupBy === "milestone") return item.milestoneName || "Unplanned";
  if (groupBy === "workflowStep") return item.customFields?.workflowStep || "Unassigned";
  if (groupBy === "priority") return titleCase(item.priority ?? "medium");
  if (groupBy === "type") return workTypeLabel(item.type ?? configuredDefaultTypeId);
  return "All work";
}

function filterPlanningItems(items, state) {
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const search = String(state.search ?? "").trim().toLowerCase();
  return items
    .filter((item) => {
      if (state.scope === "open" && isClosedWorkStatus(item.status)) return false;
      if (state.scope === "blocked" && item.status !== "blocked" && !(item.blockedBy ?? []).length) return false;
      if (state.scope === "unassigned" && item.assigneeId) return false;
      if (state.scope === "due-soon" && (!item.dueDate || item.dueDate < today || item.dueDate > soon || isClosedWorkStatus(item.status))) return false;
      return true;
    })
    .filter((item) => {
      if (!search) return true;
      const custom = Object.entries(item.customFields ?? {}).map(([key, value]) => `${key} ${value}`).join(" ");
      return `${item.title ?? ""} ${item.description ?? ""} ${item.status ?? ""} ${item.priority ?? ""} ${(item.tags ?? []).join(" ")} ${custom}`.toLowerCase().includes(search);
    })
    .sort((a, b) => {
      if (state.sortBy === "due") return String(a.dueDate ?? "9999-12-31").localeCompare(String(b.dueDate ?? "9999-12-31"));
      if (state.sortBy === "priority") return priorityWeight(b.priority) - priorityWeight(a.priority) || Number(a.rank ?? 0) - Number(b.rank ?? 0);
      if (state.sortBy === "points") return Number(b.effortPoints ?? 0) - Number(a.effortPoints ?? 0);
      if (state.sortBy === "status") return String(a.status ?? "").localeCompare(String(b.status ?? "")) || Number(a.rank ?? 0) - Number(b.rank ?? 0);
      return Number(a.rank ?? 0) - Number(b.rank ?? 0);
    });
}

function groupedPlanningView(items, groupBy, memberships = []) {
  const groups = new Map();
  for (const item of items) {
    const key = planningGroupLabel(groupBy, item, memberships);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return el("div", {class: "planning-groups"}, [...groups.entries()].map(([name, groupItems]) => (
    el("section", {class: "planning-group"}, [
      el("div", {class: "planning-group__heading"}, [
        el("h3", {}, name),
        el("span", {}, String(groupItems.length))
      ]),
      ...groupItems.map((item) => workCard(item))
    ])
  )));
}

export function projectPlanningViews(project, items = [], client, {onSaved, memberships = [], capabilities = {}} = {}) {
  const root = el("section", {class: "project-planning", id: "task-views"});
  const layout = selectInput("layout", [
    {value: "table", label: "Table"},
    {value: "board", label: "Board"},
    {value: "gantt", label: "Gantt"},
    {value: "calendar", label: "Calendar"},
    {value: "roadmap", label: "Roadmap"}
  ], "table");
  const scope = selectInput("scope", [
    {value: "open", label: "Open tasks"},
    {value: "all", label: "All tasks"},
    {value: "blocked", label: "Blocked"},
    {value: "unassigned", label: "Unassigned"},
    {value: "due-soon", label: "Due soon"}
  ], "open");
  const groupBy = selectInput("groupBy", [
    {value: "none", label: "No grouping"},
    {value: "status", label: "Status"},
    {value: "assignee", label: "Assignee"},
    {value: "period", label: "Time period"},
    {value: "milestone", label: "Milestone"},
    {value: "workflowStep", label: "Workflow step"},
    {value: "priority", label: "Priority"},
    {value: "type", label: "Type"}
  ], "none");
  const sortBy = selectInput("sortBy", [
    {value: "rank", label: "Rank"},
    {value: "due", label: "Due date"},
    {value: "priority", label: "Priority"},
    {value: "points", label: "Effort points"},
    {value: "status", label: "Status"}
  ], "rank");
  const search = el("input", {type: "search", name: "search", placeholder: "Search tasks"});
  const controls = el("div", {class: "planning-controls"}, [
    field("Layout", layout),
    field("Items", scope),
    field("Group", groupBy),
    field("Sort", sortBy),
    field("Search", search)
  ]);
  const content = el("div", {class: "planning-content"});
  const saveForm = el("form", {class: "inline-form planning-save"}, [
    field("View name", textInput("name", "Open tasks by assignee")),
    el("button", {class: "button", type: "submit"}, "Save view")
  ]);
  const selectedIds = new Set();
  let render;
  const bulkEditor = workItemBulkEditor(client, items, {
    selectedIds,
    memberships,
    capabilities,
    onSaved,
    onRender: () => render?.()
  });
  const currentState = () => ({
    layout: layout.value,
    scope: scope.value,
    groupBy: groupBy.value,
    sortBy: sortBy.value,
    search: search.value
  });
  render = () => {
    const state = currentState();
    const visible = filterPlanningItems(items, state);
    const bulkTableVisible = state.layout === "table" && state.groupBy === "none";
    for (const id of selectedIds) {
      if (!bulkTableVisible || !visible.some((item) => item.id === id)) selectedIds.delete(id);
    }
    bulkEditor.sync();
    const points = visible.reduce((sum, item) => sum + Number(item.effortPoints ?? 0), 0);
    const blocked = visible.filter((item) => item.status === "blocked" || (item.blockedBy ?? []).length).length;
    const customFieldCount = new Set(visible.flatMap((item) => Object.keys(item.customFields ?? {}))).size;
    let view;
    if (!visible.length) view = emptyView("No tasks match this view.");
    else if (state.groupBy !== "none" && !["roadmap", "gantt"].includes(state.layout)) view = groupedPlanningView(visible, state.groupBy, memberships);
    else if (state.layout === "board") view = workItemKanban(visible, client, {onSaved});
    else if (state.layout === "gantt") view = workGanttView(visible, client, {onSaved});
    else if (state.layout === "calendar") view = workCalendarView(visible);
    else if (state.layout === "roadmap") view = projectRoadmapPanel(visible);
    else view = el("section", {class: "bulk-work-list"}, [
      bulkEditor.node,
      workItemTable(visible, {
        selectedIds,
        onSelectionChange: (selection) => bulkEditor.sync(selection),
        capabilities
      })
    ]);
    content.replaceChildren(
      view,
      actionPanel("View details", dataTable(["Signal", "Value"], [
        ["Visible tasks", visible.length],
        ["Effort points", points],
        ["Blocked", blocked],
        ["Custom fields", customFieldCount]
      ]), {meta: `${visible.length} tasks`})
    );
  };
  for (const control of [layout, scope, groupBy, sortBy, search]) {
    control.addEventListener("input", render);
    control.addEventListener("change", render);
  }
  saveForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(saveForm);
    try {
      await client.savedViews.create({
        name: data.get("name"),
        scope: `project:${project.id}`,
        filters: currentState()
      }, {idempotencyKey: crypto.randomUUID()});
      saveStatus(saveForm, "View saved.", "ok");
    } catch (error) {
      saveStatus(saveForm, error.message, "error");
    }
  });
  root.append(
    el("div", {class: "section-heading"}, [
      el("h2", {}, "Planning views"),
      miniLinks([{label: "Create task", href: projectHref(project.id, "new-task")}])
    ]),
    controls,
    saveForm,
    content
  );
  render();
  return root;
}

function customFieldDefinitions(capabilities = {}, entityType = "work-item") {
  return (capabilities.customFields ?? []).filter((definition) => (definition.entityType ?? "work-item") === entityType);
}

function customFieldOptions(options = [], depth = 0) {
  return options.flatMap((option) => {
    const value = option.id ?? option.value ?? option;
    const label = `${"— ".repeat(depth)}${option.name ?? option.label ?? option.value ?? option.id ?? option}`;
    return [{value, label}, ...customFieldOptions(option.children ?? [], depth + 1)];
  });
}

function configuredCustomFieldInput(definition, value) {
  const name = `custom__${definition.id}`;
  const attrs = {name, required: definition.required ? "true" : undefined};
  if (definition.type === "calculated") return el("output", {class: "calculated-field"}, value ?? "Calculated when saved");
  if (definition.multiSelect && ["select", "user", "version"].includes(definition.type)) {
    const options = customFieldOptions(definition.options);
    return options.length ? multiSelectInput(name, options, value ?? []) : textInput(name, "Comma-separated identifiers", Array.isArray(value) ? value.join(", ") : value ?? "");
  }
  if (["select", "weighted"].includes(definition.type)) return selectInput(name, [{value: "", label: "Select"}, ...customFieldOptions(definition.options)], value ?? "");
  if (["multi-select", "hierarchy"].includes(definition.type)) return multiSelectInput(name, customFieldOptions(definition.options), value ?? []);
  if (definition.type === "boolean") return selectInput(name, [{value: "", label: "Not set"}, {value: "true", label: "Yes"}, {value: "false", label: "No"}], value === true ? "true" : value === false ? "false" : "");
  if (definition.type === "date") return el("input", {...attrs, type: "date", value: value ?? ""});
  if (definition.type === "long-text") return el("textarea", {...attrs, rows: "4"}, value ?? "");
  if (definition.type === "link") return el("input", {...attrs, type: "url", value: value ?? ""});
  if (["integer", "decimal"].includes(definition.type)) return el("input", {...attrs, type: "number", step: definition.type === "integer" ? "1" : "any", value: value ?? ""});
  return el("input", {...attrs, type: "text", value: value ?? "", placeholder: definition.helpText ?? definition.name ?? definition.id});
}

function configuredCustomFieldEditors(capabilities = {}, values = {}, entityType = "work-item") {
  return customFieldDefinitions(capabilities, entityType).map((definition) => {
    const control = field(`${definition.name ?? titleCase(definition.id)}${definition.required ? " *" : ""}`, configuredCustomFieldInput(definition, values[definition.id]));
    if (definition.helpText) control.append(el("small", {class: "field-help"}, definition.helpText));
    return control;
  });
}

function configuredWorkForm(capabilities = {}, typeId = "") {
  return (capabilities.forms ?? []).find((form) => {
    if (form.entityType && form.entityType !== "work-item") return false;
    const typeIds = form.typeIds ?? (form.typeId ? [form.typeId] : []);
    return !typeIds.length || typeIds.includes(typeId);
  });
}

function applyConfiguredWorkForm(formElement, capabilities = {}, typeId = "", {applyDefaults = false} = {}) {
  const definition = configuredWorkForm(capabilities, typeId);
  formElement.querySelector(".configured-form-note")?.remove();
  for (const label of formElement.querySelectorAll("label.field")) {
    label.hidden = false;
    label.querySelector(".configured-form-help")?.remove();
  }
  if (!definition) return;
  const fields = definition.fields ?? definition.fieldIds ?? [];
  const normalized = fields.map((entry) => typeof entry === "string" ? {id: entry} : {id: entry.id ?? entry.fieldId ?? entry.name, ...entry}).filter((entry) => entry.id);
  const byId = new Map(normalized.map((entry) => [String(entry.id), entry]));
  const core = new Set(["projectId", "title", "type", "status"]);
  if (normalized.length) {
    for (const control of formElement.querySelectorAll("input[name], select[name], textarea[name]")) {
      const name = control.name.startsWith("custom__") ? control.name.slice(8) : control.name;
      const config = byId.get(name);
      const label = control.closest("label.field");
      if (label) label.hidden = !core.has(control.name) && (!config || config.visible === false);
      if (config?.required) control.required = true;
      if (config?.helpText && label) label.append(el("small", {class: "field-help configured-form-help"}, config.helpText));
      if (applyDefaults && definition.defaults && Object.hasOwn(definition.defaults, name) && !control.value) control.value = String(definition.defaults[name] ?? "");
    }
  }
  formElement.prepend(el("p", {class: "configured-form-note"}, `Form: ${definition.name ?? definition.label ?? definition.id}${definition.description ? ` — ${definition.description}` : ""}`));
}

function configuredCustomFieldValues(data, capabilities = {}, current = {}, entityType = "work-item") {
  const values = {...current};
  for (const definition of customFieldDefinitions(capabilities, entityType)) {
    const key = `custom__${definition.id}`;
    if (definition.type === "calculated") continue;
    let value = data[key];
    delete data[key];
    if (["multi-select", "hierarchy"].includes(definition.type) || definition.multiSelect && ["select", "user", "version"].includes(definition.type)) {
      value = (Array.isArray(value) ? value : csvValues(value)).filter(Boolean);
    }
    else if (definition.type === "boolean") value = value === "" || value === undefined ? undefined : value === "true";
    else if (definition.type === "integer") value = value === "" || value === undefined ? undefined : Number.parseInt(value, 10);
    else if (definition.type === "decimal") value = value === "" || value === undefined ? undefined : Number(value);
    if (value === "" || value === undefined) delete values[definition.id];
    else values[definition.id] = value;
  }
  return values;
}

function taskCreateForm(client, projects, {onSaved, selectedProjectId = "", memberships = [], workItems = [], capabilities = {}} = {}) {
  const linkedTaskOptions = taskOptions(workItems, selectedProjectId, "No linked task").slice(1);
  const projectSelect = selectInput("projectId", projectOptions(projects), selectedProjectId);
  const relationLines = textareaInput("relations", "predecessor: task-id: 0\nrelated: another-task-id");
  const form = el("form", {class: "editor-form editor-form--wide task-create-form"}, [
    field("Project", projectSelect),
    field("Task", textInput("title", "Create stakeholder review")),
    field("Status", selectInput("status", workStatusOptions(), configuredDefaultStatusId)),
    field("Assignee", selectInput("assigneeId", memberOptions(memberships))),
    field("Team", selectInput("teamId", teamOptions(capabilities))),
    field("Due", el("input", {name: "dueDate", type: "date"})),
    field("Notes", textareaInput("description", "Decision, change, or outcome needed.")),
    el("details", {class: "advanced-panel task-create-form__more"}, [
      el("summary", {}, [
        el("span", {}, "More task fields"),
        el("small", {}, "Additional fields")
      ]),
      el("div", {class: "task-create-form__advanced"}, [
        field("Task type", selectInput("type", workTypeOptions(), configuredDefaultTypeId)),
        field("Priority", selectInput("priority", workPriorityOptions(capabilities), "medium")),
        field("Accountable", selectInput("accountableId", memberOptions(memberships))),
        field("Effort points", el("input", {name: "effortPoints", type: "number", min: "0", max: "100", value: "0"})),
        field("Estimate minutes", el("input", {name: "estimateMinutes", type: "number", min: "0", max: "100000", value: "0"})),
        field("Remaining minutes", el("input", {name: "remainingMinutes", type: "number", min: "0", max: "100000", value: "0"})),
        field("Progress", el("input", {name: "percentComplete", type: "number", min: "0", max: "100", value: "0"})),
        field("Scheduling", selectInput("schedulingMode", [{value: "manual", label: "Manual"}, {value: "automatic", label: "Automatic"}], "manual")),
        field("Category", textInput("category", "Delivery")),
        field("Version", textInput("versionName", "1.0")),
        field("Time period", textInput("periodName", "Launch window")),
        field("Period goal", textInput("periodGoal", "Validated delivery outcome")),
        field("Intake group", selectInput("intakeGroup", [{value: "", label: "None"}, ...intakeGroupList.map((value) => ({value, label: intakeGroupLabel(value)}))])),
        field("Milestone", textInput("milestoneName", "Pilot beta")),
        field("Workflow step", textInput("workflowStep", "Design review")),
        field("Workstream", textInput("workstream", "Implementation")),
        linkedTaskOptions.length ? field("Parent", selectInput("parentId", [{value: "", label: "None"}, ...linkedTaskOptions])) : "",
        linkedTaskOptions.length ? field("Blocked by", multiSelectInput("blockedBy", linkedTaskOptions)) : "",
        linkedTaskOptions.length ? field("Related", multiSelectInput("relatedIds", linkedTaskOptions)) : "",
        linkedTaskOptions.length ? field("Typed relations", relationLines) : "",
        field("Watchers", multiSelectInput("watcherIds", memberOptions(memberships, "No watcher").slice(1))),
        field("Start", el("input", {name: "startDate", type: "date"})),
        field("Acceptance criteria", textareaInput("acceptanceCriteria", "What must be true when this is done?")),
        ...configuredCustomFieldEditors(capabilities),
        field("Tags", textInput("tags", "pilot, planning"))
      ])
    ]),
    el("button", {class: "button button--primary", type: "submit"}, "Create task")
  ]);
  applyConfiguredWorkForm(form, capabilities, form.elements.type?.value, {applyDefaults: true});
  form.elements.type?.addEventListener("change", () => applyConfiguredWorkForm(form, capabilities, form.elements.type.value));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formValues(form);
    const projectId = String(data.projectId ?? "").trim();
    if (!projectId) {
      saveStatus(form, "Choose a project before creating a task.", "error");
      return;
    }
    const workflowStep = String(data.workflowStep ?? "").trim();
    const workstream = String(data.workstream ?? "").trim();
    delete data.projectId;
    delete data.workflowStep;
    delete data.workstream;
    data.relations = parseWorkRelationLines(data.relations, workItems.filter((item) => item.projectId === projectId));
    data.customFields = configuredCustomFieldValues(data, capabilities);
    if (workflowStep) data.customFields.workflowStep = workflowStep;
    if (workstream) data.customFields.workstream = workstream;
    try {
      await client.workItems.create(projectId, data, {idempotencyKey: crypto.randomUUID()});
      form.reset();
      if (selectedProjectId) projectSelect.value = selectedProjectId;
      saveStatus(form, "Task created.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function taskCreatePanel(client, projects = [], {onSaved, selectedProjectId = "", memberships = [], workItems = [], capabilities = {}, title = "Create task", description = "Tasks are the smallest unit of work. Add one here, then assign it, attach documents, plan dates, and move it through a view.", id = "new-task"} = {}) {
  const attrs = {class: "task-create-panel"};
  if (id) attrs.id = id;
  return el("section", attrs, [
    el("div", {class: "section-heading"}, [
      el("div", {}, [
        el("h2", {}, title),
        description ? el("p", {}, description) : ""
      ])
    ]),
    taskCreateForm(client, projects, {onSaved, selectedProjectId, memberships, workItems, capabilities})
  ]);
}

export function taskCommandCenter(client, projects = [], items = [], {onSaved, selectedProjectId = "", memberships = [], title = "Tasks"} = {}) {
  const visibleTasks = [...items]
    .sort((a, b) => {
      const openWeight = Number(isClosedWorkStatus(a.status)) - Number(isClosedWorkStatus(b.status));
      return openWeight
        || priorityWeight(b.priority) - priorityWeight(a.priority)
        || String(a.dueDate ?? "9999-12-31").localeCompare(String(b.dueDate ?? "9999-12-31"))
        || Number(a.rank ?? 0) - Number(b.rank ?? 0);
    })
    .slice(0, 5);
  const planningHref = selectedProjectId ? `/app/planning?projectId=${encodeURIComponent(selectedProjectId)}` : "/app/planning";
  const documentHref = selectedProjectId ? `/app/documents?projectId=${encodeURIComponent(selectedProjectId)}` : "/app/documents";
  const timeHref = selectedProjectId ? `/app/time?projectId=${encodeURIComponent(selectedProjectId)}` : "/app/time";
  return el("section", {class: "task-command", id: "new-task"}, [
    el("div", {class: "section-heading"}, [
      el("h2", {}, title),
      miniLinks([
        {label: "Views", href: planningHref},
        {label: "Documents", href: documentHref},
        {label: "Time", href: timeHref}
      ])
    ]),
    el("div", {class: "task-command__grid"}, [
      el("section", {class: "task-command__create"}, [
        el("div", {class: "section-heading"}, el("h3", {}, "Create task")),
        taskCreateForm(client, projects, {onSaved, selectedProjectId, memberships, workItems: items})
      ]),
      el("section", {class: "task-command__list"}, [
        el("div", {class: "section-heading"}, [
          el("h3", {}, "Open tasks"),
          miniLinks([{label: "All task views", href: planningHref}])
        ]),
        visibleTasks.length ? el("div", {class: "task-command__cards"}, visibleTasks.map((item) => {
          const card = workCard(item);
          card.classList.add(`work-card--${workTone(item)}`);
          return card;
        })) : emptyView("No tasks yet.")
      ])
    ])
  ]);
}

export function workItemForm(client, projectId, {onSaved, workItems = [], memberships = [], capabilities = {}} = {}) {
  const relationOptions = [{value: "", label: "None"}, ...workItems.map((item) => ({value: item.id, label: item.title}))];
  const linkedWorkOptions = workItems.map((item) => ({value: item.id, label: item.title}));
  const form = el("form", {class: "editor-form editor-form--wide"}, [
    field("Task", textInput("title", "Prepare gate review")),
    field("Task type", selectInput("type", workTypeOptions(), configuredDefaultTypeId)),
    field("Status", selectInput("status", workStatusOptions(), configuredDefaultStatusId)),
    field("Priority", selectInput("priority", workPriorityOptions(capabilities), "medium")),
    field("Assignee", selectInput("assigneeId", memberOptions(memberships))),
    field("Team", selectInput("teamId", teamOptions(capabilities))),
    field("Accountable", selectInput("accountableId", memberOptions(memberships))),
    field("Effort points", el("input", {name: "effortPoints", type: "number", min: "0", max: "100", value: "0"})),
    field("Estimate minutes", el("input", {name: "estimateMinutes", type: "number", min: "0", max: "100000", value: "0"})),
    field("Remaining minutes", el("input", {name: "remainingMinutes", type: "number", min: "0", max: "100000", value: "0"})),
    field("Progress", el("input", {name: "percentComplete", type: "number", min: "0", max: "100", value: "0"})),
    field("Scheduling", selectInput("schedulingMode", [{value: "manual", label: "Manual"}, {value: "automatic", label: "Automatic"}], "manual")),
    field("Category", textInput("category", "Delivery")),
    field("Version", textInput("versionName", "1.0")),
    field("Time period", textInput("periodName", "Launch window")),
    field("Period goal", textInput("periodGoal", "Validated delivery outcome")),
    field("Intake group", selectInput("intakeGroup", [{value: "", label: "None"}, ...intakeGroupList.map((value) => ({value, label: intakeGroupLabel(value)}))])),
    field("Milestone", textInput("milestoneName", "Pilot beta")),
    field("Workflow step", textInput("workflowStep", "Design review")),
    field("Parent", selectInput("parentId", relationOptions)),
    field("Blocked by", multiSelectInput("blockedBy", linkedWorkOptions)),
    field("Related", multiSelectInput("relatedIds", linkedWorkOptions)),
    field("Typed relations", textareaInput("relations", "predecessor: task-id: 0\nrelated: another-task-id")),
    field("Watchers", multiSelectInput("watcherIds", memberOptions(memberships, "No watcher").slice(1))),
    field("Start", el("input", {name: "startDate", type: "date"})),
    field("Due", el("input", {name: "dueDate", type: "date"})),
    field("Notes", textareaInput("description", "What needs to change?")),
    field("Acceptance criteria", textareaInput("acceptanceCriteria", "What must be true when this is done?")),
    ...configuredCustomFieldEditors(capabilities),
    customFieldDefinitions(capabilities).length ? "" : field("Custom fields", textareaInput("customFields", "impact: high\ncomponent: API")),
    field("Tags", textInput("tags", "api, launch")),
    el("button", {class: "button button--primary", type: "submit"}, "Create task")
  ]);
  applyConfiguredWorkForm(form, capabilities, form.elements.type?.value, {applyDefaults: true});
  form.elements.type?.addEventListener("change", () => applyConfiguredWorkForm(form, capabilities, form.elements.type.value));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formValues(form);
    const workflowStep = String(data.workflowStep ?? "").trim();
    delete data.workflowStep;
    data.customFields = customFieldDefinitions(capabilities).length ? configuredCustomFieldValues(data, capabilities) : parseKeyValueLines(data.customFields);
    data.relations = parseWorkRelationLines(data.relations, workItems);
    if (workflowStep) data.customFields.workflowStep = workflowStep;
    try {
      await client.workItems.create(projectId, data, {idempotencyKey: crypto.randomUUID()});
      form.reset();
      saveStatus(form, "Task created.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function workItemEditForm(client, item, {onSaved, workItems = [], memberships = [], capabilities = {}} = {}) {
  const relatedItems = workItems
    .filter((candidate) => candidate.id !== item.id)
    .map((candidate) => ({value: candidate.id, label: candidate.title}));
  const parentOptions = [{value: "", label: "None"}, ...relatedItems];
  const byId = new Map(workItems.map((candidate) => [candidate.id, candidate]));
  const form = el("form", {class: "editor-form editor-form--wide work-editor"}, [
    field("Task", textInput("title", "Task title", item.title ?? "")),
    field("Task type", selectInput("type", workTypeOptions(item.type), item.type ?? configuredDefaultTypeId)),
    field("Status", selectInput("status", workStatusOptions(item.status), item.status ?? configuredDefaultStatusId)),
    field("Priority", selectInput("priority", workPriorityOptions(capabilities, item.priority), item.priority ?? "medium")),
    field("Assignee", selectInput("assigneeId", memberOptions(memberships), item.assigneeId ?? "")),
    field("Team", selectInput("teamId", teamOptions(capabilities), item.teamId ?? "")),
    field("Accountable", selectInput("accountableId", memberOptions(memberships), item.accountableId ?? "")),
    field("Effort points", el("input", {name: "effortPoints", type: "number", min: "0", max: "100", value: String(item.effortPoints ?? 0)})),
    field("Estimate minutes", el("input", {name: "estimateMinutes", type: "number", min: "0", max: "100000", value: String(item.estimateMinutes ?? 0)})),
    field("Remaining minutes", el("input", {name: "remainingMinutes", type: "number", min: "0", max: "100000", value: String(item.remainingMinutes ?? 0)})),
    field("Progress", el("input", {name: "percentComplete", type: "number", min: "0", max: "100", value: String(item.percentComplete ?? 0)})),
    field("Scheduling", selectInput("schedulingMode", [{value: "manual", label: "Manual"}, {value: "automatic", label: "Automatic"}], item.schedulingMode ?? "manual")),
    field("Category", textInput("category", "Delivery", item.category ?? "")),
    field("Version", textInput("versionName", "1.0", item.versionName ?? "")),
    field("Time period", textInput("periodName", "Launch window", item.periodName ?? "")),
    field("Period goal", textInput("periodGoal", "Validated delivery outcome", item.periodGoal ?? "")),
    field("Intake group", selectInput("intakeGroup", [{value: "", label: "None"}, ...intakeGroupList.map((value) => ({value, label: intakeGroupLabel(value)}))], item.intakeGroup ?? "")),
    field("Milestone", textInput("milestoneName", "Pilot beta", item.milestoneName ?? "")),
    field("Workflow step", textInput("workflowStep", "Design review", item.customFields?.workflowStep ?? "")),
    field("Parent", selectInput("parentId", parentOptions, item.parentId ?? "")),
    field("Blocked by", multiSelectInput("blockedBy", relatedItems, item.blockedBy ?? [])),
    field("Related", multiSelectInput("relatedIds", relatedItems, item.relatedIds ?? [])),
    field("Typed relations", textareaInput("relations", "predecessor: task-id: 0", formatWorkRelations(item.relations, byId))),
    field("Watchers", multiSelectInput("watcherIds", memberOptions(memberships, "No watcher").slice(1), item.watcherIds ?? [])),
    field("Start", el("input", {name: "startDate", type: "date", value: formatDate(item.startDate)})),
    field("Due", el("input", {name: "dueDate", type: "date", value: formatDate(item.dueDate)})),
    field("Notes", textareaInput("description", "What needs to change?", item.description ?? "")),
    field("Acceptance criteria", textareaInput("acceptanceCriteria", "What must be true when this is done?", item.acceptanceCriteria ?? "")),
    ...configuredCustomFieldEditors(capabilities, item.customFields ?? {}),
    customFieldDefinitions(capabilities).length ? "" : field("Custom fields", textareaInput("customFields", "impact: high\ncomponent: API", formatKeyValueLines(displayCustomFields(item.customFields, ["workflowStep"])))),
    field("Tags", textInput("tags", "api, launch", csvList(item.tags))),
    el("button", {class: "button button--primary", type: "submit"}, "Save task")
  ]);
  applyConfiguredWorkForm(form, capabilities, item.type);
  form.elements.type?.addEventListener("change", () => applyConfiguredWorkForm(form, capabilities, form.elements.type.value));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formValues(form);
    const workflowStep = String(data.workflowStep ?? "").trim();
    delete data.workflowStep;
    data.customFields = customFieldDefinitions(capabilities).length ? configuredCustomFieldValues(data, capabilities) : parseKeyValueLines(data.customFields);
    data.relations = parseWorkRelationLines(data.relations, workItems);
    if (workflowStep) data.customFields.workflowStep = workflowStep;
    data.version = item.version;
    try {
      await client.workItems.patch(item.projectId, item.id, data);
      saveStatus(form, "Task saved.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

function workItemLifecycleActions(client, item, projects = [], {onSaved} = {}) {
  const status = el("p", {class: "form-status", role: "status", "aria-live": "polite"});
  const duplicate = el("button", {class: "button", type: "button"}, "Duplicate task");
  const targetProjects = projects.filter((project) => project.id !== item.projectId && !project.archived && !project.template);
  const target = selectInput("targetProjectId", projectOptions(targetProjects), "");
  const move = el("button", {class: "button", type: "button", disabled: "true"}, "Move task");
  target.addEventListener("change", () => { move.disabled = !target.value; });
  const confirmDelete = el("input", {type: "checkbox"});
  const remove = el("button", {class: "button", type: "button", disabled: "true"}, "Delete task");
  confirmDelete.addEventListener("change", () => { remove.disabled = !confirmDelete.checked; });
  const run = async (button, action, success) => {
    button.disabled = true;
    status.className = "form-status";
    status.textContent = "Saving...";
    try {
      await action();
      status.className = "form-status ok";
      status.textContent = success;
      onSaved?.();
    } catch (error) {
      button.disabled = false;
      status.className = "form-status error";
      status.textContent = error.message;
    }
  };
  duplicate.addEventListener("click", () => run(duplicate, () => client.workItems.copy(item.projectId, item.id, {}), "Task duplicated."));
  move.addEventListener("click", () => run(move, () => client.workItems.move(item.projectId, item.id, {version: item.version, targetProjectId: target.value}), "Task moved."));
  remove.addEventListener("click", () => run(remove, () => client.workItems.delete(item.projectId, item.id, {version: item.version}), "Task deleted."));
  return el("section", {class: "lifecycle-controls"}, [
    duplicate,
    targetProjects.length ? field("Move to project", target) : el("p", {}, "No other active project is available."),
    targetProjects.length ? move : "",
    el("details", {class: "danger-zone"}, [
      el("summary", {}, "Delete task"),
      el("p", {}, "Remove hierarchy and relation references before deleting a connected task."),
      el("label", {class: "check-row"}, [confirmDelete, "I understand this action removes the task"]),
      remove
    ]),
    status
  ]);
}

function workItemCustomActions(client, item, capabilities = {}, currentRole = "", {onSaved} = {}) {
  const actions = (capabilities.customActions ?? []).filter((action) => {
    const roles = action.roleIds ?? action.roles ?? [];
    return !roles.length || roles.includes(currentRole);
  });
  if (!actions.length) return emptyView("No one-click actions are available for your role.");
  const status = el("p", {class: "form-status", role: "status", "aria-live": "polite"});
  return el("section", {class: "custom-action-list"}, [
    el("div", {class: "button-row"}, actions.map((action) => {
      const button = el("button", {class: "button", type: "button"}, action.name ?? titleCase(action.id));
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await client.workItems.action(item.projectId, item.id, action.id, {version: item.version});
          status.className = "form-status ok";
          status.textContent = `${action.name ?? titleCase(action.id)} applied.`;
          onSaved?.();
        } catch (error) {
          button.disabled = false;
          status.className = "form-status error";
          status.textContent = error.message;
        }
      });
      return button;
    })),
    status
  ]);
}

export const MAX_BULK_WORK_ITEM_SELECTION = 25;

const bulkWorkItemFields = Object.freeze({
  status: "Status",
  priority: "Priority",
  assigneeId: "Assignee",
  type: "Task type",
  periodName: "Time period",
  milestoneName: "Milestone"
});

export function createBulkWorkItemPatch(fieldName, value, {clear = false} = {}) {
  if (!fieldName) return {};
  if (!Object.hasOwn(bulkWorkItemFields, fieldName)) throw new Error("Choose a supported task field.");
  if (clear) {
    if (!["periodName", "milestoneName"].includes(fieldName)) throw new Error(`${bulkWorkItemFields[fieldName]} cannot be cleared.`);
    return {[fieldName]: ""};
  }
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`Choose a value for ${bulkWorkItemFields[fieldName].toLowerCase()}.`);
  return {[fieldName]: normalized};
}

export async function applyBulkWorkItemPatch(client, items, patch, {maxSelection = MAX_BULK_WORK_ITEM_SELECTION} = {}) {
  if (!Array.isArray(items) || !items.length) return {succeeded: [], failed: []};
  if (items.length > maxSelection) throw new Error(`Select no more than ${maxSelection} tasks.`);
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length) {
    throw new Error("Choose a field and value before applying a bulk update.");
  }
  const succeeded = [];
  const failed = [];
  for (const item of items) {
    try {
      if (!item?.projectId || !item?.id || !Number.isFinite(Number(item.version))) {
        throw new Error("Task identity or version is missing.");
      }
      const updated = await client.workItems.patch(item.projectId, item.id, {...patch, version: item.version});
      succeeded.push({id: item.id, item, updated});
    } catch (error) {
      failed.push({
        id: item?.id,
        item,
        message: error?.message ?? "Task update failed."
      });
    }
  }
  return {succeeded, failed};
}

function workItemBulkEditor(client, items, {
  selectedIds,
  memberships = [],
  capabilities = {},
  onSaved,
  onRender,
  maxSelection = MAX_BULK_WORK_ITEM_SELECTION
} = {}) {
  const fieldSelect = selectInput("bulkField", [
    {value: "", label: "Leave unchanged / choose field"},
    ...Object.entries(bulkWorkItemFields).map(([value, label]) => ({value, label}))
  ]);
  const selectionSummary = el("strong", {}, "0 selected");
  const valueHost = el("div", {class: "bulk-work-editor__value"});
  const result = el("div", {class: "bulk-work-editor__result", role: "status", "aria-live": "polite"});
  const applyButton = el("button", {class: "button button--primary", type: "submit", disabled: "true"}, "Apply update");
  const clearSelectionButton = el("button", {class: "button button--ghost", type: "button", disabled: "true"}, "Clear selection");
  let valueInput;
  let clearInput;

  const setResult = (message = "", tone = "", failures = []) => {
    result.className = `bulk-work-editor__result${tone ? ` ${tone}` : ""}`;
    result.replaceChildren(
      message ? el("p", {}, message) : "",
      failures.length ? el("ul", {}, failures.map((failure) => (
        el("li", {}, `${failure.item?.title ?? failure.id ?? "Task"}: ${failure.message}`)
      ))) : ""
    );
  };

  const renderValueField = () => {
    const fieldName = fieldSelect.value;
    valueInput = undefined;
    clearInput = undefined;
    valueHost.replaceChildren();
    if (!fieldName) {
      valueHost.append(el("p", {class: "bulk-work-editor__hint"}, "Choose one field. Every other field remains unchanged."));
      return;
    }
    if (fieldName === "status") {
      valueInput = selectInput("bulkValue", [{value: "", label: "Choose status"}, ...workStatusOptions()]);
    } else if (fieldName === "priority") {
      valueInput = selectInput("bulkValue", [{value: "", label: "Choose priority"}, ...workPriorityOptions(capabilities)]);
    } else if (fieldName === "assigneeId") {
      valueInput = selectInput("bulkValue", [{value: "", label: "Choose assignee"}, ...memberOptions(memberships).slice(1)]);
    } else if (fieldName === "type") {
      valueInput = selectInput("bulkValue", [{value: "", label: "Choose task type"}, ...workTypeOptions()]);
    } else {
      const label = bulkWorkItemFields[fieldName];
      valueInput = textInput("bulkValue", fieldName === "periodName" ? "Launch window" : "Pilot beta");
      clearInput = el("input", {type: "checkbox", name: "bulkClear"});
      clearInput.addEventListener("change", () => {
        valueInput.disabled = clearInput.checked;
        if (clearInput.checked) valueInput.value = "";
      });
      valueHost.append(el("label", {class: "bulk-work-editor__clear"}, [clearInput, `Clear ${label.toLowerCase()}`]));
    }
    valueHost.prepend(field("New value", valueInput));
  };

  const sync = ({limitReached = false} = {}) => {
    const count = selectedIds?.size ?? 0;
    selectionSummary.textContent = `${count} selected`;
    applyButton.disabled = count === 0 || !fieldSelect.value;
    clearSelectionButton.disabled = count === 0;
    if (limitReached) setResult(`Selection is limited to ${maxSelection} tasks on this page.`, "error");
  };

  fieldSelect.addEventListener("change", () => {
    renderValueField();
    sync();
  });
  clearSelectionButton.addEventListener("click", () => {
    selectedIds.clear();
    setResult();
    sync();
    onRender?.();
  });

  const form = el("form", {class: "bulk-work-editor"}, [
    el("div", {class: "bulk-work-editor__summary"}, [
      selectionSummary,
      el("small", {}, `Current page only; maximum ${maxSelection}.`)
    ]),
    field("Field", fieldSelect),
    valueHost,
    el("div", {class: "bulk-work-editor__actions"}, [applyButton, clearSelectionButton]),
    result
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selectedItems = items.filter((item) => selectedIds.has(item.id));
    try {
      const patch = createBulkWorkItemPatch(fieldSelect.value, valueInput?.value, {clear: Boolean(clearInput?.checked)});
      if (!Object.keys(patch).length) throw new Error("Choose a field to update.");
      applyButton.disabled = true;
      clearSelectionButton.disabled = true;
      applyButton.textContent = "Updating...";
      setResult(`Updating ${selectedItems.length} task${selectedItems.length === 1 ? "" : "s"} in sequence...`);
      const updateResult = await applyBulkWorkItemPatch(client, selectedItems, patch, {maxSelection});
      for (const success of updateResult.succeeded) {
        if (success.updated && typeof success.updated === "object") Object.assign(success.item, success.updated);
        selectedIds.delete(success.id);
      }
      if (updateResult.failed.length) {
        setResult(
          `Updated ${updateResult.succeeded.length}; ${updateResult.failed.length} failed and remain selected.`,
          "error",
          updateResult.failed
        );
        onRender?.();
      } else {
        setResult(`Updated ${updateResult.succeeded.length} task${updateResult.succeeded.length === 1 ? "" : "s"}.`, "ok");
        if (onSaved) onSaved();
        else onRender?.();
      }
    } catch (error) {
      setResult(error?.message ?? "Bulk update failed.", "error");
    } finally {
      applyButton.textContent = "Apply update";
      sync();
    }
  });

  renderValueField();
  sync();
  return {node: form, sync};
}

export function workItemTable(items, {
  selectedIds,
  onSelectionChange,
  maxSelection = MAX_BULK_WORK_ITEM_SELECTION,
  capabilities = {}
} = {}) {
  const selectable = selectedIds instanceof Set && typeof onSelectionChange === "function";
  const headerCheckbox = selectable
    ? el("input", {class: "work-select__checkbox", type: "checkbox", "aria-label": "Select visible tasks", "data-column-label": "Select"})
    : undefined;
  const rowCheckboxes = new Map();
  const defaultColumns = ["task", "type", "status", "priority", "period", "effort", "relations", "assignee", "due"];
  const configuredColumns = capabilities.work?.tableColumns?.length ? capabilities.work.tableColumns : defaultColumns;
  const columnLabel = (column) => ({task: "Task", type: "Type", status: "Status", priority: "Priority", period: "Period", effort: "Effort", relations: "Relations", assignee: "Assignee", accountable: "Accountable", start: "Start", due: "Due", remaining: "Remaining", progress: "Progress", category: "Category", version: "Version", project: "Project"})[column] ?? (String(column).startsWith("custom:") ? titleCase(String(column).slice(7)) : titleCase(column));
  const highlightFor = (item) => (capabilities.work?.highlightRules ?? []).find((rule) => {
    const value = String(rule.field ?? "").startsWith("custom:") ? item.customFields?.[String(rule.field).slice(7)] : item[rule.field];
    if (rule.operator === "contains") return String(value ?? "").toLowerCase().includes(String(rule.value ?? "").toLowerCase());
    if (rule.operator === "before") return String(value ?? "") < String(rule.value ?? "");
    if (rule.operator === "after") return String(value ?? "") > String(rule.value ?? "");
    return String(value ?? "") === String(rule.value ?? "");
  });
  const taskCell = (item) => {
    const highlight = highlightFor(item);
    return el("div", {class: `object-cell${highlight ? ` work-highlight work-highlight--${highlight.tone ?? "info"}` : ""}`, title: highlight?.label}, [
      el("a", {href: workItemHref(item)}, item.title),
      item.projectId ? miniLinks([{label: item.projectName ? `Project: ${item.projectName}` : "Project", href: projectHref(item.projectId)}, {label: "Time", href: `/app/time?projectId=${encodeURIComponent(item.projectId)}`}]) : ""
    ]);
  };
  const relationText = (item) => [...(item.relations ?? []).map((relation) => titleCase(relation.type)), item.parentId ? "Parent" : "", item.blockedBy?.length ? "Blocked" : "", item.relatedIds?.length ? "Related" : ""].filter(Boolean).join(", ");
  const columnValue = (item, column) => ({
    task: () => taskCell(item), type: () => badge(workTypeLabel(item.type), "neutral"), status: () => badge(workStatusLabel(item.status), statusTone(item.status)), priority: () => badge(item.priority, statusTone(item.priority)), period: () => item.periodName ?? "", effort: () => Number(item.effortPoints ?? 0), relations: () => relationText(item), assignee: () => item.assigneeName ?? item.assigneeId ?? "", accountable: () => item.accountableName ?? item.accountableId ?? "", start: () => formatDate(item.startDate), due: () => formatDate(item.dueDate), remaining: () => formatHours(item.remainingMinutes), progress: () => `${Number(item.percentComplete ?? 0)}%`, category: () => item.category ?? "", version: () => item.versionName ?? "", project: () => item.projectName ?? item.projectId ?? ""
  })[column]?.() ?? (String(column).startsWith("custom:") ? item.customFields?.[String(column).slice(7)] ?? "" : item[column] ?? "");
  const headers = configuredColumns.map(columnLabel);
  if (headerCheckbox) headers.unshift(headerCheckbox);
  const rows = items.map((item) => {
    const row = configuredColumns.map((column) => columnValue(item, column));
    if (selectable) {
      const checkbox = el("input", {
        class: "work-select__checkbox",
        type: "checkbox",
        "aria-label": `Select ${item.title ?? "task"}`
      });
      checkbox.addEventListener("change", () => {
        let limitReached = false;
        if (checkbox.checked) {
          if (selectedIds.size >= maxSelection) {
            checkbox.checked = false;
            limitReached = true;
          } else selectedIds.add(item.id);
        } else selectedIds.delete(item.id);
        syncSelection();
        onSelectionChange({limitReached, selectedCount: selectedIds.size});
      });
      rowCheckboxes.set(item.id, checkbox);
      row.unshift(checkbox);
    }
    return row;
  });
  const syncSelection = () => {
    if (!selectable) return;
    const selectedVisible = items.filter((item) => selectedIds.has(item.id));
    for (const [id, checkbox] of rowCheckboxes) {
      checkbox.checked = selectedIds.has(id);
      checkbox.disabled = !checkbox.checked && selectedIds.size >= maxSelection;
    }
    headerCheckbox.checked = selectedVisible.length > 0;
    headerCheckbox.indeterminate = selectedVisible.length > 0 && selectedVisible.length < items.length;
    headerCheckbox.disabled = items.length === 0;
    headerCheckbox.setAttribute("aria-label", selectedVisible.length ? "Clear visible task selection" : "Select visible tasks");
  };
  headerCheckbox?.addEventListener("change", () => {
    let limitReached = false;
    const selectedVisible = items.filter((item) => selectedIds.has(item.id));
    if (selectedVisible.length) {
      for (const item of items) selectedIds.delete(item.id);
    } else {
      const available = Math.max(0, maxSelection - selectedIds.size);
      for (const item of items.slice(0, available)) selectedIds.add(item.id);
      limitReached = items.length > available;
    }
    syncSelection();
    onSelectionChange({limitReached, selectedCount: selectedIds.size});
  });
  const table = dataTable(headers, rows);
  syncSelection();
  return table;
}

export function workPackageDetails(items = [], client, {onSaved, memberships = [], documents = [], projects = [], activities = [], capabilities = {}, currentRole = ""} = {}) {
  if (!items.length) return emptyView("No tasks yet.");
  const byId = new Map(items.map((item) => [item.id, item]));
  const nameFor = (id) => byId.get(id)?.title ?? id;
  const activeId = decodeURIComponent(location.hash.slice(1));
  const section = el("section", {class: "work-details", id: "task-details"}, [
    el("div", {class: "section-heading"}, el("h2", {}, "Task details")),
    ...items.map((item) => {
      const customRows = Object.entries(item.customFields ?? {}).map(([name, value]) => [titleCase(name), value]);
      const itemDocuments = documents.filter((document) => document.workItemId === item.id);
      const itemActivity = activities.filter((activity) => activity.entityType === "work-item" && activity.entityId === item.id);
      const detailAttrs = {id: item.id, class: "work-detail"};
      if (item.id === activeId) detailAttrs.open = "true";
      return el("details", detailAttrs, [
        el("summary", {}, [
          el("span", {}, item.title),
          el("span", {class: "badge-row"}, [
            badge(workTypeLabel(item.type), "neutral"),
            badge(workStatusLabel(item.status), statusTone(item.status)),
            item.blockedBy?.length ? badge("Blocked dependency", "danger") : ""
          ])
        ]),
        el("div", {class: "work-detail__body"}, [
          miniLinks([
            {label: "Record time", href: item.projectId ? `/app/time?projectId=${encodeURIComponent(item.projectId)}` : ""},
            {label: "Attach document", href: !client?.isPublicDemo && item.projectId ? `/app/documents?projectId=${encodeURIComponent(item.projectId)}&workItemId=${encodeURIComponent(item.id)}` : ""},
            {label: "Open planning board", href: item.projectId ? `/app/planning?projectId=${encodeURIComponent(item.projectId)}` : ""}
          ]),
          item.description ? projectContentBody(item.description, {content: item}) : "",
          item.acceptanceCriteria ? el("section", {}, [
            el("h3", {}, "Acceptance criteria"),
            projectContentBody(item.acceptanceCriteria, {content: item})
          ]) : "",
          dataTable(["Field", "Value"], [
            ["Assignee", item.assigneeName ?? item.assigneeId ?? "Unassigned"],
            ["Team", teamName(capabilities, item.teamId)],
            ["Accountable", memberName(memberships, item.accountableId)],
            ["Category / version", [item.category, item.versionName].filter(Boolean).join(" / ")],
            ["Time period", item.periodName ?? "Unscheduled"],
            ["Milestone", item.milestoneName ?? "Unplanned"],
            ["Workflow step", item.customFields?.workflowStep ?? "Unassigned"],
            ["Parent", item.parentId ? nameFor(item.parentId) : ""],
            ["Blocked by", (item.blockedBy ?? []).map(nameFor).join(", ")],
            ["Related", (item.relatedIds ?? []).map(nameFor).join(", ")],
            ["Typed relations", (item.relations ?? []).map((relation) => `${titleCase(relation.type)}: ${nameFor(relation.targetId)}${relation.lagDays ? ` (${relation.lagDays}d)` : ""}`).join(", ")],
            ["Watchers", (item.watcherIds ?? []).map((id) => memberName(memberships, id)).join(", ")],
            ["Estimate", formatHours(item.estimateMinutes)],
            ["Remaining", formatHours(item.remainingMinutes)],
            ["Recorded", formatHours(item.recordedMinutes)],
            ["Progress", `${Number(item.percentComplete ?? 0)}% · ${titleCase(item.schedulingMode ?? "manual")}`]
          ]),
          itemDocuments.length ? actionPanel("Linked documents", documentsTable(itemDocuments, client, {onSaved, workItems: items}), {open: true}) : "",
          actionPanel("Conversation and history", itemActivity.length ? activityList(itemActivity) : emptyView("No task comments or history yet."), {open: itemActivity.length > 0, meta: `${itemActivity.length} events`}),
          client && item.projectId
            ? client.isPublicDemo
              ? publicDemoUploadNotice()
              : actionPanel("Attach document", documentUploadForm(client, item.projectId, {onSaved, selectedWorkItemId: item.id, workItems: items}), {meta: "Connect a file to this task"})
            : "",
          customRows.length ? dataTable(["Custom field", "Value"], customRows) : "",
          client && (capabilities.customActions ?? []).length ? actionPanel("One-click actions", workItemCustomActions(client, item, capabilities, currentRole, {onSaved}), {meta: `${(capabilities.customActions ?? []).length} configured`}) : "",
          client && !(capabilities.work?.readOnlyStatusIds ?? []).includes(item.status) ? actionPanel("Edit task", workItemEditForm(client, item, {onSaved, workItems: items, memberships, capabilities}), {open: item.id === activeId}) : "",
          client && (capabilities.work?.readOnlyStatusIds ?? []).includes(item.status) ? el("p", {class: "public-demo-feature-notice", role: "note"}, "This task state is read-only. Change its status to edit fields.") : "",
          client ? actionPanel("Task lifecycle", workItemLifecycleActions(client, item, projects, {onSaved}), {meta: "Duplicate, move, delete"}) : ""
        ])
      ]);
    })
  ]);
  const openTarget = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return;
    const target = document.getElementById(id);
    if (target && section.contains(target) && target.tagName === "DETAILS") {
      target.open = true;
      target.scrollIntoView({block: "start"});
    }
  };
  requestAnimationFrame(openTarget);
  window.addEventListener("hashchange", openTarget);
  return section;
}

function workCard(item, {draggable = false, moveTargets = [], onMove, compact = false} = {}) {
  const href = workItemHref(item);
  const attrs = {class: "work-card"};
  if (draggable) attrs.draggable = "true";
  if (compact) attrs.class += " work-card--compact";
  const blocked = Boolean(item.blockedBy?.length || item.status === "blocked");
  const showType = !compact || ["bug", "risk", "feature", "milestone"].includes(item.type);
  const showPriority = !compact || blocked || ["high", "critical"].includes(item.priority);
  const topSignals = [
    showType ? badge(workTypeLabel(item.type ?? configuredDefaultTypeId), item.type === "bug" ? "danger" : "neutral") : "",
    showPriority ? blocked ? badge("Blocked", "danger") : badge(item.priority ?? "medium", statusTone(item.priority)) : ""
  ].filter(Boolean);
  const card = el("article", attrs, [
    topSignals.length ? el("div", {class: "work-card__top"}, topSignals) : "",
    el("a", {class: "work-card__title", href}, item.title ?? "Untitled task"),
    el("div", {class: "work-card__meta"}, [
      item.projectId ? el("a", {href: projectHref(item.projectId)}, item.projectName ?? item.projectId ?? "") : "",
      el("span", {}, item.assigneeName ?? item.assigneeId ?? "Unassigned"),
      !compact && item.periodName ? el("span", {}, item.periodName) : "",
      !compact && item.customFields?.workflowStep ? el("span", {}, item.customFields.workflowStep) : "",
      !compact && item.customFields?.workstream ? el("span", {}, item.customFields.workstream) : "",
      item.dueDate ? el("span", {}, `Due ${formatDate(item.dueDate)}`) : "",
      el("span", {title: "Relative-size estimate; not hours"}, `${Number(item.effortPoints ?? 0)} effort pts`)
    ])
  ]);
  if (moveTargets.length && onMove) {
    const target = selectInput("moveTo", [
      {value: "", label: "Move to…"},
      ...moveTargets.map((option) => (
        typeof option === "string" ? {value: option, label: workStatusLabel(option)} : option
      ))
    ]);
    target.options[0].disabled = true;
    target.setAttribute("aria-label", `Move ${item.title ?? "task"} to column`);
    const move = el("button", {class: "button work-card__move-button", type: "button", disabled: "true"}, "Move");
    target.addEventListener("change", () => { move.disabled = !target.value; });
    move.addEventListener("click", async () => {
      if (!target.value) return;
      move.disabled = true;
      try {
        await onMove(target.value);
      } finally {
        move.disabled = false;
      }
    });
    card.append(el("div", {class: "work-card__actions"}, [target, move]));
  }
  return card;
}

export function workItemKanban(items, client, {onSaved} = {}) {
  const moveStatus = el("p", {class: "form-status kanban__status", role: "status", "aria-live": "polite"});
  const statuses = workStatusValues(items);
  const moveItem = async (item, nextStatus) => {
    moveStatus.className = "form-status kanban__status";
    moveStatus.textContent = "";
    try {
      await client.workItems.patch(item.projectId, item.id, {status: nextStatus, version: item.version});
      moveStatus.className = "form-status kanban__status ok";
      moveStatus.textContent = `Moved ${item.title ?? "task"} to ${workStatusLabel(nextStatus)}.`;
      onSaved?.();
    } catch (error) {
      moveStatus.className = "form-status kanban__status error";
      moveStatus.textContent = error.message;
    }
  };
  const board = el("section", {class: "kanban"}, statuses.map((status) => {
    const acceptsMoves = workStatusList.includes(status);
    const column = el("div", {class: `kanban__column${acceptsMoves ? "" : " is-retired"}`});
    column.append(el("h3", {}, workStatusLabel(status)));
    for (const item of items.filter((candidate) => candidate.status === status)) {
      const card = workCard(item, {
        draggable: true,
        moveTargets: statuses.filter((candidate) => candidate !== status && workStatusList.includes(candidate)),
        onMove: (nextStatus) => moveItem(item, nextStatus)
      });
      card.addEventListener("dragstart", (event) => event.dataTransfer?.setData("text/plain", item.id));
      column.append(card);
    }
    if (acceptsMoves) {
      column.addEventListener("dragover", (event) => event.preventDefault());
      column.addEventListener("drop", async (event) => {
        event.preventDefault();
        const id = event.dataTransfer?.getData("text/plain");
        const item = items.find((candidate) => candidate.id === id);
        if (!item || item.status === status) return;
        await moveItem(item, status);
      });
    }
    return column;
  }));
  return el("div", {class: "kanban-shell"}, [board, moveStatus]);
}

function workCalendarView(items = []) {
  const rows = [...items].sort((a, b) => String(a.dueDate ?? "9999-12-31").localeCompare(String(b.dueDate ?? "9999-12-31")) || priorityWeight(b.priority) - priorityWeight(a.priority));
  return rows.length
    ? el("section", {class: "list-calendar"}, rows.map((item) => (
      el("a", {class: `calendar-row calendar-row--${workTone(item)}`, href: workItemHref(item)}, [
        el("time", {}, formatDate(item.dueDate) || "No due date"),
        el("strong", {}, item.title),
        el("span", {}, [item.projectName, workStatusLabel(item.status ?? configuredDefaultStatusId), item.assigneeName ?? item.assigneeId ?? "Unassigned"].filter(Boolean).join(" / ")),
        badge(dueText(item.dueDate, item.status), dueTone(item.dueDate, item.status))
      ])
    )))
    : emptyView("No tasks match this schedule.");
}

function workGalleryView(items = []) {
  return items.length
    ? el("div", {class: "list-gallery list-gallery--work"}, items.map((item) => {
      const card = workCard(item);
      card.classList.add(`work-card--${workTone(item)}`);
      return card;
    }))
    : emptyView("No tasks match this view.");
}

function shiftedDate(value, days) {
  const timestamp = dateMillis(value);
  if (timestamp === undefined) return "";
  return new Date(timestamp + Number(days) * dayMs).toISOString().slice(0, 10);
}

export function ganttDatePatch(item, deltaDays, edge = "move") {
  const startDate = formatDate(item.startDate || item.dueDate);
  const dueDate = formatDate(item.dueDate || item.startDate);
  if (!startDate || !dueDate || !Number.isFinite(Number(deltaDays))) return {};
  const delta = Math.trunc(Number(deltaDays));
  if (edge === "start") {
    const next = shiftedDate(startDate, delta);
    return {startDate: next > dueDate ? dueDate : next, schedulingMode: "manual"};
  }
  if (edge === "end") {
    const next = shiftedDate(dueDate, delta);
    return {dueDate: next < startDate ? startDate : next, schedulingMode: "manual"};
  }
  return {startDate: shiftedDate(startDate, delta), dueDate: shiftedDate(dueDate, delta), schedulingMode: "manual"};
}

function workTimelineView(items = []) {
  const scheduled = items
    .map((item) => {
      const start = dateMillis(item.startDate) ?? dateMillis(item.dueDate);
      const end = dateMillis(item.dueDate) ?? dateMillis(item.startDate);
      return start === undefined || end === undefined ? undefined : {item, start: Math.min(start, end), end: Math.max(start, end)};
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.end - b.end || priorityWeight(b.item.priority) - priorityWeight(a.item.priority));
  const unscheduled = items.filter((item) => dateMillis(item.startDate) === undefined && dateMillis(item.dueDate) === undefined);
  if (!scheduled.length) {
    return unscheduled.length
      ? el("section", {class: "timeline-view"}, [
        el("div", {class: "timeline-unscheduled"}, [
          el("div", {class: "section-heading"}, el("h3", {}, "Unscheduled tasks")),
          ...unscheduled.map((item) => workCard(item))
        ])
      ])
      : emptyView("No tasks match this timeline.");
  }
  const min = Math.min(...scheduled.map((entry) => entry.start));
  const max = Math.max(...scheduled.map((entry) => entry.end));
  const totalDays = Math.max(1, daysBetween(min, max) + 1);
  const rows = [
    el("div", {class: "timeline-scale"}, [
      el("span", {}, formatDate(new Date(min).toISOString())),
      el("span", {}, `${totalDays} days`),
      el("span", {}, formatDate(new Date(max).toISOString()))
    ]),
    ...scheduled.map(({item, start, end}) => {
      const offset = Math.max(0, Math.min(100, daysBetween(min, start) / totalDays * 100));
      const width = Math.max(4, Math.min(100 - offset, (daysBetween(start, end) + 1) / totalDays * 100));
      return el("a", {class: `timeline-row timeline-row--${workTone(item)}`, href: workItemHref(item)}, [
        el("div", {class: "timeline-row__meta"}, [
          el("strong", {}, item.title),
          el("span", {}, [item.projectName, item.assigneeName ?? item.assigneeId ?? "Unassigned", workStatusLabel(item.status)].filter(Boolean).join(" / "))
        ]),
        el("div", {class: "timeline-row__track"}, [
          el("span", {class: "timeline-bar", style: `left: ${offset}%; width: ${width}%`}, [
            el("span", {}, `${formatDate(new Date(start).toISOString())} - ${formatDate(new Date(end).toISOString())}`)
          ])
        ])
      ]);
    })
  ];
  if (unscheduled.length) {
    rows.push(el("div", {class: "timeline-unscheduled"}, [
      el("div", {class: "section-heading"}, el("h3", {}, "Unscheduled tasks")),
      ...unscheduled.map((item) => workCard(item))
    ]));
  }
  return el("section", {class: "timeline-view"}, rows);
}

function workGanttView(items = [], client, {onSaved} = {}) {
  if (!items.length) return emptyView("No tasks match this Gantt view.");
  const ordered = hierarchicalWorkItems(items);
  const scheduleRows = ordered.map(({item, level}) => {
    const start = dateMillis(item.startDate) ?? dateMillis(item.dueDate);
    const end = dateMillis(item.dueDate) ?? dateMillis(item.startDate);
    return {
      item,
      level,
      start: start === undefined || end === undefined ? undefined : Math.min(start, end),
      end: start === undefined || end === undefined ? undefined : Math.max(start, end),
      progress: workProgressPercent(item),
      milestone: isMilestoneItem(item),
      critical: isCriticalScheduleItem(item)
    };
  });
  const scheduled = scheduleRows.filter((row) => row.start !== undefined && row.end !== undefined);
  const min = scheduled.length ? Math.min(...scheduled.map((row) => row.start)) : dateMillis(todayIso());
  const max = scheduled.length ? Math.max(...scheduled.map((row) => row.end)) : min;
  const totalDays = Math.max(1, daysBetween(min, max) + 1);
  const dependencyCount = items.reduce((count, item) => count + (item.parentId ? 1 : 0) + (item.blockedBy?.length ?? 0) + (item.relatedIds?.length ?? 0), 0);
  const criticalCount = scheduleRows.filter((row) => row.critical && !isClosedWorkStatus(row.item.status)).length;
  const milestoneCount = scheduleRows.filter((row) => row.milestone).length;
  const axis = el("div", {class: "gantt-axis"}, [
    el("span", {}, formatDate(new Date(min).toISOString())),
    el("span", {}, `${totalDays} days`),
    el("span", {}, formatDate(new Date(max).toISOString()))
  ]);
  return el("section", {class: "gantt-view", "data-gantt-view": "true"}, [
    el("p", {class: "view-summary"}, `${scheduled.length} scheduled, ${milestoneCount} milestones, ${dependencyCount} dependencies, ${criticalCount} critical signals`),
    el("div", {class: "gantt-frame"}, [
      el("div", {class: "gantt-header"}, [
        el("span", {}, "Task"),
        axis
      ]),
      ...scheduleRows.map((row) => {
        const item = row.item;
        const offset = row.start === undefined ? 0 : Math.max(0, Math.min(100, daysBetween(min, row.start) / totalDays * 100));
        const width = row.start === undefined || row.end === undefined
          ? 0
          : Math.max(4, Math.min(100 - offset, (daysBetween(row.start, row.end) + 1) / totalDays * 100));
        const dependencyText = [
          item.parentId ? "WBS" : "",
          item.blockedBy?.length ? `${item.blockedBy.length} blocker${item.blockedBy.length === 1 ? "" : "s"}` : "",
          item.relatedIds?.length ? `${item.relatedIds.length} related` : ""
        ].filter(Boolean).join(" / ");
        const reschedule = client && item.projectId ? el("form", {class: "gantt-reschedule"}, [
          el("input", {name: "startDate", type: "date", value: formatDate(item.startDate), "aria-label": `${item.title} start date`}),
          el("input", {name: "dueDate", type: "date", value: formatDate(item.dueDate), "aria-label": `${item.title} due date`}),
          selectInput("schedulingMode", [{value: "manual", label: "Manual"}, {value: "automatic", label: "Automatic"}], item.schedulingMode ?? "manual"),
          el("button", {class: "button", type: "submit"}, "Reschedule")
        ]) : undefined;
        reschedule?.addEventListener("submit", async (event) => {
          event.preventDefault();
          const submit = reschedule.querySelector('button[type="submit"]');
          submit.disabled = true;
          const values = formValues(reschedule);
          try {
            await client.workItems.patch(item.projectId, item.id, {version: item.version, startDate: values.startDate, dueDate: values.dueDate, schedulingMode: values.schedulingMode});
            saveStatus(reschedule, "Schedule updated.", "ok");
            onSaved?.();
          } catch (error) {
            saveStatus(reschedule, error.message, "error");
          } finally {
            submit.disabled = false;
          }
        });
        const task = el("div", {class: "gantt-task", style: `--level: ${Math.min(6, row.level)}`}, [
          el("a", {class: "gantt-task__title", href: workItemHref(item)}, item.title),
          el("span", {}, workStatusLabel(item.status ?? configuredDefaultStatusId)),
          el("span", {}, item.assigneeName ?? item.assigneeId ?? "Unassigned"),
          el("span", {}, workDurationText(row.start, row.end)),
          dependencyText ? el("small", {}, dependencyText) : "",
          reschedule ?? ""
        ]);
        const track = el("div", {class: "gantt-track"});
        const commit = async (target, patch, targetItem = item) => {
          if (!client || !targetItem.projectId || !Object.keys(patch).length) return;
          target.setAttribute("aria-busy", "true");
          try {
            await client.workItems.patch(targetItem.projectId, targetItem.id, {version: targetItem.version, ...patch});
            onSaved?.();
          } catch (error) {
            saveStatus(reschedule ?? task, error.message, "error");
          } finally {
            target.removeAttribute("aria-busy");
          }
        };
        if (row.start === undefined || row.end === undefined) track.append(el("span", {class: "gantt-unscheduled"}, "Unscheduled"));
        else if (row.milestone) {
          const milestone = el("span", {class: "gantt-bar gantt-bar--milestone", style: `left: ${offset}%`, title: formatDate(new Date(row.start).toISOString()), draggable: client ? "true" : undefined, tabindex: client ? "0" : undefined, "aria-label": `${item.title} milestone on ${formatDate(new Date(row.start).toISOString())}; drag to reschedule`});
          milestone.addEventListener("dragstart", (event) => event.dataTransfer?.setData("text/plain", item.id));
          track.append(milestone);
        } else {
          const bar = el("span", {class: `gantt-bar${client ? " is-interactive" : ""}`, style: `left: ${offset}%; width: ${width}%`, draggable: client ? "true" : undefined, tabindex: client ? "0" : undefined, "aria-label": `${item.title}, ${formatDate(new Date(row.start).toISOString())} through ${formatDate(new Date(row.end).toISOString())}; drag to move`}, [
            el("button", {class: "gantt-bar__handle gantt-bar__handle--start", type: "button", title: "Drag or use arrow keys to change the start date", "aria-label": `Adjust ${item.title} start date`}),
            el("span", {class: "gantt-bar__fill", style: `width: ${row.progress}%`}),
            el("span", {class: "gantt-bar__label"}, `${formatDate(new Date(row.start).toISOString())} - ${formatDate(new Date(row.end).toISOString())}`),
            el("button", {class: "gantt-bar__handle gantt-bar__handle--end", type: "button", title: "Drag or use arrow keys to change the due date", "aria-label": `Adjust ${item.title} due date`})
          ]);
          bar.addEventListener("dragstart", (event) => {
            if (event.target.closest?.(".gantt-bar__handle")) return event.preventDefault();
            event.dataTransfer?.setData("text/plain", item.id);
          });
          const attachHandle = (handle, edge) => {
            handle.addEventListener("keydown", (event) => {
              if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
              event.preventDefault();
              commit(handle, ganttDatePatch(item, event.key === "ArrowLeft" ? -1 : 1, edge));
            });
            handle.addEventListener("pointerdown", (event) => {
              event.preventDefault();
              event.stopPropagation();
              const startX = event.clientX;
              const finish = (pointerEvent) => {
                window.removeEventListener("pointerup", finish);
                const pixelsPerDay = Math.max(1, track.getBoundingClientRect().width / totalDays);
                const delta = Math.round((pointerEvent.clientX - startX) / pixelsPerDay);
                if (delta) commit(handle, ganttDatePatch(item, delta, edge));
              };
              window.addEventListener("pointerup", finish, {once: true});
            });
          };
          attachHandle(bar.querySelector(".gantt-bar__handle--start"), "start");
          attachHandle(bar.querySelector(".gantt-bar__handle--end"), "end");
          track.append(bar);
        }
        if (client) {
          track.addEventListener("dragover", (event) => event.preventDefault());
          track.addEventListener("drop", (event) => {
            event.preventDefault();
            const source = items.find((candidate) => candidate.id === event.dataTransfer?.getData("text/plain"));
            const sourceStart = dateMillis(source?.startDate ?? source?.dueDate);
            const rectangle = track.getBoundingClientRect();
            if (!source || sourceStart === undefined || !rectangle.width) return;
            const ratio = Math.max(0, Math.min(1, (event.clientX - rectangle.left) / rectangle.width));
            const targetStart = min + Math.round(ratio * Math.max(0, totalDays - 1)) * dayMs;
            commit(track, ganttDatePatch(source, daysBetween(sourceStart, targetStart), "move"), source);
          });
        }
        return el("article", {
          class: `gantt-row gantt-row--${workTone(item)} ${row.critical && !isClosedWorkStatus(item.status) ? "is-critical" : ""}`
        }, [
          task,
          track
        ]);
      })
    ])
  ]);
}

function workloadPlanningView(items = []) {
  const groups = new Map();
  for (const item of items) {
    const assigneeId = item.assigneeId || "unassigned";
    const current = groups.get(assigneeId) ?? {
      assigneeId,
      name: item.assigneeName ?? item.assigneeId ?? "Unassigned",
      items: [],
      activeEffort: 0,
      blocked: 0
    };
    current.items.push(item);
    if (!isClosedWorkStatus(item.status)) current.activeEffort += Number(item.effortPoints ?? 0);
    if (item.status === "blocked" || item.blockedBy?.length) current.blocked += 1;
    groups.set(assigneeId, current);
  }
  const people = [...groups.values()].sort((a, b) => b.activeEffort - a.activeEffort || a.name.localeCompare(b.name));
  if (!people.length) return emptyView("No assigned tasks match this view.");
  return el("section", {class: "workload-planner"}, [
    el("div", {class: "workload-planner__grid"}, people.map((person) => {
      const active = person.items.filter((item) => !isClosedWorkStatus(item.status)).sort((a, b) => priorityWeight(b.priority) - priorityWeight(a.priority));
      return el("article", {class: "workload-person"}, [
        el("div", {class: "workload-person__heading"}, [
          el("h3", {}, person.name),
          person.blocked ? badge(`${person.blocked} blocked`, "danger") : badge("Clear", "good")
        ]),
        capacityMeter(person.activeEffort, 13),
        ...active.slice(0, 5).map((item) => el("div", {class: "workload-row"}, [
          el("a", {href: workItemHref(item)}, item.title),
          badge(workStatusLabel(item.status), statusTone(item.status))
        ])),
        active.length > 5 ? el("small", {}, `${active.length - 5} more active items`) : ""
      ]);
    }))
  ]);
}

function workDependencyView(items = []) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const relationships = [];
  const seen = new Set();
  const relationItem = (id) => byId.get(id) ?? {id, title: id, status: "", projectId: ""};
  const add = (fromId, label, toId, tone = "neutral") => {
    if (!fromId || !toId) return;
    const key = `${fromId}:${label}:${toId}`;
    if (seen.has(key)) return;
    seen.add(key);
    relationships.push({from: relationItem(fromId), label, to: relationItem(toId), tone});
  };
  for (const item of items) {
    if (item.parentId) add(item.parentId, "contains", item.id, "neutral");
    for (const blocker of item.blockedBy ?? []) add(blocker, "blocks", item.id, item.status === "blocked" ? "danger" : "watch");
    for (const related of item.relatedIds ?? []) {
      const pair = [item.id, related].sort().join(":");
      if (!seen.has(`related:${pair}`)) {
        seen.add(`related:${pair}`);
        relationships.push({from: item, label: "related", to: relationItem(related), tone: "neutral"});
      }
    }
  }
  if (!relationships.length) return emptyView("No dependency relationships match this view.");
  return el("section", {class: "dependency-map"}, [
    el("div", {class: "dependency-map__list"}, relationships.map((relation) => (
      el("article", {class: `dependency-row dependency-row--${relation.tone}`}, [
        el("a", {class: "dependency-node", href: workItemHref(relation.from)}, [
          el("strong", {}, relation.from.title),
          relation.from.status ? badge(workStatusLabel(relation.from.status), statusTone(relation.from.status)) : ""
        ]),
        el("span", {class: "dependency-link"}, relation.label),
        el("a", {class: "dependency-node", href: workItemHref(relation.to)}, [
          el("strong", {}, relation.to.title),
          relation.to.status ? badge(workStatusLabel(relation.to.status), statusTone(relation.to.status)) : ""
        ])
      ])
    )))
  ]);
}

export function workListWorkbench(items = [], client, {onSaved, view = "grid"} = {}) {
  let currentView = ["grid", "gallery", "board", "calendar", "timeline", "gantt"].includes(view) ? view : "grid";
  const open = items.filter((item) => !isClosedWorkStatus(item.status));
  const blocked = items.filter((item) => item.status === "blocked" || (item.blockedBy ?? []).length);
  const dueSignals = items.filter((item) => ["danger", "watch"].includes(dueTone(item.dueDate, item.status)));
  const unplanned = items.filter((item) => !item.periodName && !item.milestoneName && !item.intakeGroup && !item.customFields?.workflowStep && !item.customFields?.workstream);
  const tabs = el("div", {class: "list-view-tabs-host"});
  const content = el("div", {class: "list-workbench__content"});
  const searchInput = el("input", {type: "search", name: "search", placeholder: "Search assigned tasks", "aria-label": "Search assigned tasks"});
  const scopeInput = selectInput("scope", [
    {value: "open", label: "Open tasks"},
    {value: "all", label: "All tasks"},
    {value: "blocked", label: "Blocked"},
    {value: "due", label: "Due soon or overdue"},
    ...workStatusValues(items).filter((status) => status !== "blocked").map((status) => ({value: status, label: workStatusLabel(status)}))
  ], "open");
  const sortInput = selectInput("sort", [
    {value: "attention", label: "Needs attention"},
    {value: "due", label: "Due date"},
    {value: "updated", label: "Recently updated"}
  ], "attention");
  const resultCount = el("span", {class: "work-filter-bar__count", role: "status", "aria-live": "polite"});
  const filterBar = el("div", {class: "work-filter-bar", role: "search", "aria-label": "Filter assigned tasks"}, [
    searchInput,
    scopeInput,
    sortInput,
    resultCount
  ]);
  const views = [
    {key: "grid", label: "List"},
    {key: "gallery", label: "Cards"},
    {key: "board", label: "Board"},
    {key: "calendar", label: "Calendar"},
    {key: "timeline", label: "Timeline"},
    {key: "gantt", label: "Gantt"}
  ];
  const visibleItems = () => filterAssignedWorkItems(items, {
    search: searchInput.value,
    scope: scopeInput.value,
    sort: sortInput.value
  });
  const viewContent = (visible) => ({
    grid: visible.length ? workItemTable(visible) : emptyView("No tasks match these filters."),
    gallery: workGalleryView(visible),
    board: workItemKanban(visible, client, {onSaved}),
    calendar: workCalendarView(visible),
    timeline: workTimelineView(visible),
    gantt: workGanttView(visible, client, {onSaved})
  })[currentView];
  const render = () => {
    const visible = visibleItems();
    tabs.replaceChildren(listViewTabs(views, currentView, (nextView) => {
      currentView = nextView;
      render();
    }));
    resultCount.textContent = `${visible.length} of ${items.length}`;
    content.replaceChildren(viewContent(visible));
    globalThis.requestAnimationFrame?.(() => tabs.querySelector(".is-active")?.scrollIntoView({block: "nearest", inline: "nearest"}));
  };
  const root = el("section", {class: "list-workbench", id: "assigned-tasks"}, [
    el("div", {class: "section-heading"}, [
      el("div", {}, [
        el("h2", {}, "Assigned tasks"),
        el("p", {}, "Switch views without changing the underlying task records.")
      ]),
      tabs
    ]),
    filterBar,
    content,
    actionPanel("Task signals", listRules("Signals", [
      {label: "Open tasks", count: open.length, tone: open.length ? "info" : "good", meta: "Assigned to you"},
      {label: "Blocked or dependent", count: blocked.length, tone: blocked.length ? "danger" : "good", meta: "Dependency rule"},
      {label: "Due within 14 days or overdue", count: dueSignals.length, tone: dueSignals.length ? "watch" : "good", meta: "Due-date rule"},
      {label: "Missing period, milestone, and intake group", count: unplanned.length, tone: unplanned.length ? "watch" : "good", meta: "Planning rule"}
    ]), {meta: `${blocked.length + dueSignals.length + unplanned.length} signals`})
  ]);
  searchInput.addEventListener("input", render);
  scopeInput.addEventListener("change", render);
  sortInput.addEventListener("change", render);
  render();
  return root;
}

function capacityMeter(value, limit) {
  const normalized = Math.max(0, Math.min(100, Math.round((Number(value) / Math.max(1, Number(limit))) * 100)));
  return el("div", {class: "capacity-meter", "aria-label": `${value} of ${limit} effort points allocated`}, [
    el("span", {style: `width: ${normalized}%`}),
    el("strong", {}, `${value} / ${limit} pts`)
  ]);
}

export function planningDashboardView(summary) {
  const period = summary.currentPeriod ?? {};
  const pointsTotal = Number(period.pointsTotal ?? 0);
  const pointsDone = Number(period.pointsDone ?? 0);
  const completion = pointsTotal ? Math.round((pointsDone / pointsTotal) * 100) : 0;
  return el("section", {class: "planning-dashboard", "data-planning-dashboard": "true"}, [
    el("div", {class: "planning-dashboard__heading"}, [
      el("div", {}, [
        el("h2", {}, period.name ?? "Current period"),
        period.goal ? el("p", {}, period.goal) : el("p", {}, "No period goal set.")
      ]),
      badge(summary.wipOverLimit ? "In-progress limit exceeded" : "Flow healthy", summary.wipOverLimit ? "danger" : "good")
    ]),
    dataTable(["Signal", "Value"], [
      ["Period effort", `${pointsDone} / ${pointsTotal}`],
      ["Period completion", progressBar(completion)],
      ["In progress", `${summary.wipCount} / ${summary.wipLimit}`],
      ["Blocked", summary.blockedCount],
      ["Intake", summary.intakeCount ?? 0],
      ["Linked work", summary.relationshipCount ?? 0],
      ["Criteria", summary.acceptanceCriteriaCount ?? 0]
    ])
  ]);
}

export function periodBoard(items, client, {onSaved, summary} = {}) {
  const wipLimit = Number(summary?.wipLimit ?? 4);
  const statuses = workStatusValues(items);
  const moveStatus = el("p", {class: "form-status planning-status-board__status", role: "status", "aria-live": "polite"});
  const moveItem = async (item, nextStatus) => {
    moveStatus.className = "form-status planning-status-board__status";
    moveStatus.textContent = "";
    try {
      await client.workItems.patch(item.projectId, item.id, {status: nextStatus, version: item.version});
      moveStatus.className = "form-status planning-status-board__status ok";
      moveStatus.textContent = `Moved ${item.title ?? "task"} to ${workStatusLabel(nextStatus)}.`;
      onSaved?.();
    } catch (error) {
      moveStatus.className = "form-status planning-status-board__status error";
      moveStatus.textContent = error.message;
    }
  };
  const board = el("section", {class: "planning-status-board", "data-period-board": "true"}, statuses.map((status) => {
    const columnItems = items.filter((candidate) => candidate.status === status);
    const acceptsMoves = workStatusList.includes(status);
    const column = el("div", {class: `planning-status-board__column ${status === "in-progress" && columnItems.length > wipLimit ? "is-over-limit" : ""}${acceptsMoves ? "" : " is-retired"}`});
    column.append(el("div", {class: "planning-status-board__header"}, [
      el("h3", {}, workStatusLabel(status)),
      el("span", {}, status === "in-progress" ? `${columnItems.length}/${wipLimit}` : String(columnItems.length))
    ]));
    for (const item of columnItems) {
      const card = workCard(item, {
        draggable: true,
        moveTargets: statuses.filter((candidate) => candidate !== status && workStatusList.includes(candidate)),
        onMove: (nextStatus) => moveItem(item, nextStatus)
      });
      card.addEventListener("dragstart", (event) => event.dataTransfer?.setData("text/plain", item.id));
      column.append(card);
    }
    if (acceptsMoves) {
      column.addEventListener("dragover", (event) => event.preventDefault());
      column.addEventListener("drop", async (event) => {
        event.preventDefault();
        const id = event.dataTransfer?.getData("text/plain");
        const item = items.find((candidate) => candidate.id === id);
        if (!item || item.status === status) return;
        await moveItem(item, status);
      });
    }
    return column;
  }));
  return el("div", {class: "planning-status-board-shell"}, [board, moveStatus]);
}

export function intakePlanner(items) {
  const groups = [...intakeGroupList, "unbucketed"];
  return el("section", {class: "planning-board"}, [
    el("div", {class: "section-heading"}, el("h2", {}, "Intake groups")),
    el("div", {class: "planning-board__columns"}, groups.map((group) => {
      const groupItems = items.filter((item) => (item.intakeGroup ?? "unbucketed") === group);
      return el("div", {class: "planning-board__column"}, [
        el("div", {class: "planning-board__header"}, [
          el("h3", {}, intakeGroupLabel(group)),
          el("span", {}, String(groupItems.length))
        ]),
        ...groupItems.map((item) => workCard(item))
      ]);
    }))
  ]);
}

export function teamWorkloadBoard(items, summary) {
  const people = summary.byAssignee ?? [];
  return el("section", {class: "workload-board"}, [
    el("div", {class: "section-heading"}, el("h2", {}, "Team workload")),
    el("div", {class: "workload-board__grid"}, people.map((person) => {
      const assigned = items.filter((item) => (item.assigneeId || "unassigned") === person.assigneeId && !isClosedWorkStatus(item.status));
      return el("article", {class: "workload-person"}, [
        el("div", {class: "workload-person__heading"}, [
          el("h3", {}, person.name),
          person.blockedCount ? badge(`${person.blockedCount} blocked`, "danger") : badge("Clear", "good")
        ]),
        capacityMeter(person.activeEffortPoints ?? 0, 13),
        ...assigned.slice(0, 4).map((item) => el("div", {class: "workload-row"}, [
          el("a", {href: workItemHref(item)}, item.title),
          badge(workStatusLabel(item.status), statusTone(item.status))
        ]))
      ]);
    }))
  ]);
}

export function milestoneBoard(items, summary) {
  const milestones = summary.byMilestone?.length ? summary.byMilestone : [{name: "Unplanned", itemCount: 0, activeCount: 0, pointsTotal: 0, pointsDone: 0}];
  return el("section", {class: "milestone-board"}, [
    el("div", {class: "section-heading"}, el("h2", {}, "Milestone board")),
    el("div", {class: "milestone-board__columns"}, milestones.map((milestone) => {
      const milestoneItems = items.filter((item) => (item.milestoneName ?? "Unplanned") === milestone.name);
      const pct = milestone.pointsTotal ? Math.round((milestone.pointsDone / milestone.pointsTotal) * 100) : 0;
      return el("div", {class: "milestone-board__column"}, [
        el("div", {class: "milestone-board__header"}, [
          el("h3", {}, milestone.name),
          badge(`${milestone.pointsDone}/${milestone.pointsTotal} pts`, pct === 100 ? "good" : "neutral")
        ]),
        progressBar(pct),
        ...milestoneItems.map((item) => workCard(item))
      ]);
    }))
  ]);
}

export function periodPlanTable(summary) {
  return dataTable(["Time period", "Goal", "Items", "Done", "Effort"], (summary.byPeriod ?? []).map((period) => [
    period.name,
    period.goal || "",
    period.itemCount,
    period.completedCount,
    `${period.pointsDone} / ${period.pointsTotal}`
  ]));
}

export function planningFocusPanel(items = [], summary = {}, {selectedProjectId = ""} = {}) {
  const open = items.filter((item) => !isClosedWorkStatus(item.status));
  const blocked = items.filter((item) => item.status === "blocked" || (item.blockedBy ?? []).length);
  const dueSignals = items.filter((item) => ["danger", "watch"].includes(dueTone(item.dueDate, item.status)));
  const unassigned = open.filter((item) => !item.assigneeId);
  const currentPeriod = summary.currentPeriod ?? {};
  const focusItems = [...items]
    .filter((item) => !isClosedWorkStatus(item.status))
    .sort((a, b) => {
      const aBlocked = a.status === "blocked" || (a.blockedBy ?? []).length ? 1 : 0;
      const bBlocked = b.status === "blocked" || (b.blockedBy ?? []).length ? 1 : 0;
      return bBlocked - aBlocked
        || priorityWeight(b.priority) - priorityWeight(a.priority)
        || String(a.dueDate ?? "9999-12-31").localeCompare(String(b.dueDate ?? "9999-12-31"))
        || Number(a.rank ?? 0) - Number(b.rank ?? 0);
    })
    .slice(0, 4);
  return el("section", {class: "planning-focus"}, [
    el("div", {class: "section-heading"}, [
      el("h2", {}, "Start here"),
      miniLinks([
        {label: "Create task", href: "#new-task"},
        selectedProjectId ? {label: "Project", href: projectHref(selectedProjectId)} : {label: "Projects", href: "/app/projects"},
        {label: "My tasks", href: "/app/work"}
      ])
    ]),
    dataTable(["Signal", "Value"], [
      ["Open tasks", open.length],
      ["Blocked", blocked.length],
      ["Due signals", dueSignals.length],
      ["Unassigned", unassigned.length],
      ["Period effort", `${currentPeriod.pointsDone ?? 0} / ${currentPeriod.pointsTotal ?? 0}`]
    ]),
    listRules("Focus signals", [
      {label: "Blocked or dependent", count: blocked.length, tone: blocked.length ? "danger" : "good", meta: "Needs attention"},
      {label: "Due soon or overdue", count: dueSignals.length, tone: dueSignals.length ? "watch" : "good", meta: "Schedule signal"},
      {label: "Needs an owner", count: unassigned.length, tone: unassigned.length ? "watch" : "good", meta: "Assignment signal"}
    ]),
    focusItems.length ? el("div", {class: "focus-work"}, focusItems.map((item) => {
      const card = workCard(item);
      card.classList.add(`work-card--${workTone(item)}`);
      return card;
    })) : emptyView("No open work needs attention.")
  ]);
}

function compactUnique(values = []) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function planningFieldValue(item, fieldName) {
  if (fieldName === "status") return item.status ?? configuredDefaultStatusId;
  if (fieldName === "assignee") return item.assigneeId || "Unassigned";
  if (fieldName === "team") return item.teamId || "No team";
  if (fieldName === "version") return item.versionName || "No version";
  if (fieldName === "subproject") return item.projectId || "No project";
  if (fieldName === "period") return item.periodName || "Unscheduled";
  if (fieldName === "milestone") return item.milestoneName || "Unplanned";
  if (fieldName === "workflowStep") return item.customFields?.workflowStep || "Unassigned";
  if (fieldName === "workstream") return item.customFields?.workstream || "Unassigned";
  if (fieldName === "priority") return item.priority ?? "medium";
  if (fieldName === "type") return item.type ?? configuredDefaultTypeId;
  return "All work";
}

function planningFieldLabel(fieldName, value, items = [], memberships = [], capabilities = {}) {
  if (fieldName === "status") return workStatusLabel(value);
  if (fieldName === "type") return workTypeLabel(value);
  if (fieldName === "priority") return titleCase(value);
  if (fieldName === "assignee") return value === "Unassigned" ? value : memberName(memberships, value);
  if (fieldName === "team") return value === "No team" ? value : teamName(capabilities, value);
  if (fieldName === "subproject") return items.find((item) => item.projectId === value)?.projectName ?? value;
  return value;
}

function planningColumnValues(items, fieldName, summary) {
  if (fieldName === "status") return workStatusValues(items);
  if (fieldName === "priority") return priorityList;
  if (fieldName === "type") return workTypeValues(items);
  if (fieldName === "subproject") return compactUnique(items.map((item) => item.projectId));
  const values = compactUnique(items.map((item) => planningFieldValue(item, fieldName)));
  if (fieldName === "period") {
    const currentPeriod = summary?.currentPeriod;
    const current = currentPeriod?.name && currentPeriod.name !== "Unscheduled" ? [currentPeriod.name] : [];
    const summarized = compactUnique((summary?.byPeriod ?? []).map((period) => period.name)).filter((name) => name !== "Unscheduled");
    return [...new Set([...current, ...summarized, ...values.filter((value) => value !== "Unscheduled"), "Unscheduled"])];
  }
  if (fieldName === "milestone") {
    return [...new Set([...values.filter((value) => value !== "Unplanned").sort(), "Unplanned"])];
  }
  if (fieldName === "workflowStep") {
    return [...new Set([...values.filter((value) => value !== "Unassigned").sort(), "Unassigned"])];
  }
  if (fieldName === "workstream") {
    return [...new Set([...values.filter((value) => value !== "Unassigned").sort(), "Unassigned"])];
  }
  return values.length ? values : ["All work"];
}

function filterPlanningWorkbenchItems(items, state, summary) {
  const search = String(state.search ?? "").trim().toLowerCase();
  const currentPeriod = summary?.currentPeriod ?? {};
  return items
    .filter((item) => {
      if (state.scope === "open" && isClosedWorkStatus(item.status)) return false;
      if (state.scope === "blocked" && item.status !== "blocked" && !(item.blockedBy ?? []).length) return false;
      if (state.scope === "current-period") {
        if (currentPeriod.name && currentPeriod.name !== "Unscheduled") return item.periodName === currentPeriod.name || item.periodId === currentPeriod.id;
        return !item.periodName;
      }
      if (state.scope === "unplanned" && (item.periodName || item.milestoneName || item.customFields?.workflowStep || item.customFields?.workstream)) return false;
      return true;
    })
    .filter((item) => {
      if (!search) return true;
      const custom = Object.entries(item.customFields ?? {}).map(([key, value]) => `${key} ${value}`).join(" ");
      return `${item.title ?? ""} ${item.description ?? ""} ${item.projectName ?? ""} ${item.status ?? ""} ${item.periodName ?? ""} ${item.milestoneName ?? ""} ${item.priority ?? ""} ${(item.tags ?? []).join(" ")} ${custom}`.toLowerCase().includes(search);
    })
    .sort((a, b) => {
      if (state.sortBy === "due") return String(a.dueDate ?? "9999-12-31").localeCompare(String(b.dueDate ?? "9999-12-31"));
      if (state.sortBy === "priority") return priorityWeight(b.priority) - priorityWeight(a.priority) || Number(a.rank ?? 0) - Number(b.rank ?? 0);
      if (state.sortBy === "points") return Number(b.effortPoints ?? 0) - Number(a.effortPoints ?? 0);
      if (state.sortBy === "updated") return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
      return Number(a.rank ?? 0) - Number(b.rank ?? 0);
    });
}

function planningPatchForColumn(item, fieldName, value) {
  if (fieldName === "status") return {status: value};
  if (fieldName === "assignee") return {assigneeId: value === "Unassigned" ? "" : value};
  if (fieldName === "team") return {teamId: value === "No team" ? "" : value};
  if (fieldName === "version") return {versionName: value === "No version" ? "" : value};
  if (fieldName === "period") return {periodName: value === "Unscheduled" ? "" : value};
  if (fieldName === "milestone") return {milestoneName: value === "Unplanned" ? "" : value};
  if (fieldName === "workflowStep") {
    const customFields = {...(item.customFields ?? {})};
    if (value === "Unassigned") delete customFields.workflowStep;
    else customFields.workflowStep = value;
    return {customFields};
  }
  if (fieldName === "workstream") {
    const customFields = {...(item.customFields ?? {})};
    if (value === "Unassigned") delete customFields.workstream;
    else customFields.workstream = value;
    return {customFields};
  }
  if (fieldName === "priority") return {priority: value};
  if (fieldName === "type") return {type: value};
  return {};
}

function planningSavedViewOptions(savedViews = [], selectedProjectId = "") {
  const scopes = new Set(["planning"]);
  if (selectedProjectId) scopes.add(`planning:${selectedProjectId}`);
  return savedViews.filter((view) => scopes.has(view.scope)).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

const workflowMoverRoles = ["workspace-admin", "portfolio-manager", "project-manager", "member"];

function boardStatusId(label, statuses = []) {
  const base = String(label ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 48)
    .replace(/-+$/g, "") || "column";
  const ids = new Set(statuses.map((status) => status.id));
  if (!ids.has(base)) return base;
  let suffix = 2;
  while (ids.has(`${base.slice(0, 45)}-${suffix}`)) suffix += 1;
  return `${base.slice(0, 45)}-${suffix}`;
}

function transitionRolesFor(configuration, fromStatusId, toStatusId) {
  const transitions = configuration.transitions ?? [];
  const nearby = transitions.filter((transition) => (
    transition.fromStatusId === fromStatusId || transition.toStatusId === toStatusId
  ));
  const roles = compactUnique(nearby.flatMap((transition) => transition.roles ?? []))
    .filter((role) => workflowMoverRoles.includes(role));
  return roles.length ? roles : ["workspace-admin"];
}

/**
 * Create the complete Work Configuration v1 payload represented by the simple
 * board-column editor. New or restored columns receive usable transitions;
 * retiring a column removes inbound transitions while preserving a route out.
 */
export function prepareBoardStatusConfiguration(configuration = {}, statuses = [], {defaultStatusId = configuration.defaultStatusId, itemCounts = {}} = {}) {
  const currentStatuses = Array.isArray(configuration.statuses) ? configuration.statuses : [];
  const currentById = new Map(currentStatuses.map((status) => [status.id, status]));
  const normalized = statuses.map((status) => ({
    id: String(status.id ?? "").trim(),
    label: String(status.label ?? "").trim(),
    active: Boolean(status.active),
    closed: Boolean(status.closed)
  }));
  if (!normalized.length) throw new Error("Keep at least one board column.");
  if (normalized.length > 30) throw new Error("A board can have at most 30 columns.");
  if (new Set(normalized.map((status) => status.id)).size !== normalized.length) throw new Error("Board column IDs must be unique.");
  for (const status of normalized) {
    if (!status.label) throw new Error("Every board column needs a name.");
    if (!status.active && Number(itemCounts[status.id] ?? 0) > 0) {
      throw new Error(`Move every task out of ${status.label} before retiring that column.`);
    }
  }
  const activeIds = new Set(normalized.filter((status) => status.active).map((status) => status.id));
  if (!activeIds.size) throw new Error("Keep at least one active board column.");
  if (!activeIds.has(defaultStatusId)) throw new Error("The initial column must stay active.");
  const knownIds = new Set(normalized.map((status) => status.id));
  const transitionKeys = new Set();
  const transitions = (configuration.transitions ?? [])
    .filter((transition) => knownIds.has(transition.fromStatusId) && activeIds.has(transition.toStatusId))
    .filter((transition) => {
      const key = `${transition.fromStatusId}:${transition.toStatusId}`;
      if (transitionKeys.has(key)) return false;
      transitionKeys.add(key);
      return true;
    })
    .map((transition) => ({...transition, roles: [...(transition.roles ?? [])]}));
  const newlyActiveIds = new Set(normalized
    .filter((status) => status.active && !currentById.get(status.id)?.active)
    .map((status) => status.id));
  for (const fromStatus of normalized) {
    for (const toStatus of normalized.filter((status) => status.active)) {
      if (fromStatus.id === toStatus.id) continue;
      if (!newlyActiveIds.has(fromStatus.id) && !newlyActiveIds.has(toStatus.id)) continue;
      const key = `${fromStatus.id}:${toStatus.id}`;
      if (transitionKeys.has(key)) continue;
      transitions.push({
        fromStatusId: fromStatus.id,
        toStatusId: toStatus.id,
        roles: transitionRolesFor(configuration, fromStatus.id, toStatus.id)
      });
      transitionKeys.add(key);
    }
  }
  if (transitions.length > 300) throw new Error("This change would create too many workflow transitions. Retire unused columns first.");
  return {
    schemaVersion: 1,
    version: configuration.version,
    defaultTypeId: configuration.defaultTypeId,
    defaultStatusId,
    types: (configuration.types ?? []).map((type) => ({...type})),
    statuses: normalized,
    transitions
  };
}

export function boardColumnEffort(items = [], fieldName = "status") {
  const total = items.reduce((sum, item) => sum + Number(item.effortPoints ?? 0), 0);
  const done = items.filter((item) => isClosedWorkStatus(item.status)).reduce((sum, item) => sum + Number(item.effortPoints ?? 0), 0);
  if (!total) return {label: "No effort estimated", description: "Effort points are optional relative-size estimates, not hours."};
  if (fieldName === "status") {
    return {label: `${total} effort ${total === 1 ? "point" : "points"}`, description: `${total} relative-size ${total === 1 ? "estimate" : "estimates"} in this column; effort points are not hours.`};
  }
  return {label: `${done} of ${total} points complete`, description: `${done} of ${total} relative effort points are in a completed status; effort points are not hours.`};
}

function boardStatusColumnEditor(client, configuration, items = [], {onSaved} = {}) {
  let statuses = (configuration.statuses ?? []).map((status) => ({...status}));
  const itemCounts = Object.fromEntries(statuses.map((status) => [
    status.id,
    items.filter((item) => item.status === status.id).length
  ]));
  const list = el("div", {class: "board-column-editor__list"});
  const feedback = el("p", {class: "form-status board-column-editor__status", role: "status", "aria-live": "polite"});
  const save = el("button", {class: "button button--primary", type: "button"}, "Save columns");
  const addName = textInput("columnName", "Column name");

  const render = () => {
    list.replaceChildren(...statuses.map((status, index) => {
      const count = Number(itemCounts[status.id] ?? 0);
      const name = textInput("statusLabel", "Column name", status.label);
      name.setAttribute("aria-label", `Name for ${status.label} column`);
      name.addEventListener("input", () => { status.label = name.value; });
      const closed = el("input", {type: "checkbox", checked: status.closed ? "true" : undefined});
      closed.checked = status.closed;
      closed.addEventListener("change", () => { status.closed = closed.checked; });
      const retire = el("button", {
        class: "button",
        type: "button",
        disabled: status.active && (count > 0 || status.id === configuration.defaultStatusId) ? "true" : undefined,
        title: status.active && count > 0 ? `Move ${count} ${count === 1 ? "task" : "tasks"} first` : undefined
      }, status.active ? "Retire" : "Restore");
      retire.addEventListener("click", () => {
        status.active = !status.active;
        render();
      });
      const move = (offset) => {
        const nextIndex = index + offset;
        if (nextIndex < 0 || nextIndex >= statuses.length) return;
        [statuses[index], statuses[nextIndex]] = [statuses[nextIndex], statuses[index]];
        render();
      };
      return el("div", {class: `board-column-editor__row${status.active ? "" : " is-retired"}`}, [
        el("div", {class: "board-column-editor__identity"}, [
          name,
          el("small", {}, `${status.id} · ${count} ${count === 1 ? "task" : "tasks"}${status.active ? "" : " · retired"}`)
        ]),
        el("label", {class: "board-column-editor__closed"}, [closed, el("span", {}, "Completed column")]),
        el("div", {class: "board-column-editor__actions"}, [
          el("button", {class: "button", type: "button", disabled: index === 0 ? "true" : undefined, "aria-label": `Move ${status.label} column left`, onclick: () => move(-1)}, "Move left"),
          el("button", {class: "button", type: "button", disabled: index === statuses.length - 1 ? "true" : undefined, "aria-label": `Move ${status.label} column right`, onclick: () => move(1)}, "Move right"),
          retire
        ])
      ]);
    }));
  };
  const addForm = el("form", {class: "board-column-editor__add"}, [
    field("Add a column", addName),
    el("button", {class: "button", type: "submit"}, "Add column")
  ]);
  addForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const label = addName.value.trim();
    if (!label) {
      saveStatus(addForm, "Enter a column name.", "error");
      return;
    }
    if (statuses.length >= 30) {
      saveStatus(addForm, "A board can have at most 30 columns.", "error");
      return;
    }
    statuses.push({id: boardStatusId(label, statuses), label, active: true, closed: false});
    addName.value = "";
    addForm.querySelector(".form-status")?.remove();
    render();
  });
  save.addEventListener("click", async () => {
    feedback.className = "form-status board-column-editor__status";
    feedback.textContent = "";
    save.disabled = true;
    try {
      const payload = prepareBoardStatusConfiguration(configuration, statuses, {itemCounts});
      const saved = await client.workConfiguration.patch(payload, {idempotencyKey: crypto.randomUUID()});
      configureWorkTaxonomy(saved);
      feedback.className = "form-status board-column-editor__status ok";
      feedback.textContent = "Board columns saved.";
      onSaved?.();
    } catch (error) {
      feedback.className = "form-status board-column-editor__status error";
      feedback.textContent = error.message;
    } finally {
      save.disabled = false;
    }
  });
  render();
  return el("details", {class: "advanced-panel board-column-editor", id: "board-columns"}, [
    el("summary", {}, [el("span", {}, "Edit board columns"), el("small", {}, "Add, rename, reorder, or retire statuses")]),
    el("div", {class: "board-column-editor__body"}, [
      el("p", {}, "A completed column closes its cards without hiding them from the default board. Move visible cards out before retiring a column; any remaining cards stay in an outbound-only retired column until moved."),
      list,
      addForm,
      el("div", {class: "board-column-editor__save"}, [save, feedback])
    ])
  ]);
}

function setSelectValue(select, value) {
  if (value === undefined || value === null) return;
  const text = String(value);
  if ([...select.options].some((option) => option.value === text)) select.value = text;
}

export const planningWorkbenchDefaultScope = "all";

export function planningWorkbenchView(items = [], client, {onSaved, summary, savedViews = [], selectedProjectId = "", memberships = [], workConfiguration, capabilities = {}, canManageColumns = false} = {}) {
  const root = el("section", {class: "planning-workbench", id: "task-views", "data-planning-workbench": "true"});
  const savedViewOptions = planningSavedViewOptions(savedViews, selectedProjectId);
  const quickViews = [
    {key: "board", label: "Board"},
    {key: "table", label: "List"}
  ];
  const quickTabs = el("div", {class: "list-view-tabs-host"});
  const layout = selectInput("layout", [
    {value: "board", label: "Board"},
    {value: "table", label: "List"},
    {value: "timeline", label: "Timeline"},
    {value: "calendar", label: "Calendar"},
    {value: "gantt", label: "Gantt"},
    {value: "workload", label: "Workload"},
    {value: "dependencies", label: "Dependencies"},
    {value: "gallery", label: "Gallery"}
  ], "board");
  const boardBy = selectInput("boardBy", [
    {value: "status", label: "Status"},
    {value: "assignee", label: "Assignee"},
    {value: "team", label: "Team"},
    {value: "version", label: "Version"},
    {value: "subproject", label: "Subproject"},
    {value: "period", label: "Time period"},
    {value: "milestone", label: "Milestone"},
    {value: "workflowStep", label: "Workflow step"},
    {value: "workstream", label: "Workstream"},
    {value: "priority", label: "Priority"},
    {value: "type", label: "Type"}
  ], "status");
  const scope = selectInput("scope", [
    {value: "open", label: "Open tasks"},
    {value: "all", label: "All tasks"},
    {value: "current-period", label: "Current period"},
    {value: "blocked", label: "Blocked"},
    {value: "unplanned", label: "Unplanned"}
  ], planningWorkbenchDefaultScope);
  const sortBy = selectInput("sortBy", [
    {value: "rank", label: "Rank"},
    {value: "priority", label: "Priority"},
    {value: "points", label: "Effort points"},
    {value: "due", label: "Due date"},
    {value: "updated", label: "Last updated"}
  ], "rank");
  const search = el("input", {type: "search", name: "search", placeholder: "Search tasks"});
  const status = el("p", {
    class: "form-status planning-workbench__status",
    role: "status",
    "aria-live": "polite"
  });
  const savedViewSelect = selectInput("savedView", [
    {value: "", label: "Choose saved view"},
    ...savedViewOptions.map((view) => ({value: view.id, label: view.name}))
  ]);
  const simpleControls = el("div", {class: "planning-simple-controls"}, [
    quickTabs,
    field("Search", search)
  ]);
  const saveForm = el("form", {class: "inline-form planning-save"}, [
    field("View name", textInput("name", "Open tasks by phase")),
    el("button", {class: "button", type: "submit"}, "Save view")
  ]);
  const advancedControls = el("details", {class: "advanced-panel", id: "view-options"}, [
    el("summary", {}, [
      el("span", {}, "View options"),
      el("small", {}, "Saved views, grouping, filters, and advanced layouts")
    ]),
    el("div", {class: "planning-controls planning-workbench__controls"}, [
      field("Saved view", savedViewSelect),
      field("View", layout),
      field("Board by", boardBy),
      field("Items", scope),
      field("Sort", sortBy)
    ]),
    saveForm
  ]);
  const content = el("div", {class: "planning-workbench__content"});
  const columnTools = el("div", {class: "planning-workbench__column-tools"});
  if (canManageColumns && workConfiguration?.statuses?.length) {
    columnTools.append(boardStatusColumnEditor(client, workConfiguration, items, {onSaved}));
  }
  const selectedIds = new Set();
  let render;
  const bulkEditor = workItemBulkEditor(client, items, {
    selectedIds,
    memberships,
    capabilities,
    onSaved,
    onRender: () => render?.()
  });
  const currentState = () => ({
    layout: layout.value,
    boardBy: boardBy.value,
    scope: scope.value,
    sortBy: sortBy.value,
    search: search.value
  });
  const applyState = (filters = {}) => {
    setSelectValue(layout, filters.layout);
    setSelectValue(boardBy, filters.boardBy);
    setSelectValue(scope, filters.scope);
    setSelectValue(sortBy, filters.sortBy);
    if (filters.search !== undefined) search.value = String(filters.search ?? "");
    render();
  };
  render = () => {
    const state = currentState();
    const visible = filterPlanningWorkbenchItems(items, state, summary);
    const scheduleFallback = ["timeline", "calendar", "gantt"].includes(state.layout)
      && state.scope === "open"
      && !String(state.search ?? "").trim()
      && !visible.length
      && items.length;
    const viewItems = scheduleFallback ? filterPlanningWorkbenchItems(items, {...state, scope: "all"}, summary) : visible;
    const bulkTableVisible = state.layout === "table";
    for (const id of selectedIds) {
      if (!bulkTableVisible || !viewItems.some((item) => item.id === id)) selectedIds.delete(id);
    }
    bulkEditor.sync();
    const blocked = viewItems.filter((item) => item.status === "blocked" || (item.blockedBy ?? []).length).length;
    const points = viewItems.reduce((sum, item) => sum + Number(item.effortPoints ?? 0), 0);
    const milestones = new Set(viewItems.map((item) => item.milestoneName).filter(Boolean)).size;
    const dependencies = viewItems.reduce((count, item) => count + (item.parentId ? 1 : 0) + (item.blockedBy?.length ?? 0) + (item.relatedIds?.length ?? 0), 0);
    const columns = planningColumnValues(visible.length ? visible : items, state.boardBy, summary);
    quickTabs.replaceChildren(listViewTabs(quickViews, state.layout, (nextView) => {
      layout.value = nextView;
      render();
    }));
    columnTools.hidden = state.layout !== "board" || state.boardBy !== "status";
    const moveItem = async (item, value) => {
      status.className = "form-status planning-workbench__status";
      status.textContent = "";
      try {
        if (state.boardBy === "subproject") await client.workItems.move(item.projectId, item.id, {targetProjectId: value, version: item.version});
        else await client.workItems.patch(item.projectId, item.id, {...planningPatchForColumn(item, state.boardBy, value), version: item.version});
        status.className = "form-status planning-workbench__status ok";
        status.textContent = `Moved ${item.title ?? "task"} to ${planningFieldLabel(state.boardBy, value, items, memberships, capabilities)}.`;
        onSaved?.();
      } catch (error) {
        status.className = "form-status planning-workbench__status error";
        status.textContent = error.message;
      }
    };
    const boardColumns = el("div", {class: "planning-workbench__board", "data-board-field": state.boardBy}, columns.map((value) => {
        const columnItems = visible.filter((item) => planningFieldValue(item, state.boardBy) === value);
        const effort = boardColumnEffort(columnItems, state.boardBy);
        const acceptsMoves = state.boardBy !== "status" || workStatusList.includes(value);
        const isOverLimit = state.boardBy === "status" && value === "in-progress" && columnItems.length > Number(summary?.wipLimit ?? 4);
        const column = el("section", {class: `planning-workbench__column ${isOverLimit ? "is-over-limit" : ""}${acceptsMoves ? "" : " is-retired"}`}, [
          el("div", {class: "planning-workbench__header"}, [
            el("h3", {}, planningFieldLabel(state.boardBy, value, items, memberships, capabilities)),
            el("span", {}, `${columnItems.length} ${columnItems.length === 1 ? "item" : "items"}`)
          ]),
          el("div", {class: "planning-workbench__meta"}, [
            el("span", {title: effort.description, "aria-label": effort.description}, effort.label),
            state.boardBy === "status" && isClosedWorkStatus(value) ? el("span", {}, "Completed") : "",
            !acceptsMoves ? el("span", {}, "Retired · move cards out") : "",
            state.boardBy === "status" && value === "in-progress" ? el("span", {}, `Limit ${columnItems.length}/${summary?.wipLimit ?? 4}`) : ""
          ])
        ]);
        for (const item of columnItems) {
          const card = workCard(item, {
            draggable: true,
            compact: true,
            moveTargets: columns
              .filter((candidate) => candidate !== value && (state.boardBy !== "status" || workStatusList.includes(candidate)))
              .map((candidate) => ({value: candidate, label: planningFieldLabel(state.boardBy, candidate, items, memberships, capabilities)})),
            onMove: (nextValue) => moveItem(item, nextValue)
          });
          card.addEventListener("dragstart", (event) => event.dataTransfer?.setData("text/plain", item.id));
          column.append(card);
        }
        if (acceptsMoves) {
          column.addEventListener("dragover", (event) => event.preventDefault());
          column.addEventListener("drop", async (event) => {
            event.preventDefault();
            const id = event.dataTransfer?.getData("text/plain");
            const item = items.find((candidate) => candidate.id === id);
            if (!item || planningFieldValue(item, state.boardBy) === value) return;
            await moveItem(item, value);
          });
        }
        return column;
      }));
    const board = el("section", {class: "planning-workbench__board-shell"}, [
      el("div", {class: "planning-workbench__board-guide"}, [
        el("p", {}, state.boardBy === "status"
          ? state.scope === "open"
            ? "This Open tasks view hides completed cards. Choose All tasks in View options to keep them visible."
            : "Showing all tasks, including completed work."
          : `Grouped by ${{assignee: "assignee", team: "team", version: "version", subproject: "subproject", period: "time period", milestone: "milestone", workflowStep: "workflow step", workstream: "workstream", priority: "priority", type: "task type"}[state.boardBy] ?? state.boardBy}.`),
        el("details", {class: "planning-workbench__effort-help"}, [
          el("summary", {}, "About effort points"),
          el("p", {}, state.boardBy === "status"
            ? "Points are optional relative-size estimates, not hours. Each column total shows the estimated effort it contains."
            : "Points are optional relative-size estimates, not hours. Group totals show completed effort compared with total estimated effort.")
        ])
      ]),
      boardColumns
    ]);
    const view = state.layout === "board"
      ? visible.length || columns.length ? board : emptyActionView("No tasks yet", "Create a task, then use this board to move it through your workflow.", {label: "Create task", href: "#new-task"})
      : viewItems.length
        ? state.layout === "table"
          ? el("section", {class: "bulk-work-list"}, [
              bulkEditor.node,
              workItemTable(viewItems, {
                selectedIds,
                onSelectionChange: (selection) => bulkEditor.sync(selection),
                capabilities
              })
            ])
          : state.layout === "timeline"
            ? workTimelineView(viewItems)
            : state.layout === "calendar"
              ? workCalendarView(viewItems)
              : state.layout === "gantt"
                ? workGanttView(viewItems, client, {onSaved})
                : state.layout === "workload"
                  ? workloadPlanningView(viewItems)
                  : state.layout === "dependencies"
                    ? workDependencyView(viewItems)
                    : workGalleryView(viewItems)
        : emptyActionView("No tasks match this view", "Adjust the search or view options, or create the next task.", {label: "Create task", href: "#new-task"});
    content.replaceChildren(
      view,
      status,
      actionPanel("View details", dataTable(["Signal", "Value"], [
        ["Tasks", viewItems.length],
        ["Effort points", points],
        ["Blocked", blocked],
        ["Milestones", milestones],
        ["Dependencies", dependencies]
      ]), {meta: `${viewItems.length} tasks`})
    );
  };
  for (const control of [layout, boardBy, scope, sortBy, search]) {
    control.addEventListener("input", render);
    control.addEventListener("change", render);
  }
  savedViewSelect.addEventListener("change", () => {
    const selected = savedViewOptions.find((view) => view.id === savedViewSelect.value);
    if (!selected) return;
    applyState(selected.filters ?? {});
    status.className = "form-status planning-workbench__status ok";
    status.textContent = `Loaded ${selected.name}.`;
  });
  saveForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(saveForm);
    try {
      const saved = await client.savedViews.create({
        name: data.get("name"),
        scope: selectedProjectId ? `planning:${selectedProjectId}` : "planning",
        filters: currentState()
      }, {idempotencyKey: crypto.randomUUID()});
      savedViewOptions.push(saved);
      savedViewOptions.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      savedViewSelect.append(el("option", {value: saved.id}, saved.name));
      savedViewSelect.value = saved.id;
      saveStatus(saveForm, "View saved.", "ok");
    } catch (error) {
      saveStatus(saveForm, error.message, "error");
    }
  });
  root.append(
    el("div", {class: "section-heading"}, [
      el("div", {}, [
        el("h2", {}, "Task views"),
        el("p", {}, "Start with the board or list. Timeline, calendar, Gantt, and analysis views remain under View options.")
      ]),
      miniLinks([
        {label: "Create task", href: "#new-task"},
        selectedProjectId ? {label: "Project detail", href: projectHref(selectedProjectId)} : {label: "Projects", href: "/app/projects"},
        {label: "My tasks", href: "/app/work"}
      ])
    ]),
    simpleControls,
    advancedControls,
    columnTools,
    content
  );
  render();
  return root;
}

export function periodDefinitionForm(client, projects, {onSaved, selectedProjectId = ""} = {}) {
  const projectOptions = projects.map((project) => ({value: project.id, label: project.name}));
  const form = el("form", {class: "editor-form editor-form--wide"}, [
    field("Project", selectInput("projectId", projectOptions, selectedProjectId)),
    field("Period name", textInput("periodName", "Launch window")),
    field("Goal", textInput("periodGoal", "Complete the next validated delivery slice.")),
    field("Start", el("input", {name: "startDate", type: "date"})),
    field("End", el("input", {name: "dueDate", type: "date"})),
    field("Capacity points", el("input", {name: "capacityPoints", type: "number", min: "0", max: "500", value: "13"})),
    field("Milestone", textInput("milestoneName", "Pilot beta")),
    field("Notes", textareaInput("description", "Scope, risks, and acceptance signals.")),
    el("button", {class: "button button--primary", type: "submit"}, "Create period")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formValues(form);
    const projectId = data.projectId;
    const periodName = String(data.periodName ?? "").trim();
    const customFields = {
      planningType: "period",
      capacityPoints: data.capacityPoints
    };
    if (data.startDate) customFields.periodStart = data.startDate;
    if (data.dueDate) customFields.periodEnd = data.dueDate;
    try {
      await client.workItems.create(projectId, {
        title: `Period: ${periodName}`,
        description: data.description,
        type: "milestone",
        status: "ready",
        priority: "medium",
        startDate: data.startDate,
        dueDate: data.dueDate,
        periodName,
        periodGoal: data.periodGoal,
        milestoneName: data.milestoneName,
        customFields,
        tags: ["period"]
      }, {idempotencyKey: crypto.randomUUID()});
      form.reset();
      saveStatus(form, "Period created.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function milestoneDefinitionForm(client, projects, {onSaved, selectedProjectId = ""} = {}) {
  const projectOptions = projects.map((project) => ({value: project.id, label: project.name}));
  const form = el("form", {class: "editor-form editor-form--wide"}, [
    field("Project", selectInput("projectId", projectOptions, selectedProjectId)),
    field("Milestone", textInput("name", "Pilot beta")),
    field("Priority", selectInput("priority", priorityList, "high")),
    field("Target", el("input", {name: "dueDate", type: "date"})),
    field("Description", textareaInput("description", "Target outcome and completion criteria.")),
    field("Acceptance criteria", textareaInput("acceptanceCriteria", "What must be true for this milestone to be complete?")),
    el("button", {class: "button button--primary", type: "submit"}, "Create milestone")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formValues(form);
    const projectId = data.projectId;
    const name = String(data.name ?? "").trim();
    try {
      await client.workItems.create(projectId, {
        title: name,
        description: data.description,
        type: "milestone",
        status: "ready",
        priority: data.priority,
        dueDate: data.dueDate,
        milestoneName: name,
        acceptanceCriteria: data.acceptanceCriteria,
        customFields: {planningType: "milestone"},
        tags: ["milestone"]
      }, {idempotencyKey: crypto.randomUUID()});
      form.reset();
      saveStatus(form, "Milestone created.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function workstreamDefinitionForm(client, projects, {onSaved, selectedProjectId = "", memberships = []} = {}) {
  const projectOptions = projects.map((project) => ({value: project.id, label: project.name}));
  const form = el("form", {class: "editor-form editor-form--wide"}, [
    field("Project", selectInput("projectId", projectOptions, selectedProjectId)),
    field("Workstream", textInput("name", "Implementation")),
    field("Owner", selectInput("assigneeId", memberOptions(memberships))),
    field("Milestone", textInput("milestoneName", "Pilot beta")),
    field("Target", el("input", {name: "dueDate", type: "date"})),
    field("Goal", textareaInput("description", "Team focus, boundaries, and next decisions.")),
    el("button", {class: "button button--primary", type: "submit"}, "Create workstream")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formValues(form);
    const projectId = data.projectId;
    const name = String(data.name ?? "").trim();
    try {
      await client.workItems.create(projectId, {
        title: `Workstream: ${name}`,
        description: data.description,
        type: "milestone",
        status: "ready",
        priority: "medium",
        assigneeId: data.assigneeId,
        dueDate: data.dueDate,
        milestoneName: data.milestoneName,
        customFields: {planningType: "workstream", workstream: name},
        tags: ["workstream"]
      }, {idempotencyKey: crypto.randomUUID()});
      form.reset();
      saveStatus(form, "Workstream created.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function workflowStepDefinitionForm(client, projects, {onSaved, selectedProjectId = "", memberships = []} = {}) {
  const projectOptions = projects.map((project) => ({value: project.id, label: project.name}));
  const form = el("form", {class: "editor-form editor-form--wide"}, [
    field("Project", selectInput("projectId", projectOptions, selectedProjectId)),
    field("Workflow step", textInput("name", "Design review")),
    field("Owner", selectInput("assigneeId", memberOptions(memberships))),
    field("Time period", textInput("periodName", "Launch window")),
    field("Milestone", textInput("milestoneName", "Pilot beta")),
    field("Target", el("input", {name: "dueDate", type: "date"})),
    field("Goal", textareaInput("description", "What this step should resolve before work moves forward.")),
    el("button", {class: "button button--primary", type: "submit"}, "Create workflow step")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formValues(form);
    const projectId = data.projectId;
    const name = String(data.name ?? "").trim();
    try {
      await client.workItems.create(projectId, {
        title: `Workflow step: ${name}`,
        description: data.description,
        type: "milestone",
        status: "ready",
        priority: "medium",
        assigneeId: data.assigneeId,
        periodName: data.periodName,
        milestoneName: data.milestoneName,
        dueDate: data.dueDate,
        customFields: {planningType: "workflowStep", workflowStep: name},
        tags: ["workflowStep"]
      }, {idempotencyKey: crypto.randomUUID()});
      form.reset();
      saveStatus(form, "Workflow step created.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function planningWorkItemFormView(client, projects, {onSaved, selectedProjectId = "", memberships = []} = {}) {
  const projectOptions = projects.map((project) => ({value: project.id, label: project.name}));
  const form = el("form", {class: "editor-form editor-form--wide"}, [
    field("Project", selectInput("projectId", projectOptions, selectedProjectId)),
    field("Task", textInput("title", "Create stakeholder review")),
    field("Task type", selectInput("type", workTypeOptions(), configuredDefaultTypeId)),
    field("Status", selectInput("status", workStatusOptions(), configuredDefaultStatusId)),
    field("Priority", selectInput("priority", priorityList, "medium")),
    field("Assignee", selectInput("assigneeId", memberOptions(memberships))),
    field("Effort points", el("input", {name: "effortPoints", type: "number", min: "0", max: "100", value: "3"})),
    field("Time period", textInput("periodName", "Launch window")),
    field("Period goal", textInput("periodGoal", "Authenticate pilot users and stabilize the workspace shell.")),
    field("Intake group", selectInput("intakeGroup", intakeGroupList.map((value) => ({value, label: intakeGroupLabel(value)})), "ready")),
    field("Milestone", textInput("milestoneName", "Pilot beta")),
    field("Workflow step", textInput("workflowStep", "Design review")),
    field("Workstream", textInput("workstream", "Implementation")),
    field("Watchers", multiSelectInput("watcherIds", memberOptions(memberships, "No watcher").slice(1))),
    field("Start", el("input", {name: "startDate", type: "date"})),
    field("Due", el("input", {name: "dueDate", type: "date"})),
    field("Notes", textareaInput("description", "User value and delivery notes.")),
    field("Acceptance criteria", textareaInput("acceptanceCriteria", "What must be true when this is done?")),
    field("Tags", textInput("tags", "pilot, planning")),
    el("button", {class: "button button--primary", type: "submit"}, "Create task")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formValues(form);
    const projectId = data.projectId;
    const workstream = String(data.workstream ?? "").trim();
    const workflowStep = String(data.workflowStep ?? "").trim();
    delete data.projectId;
    delete data.workstream;
    delete data.workflowStep;
    data.customFields = {};
    if (workstream) data.customFields.workstream = workstream;
    if (workflowStep) data.customFields.workflowStep = workflowStep;
    try {
      await client.workItems.create(projectId, data, {idempotencyKey: crypto.randomUUID()});
      form.reset();
      saveStatus(form, "Task created.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

function timeEntryActivityOptions(capabilities = {}) {
  const activities = (capabilities.timeEntryActivities ?? []).filter((activity) => activity.active !== false);
  return (activities.length ? activities : [{id: "general", name: "General"}]).map((activity) => ({value: activity.id, label: activity.name ?? activity.id}));
}

export function timeEntryForm(client, projects, {onSaved, selectedProjectId = "", capabilities = {}} = {}) {
  const activityOptions = timeEntryActivityOptions(capabilities);
  const form = el("form", {class: "editor-form"}, [
    field("Project", selectInput("projectId", projects.map((item) => ({value: item.id, label: item.name})), selectedProjectId)),
    field("Date", el("input", {name: "entryDate", type: "date", value: new Date().toISOString().slice(0, 10)})),
    field("Minutes", el("input", {name: "durationMinutes", type: "number", min: "1", max: "1440", value: "30"})),
    field("Activity", selectInput("activityId", activityOptions, activityOptions.some((item) => item.value === "general") ? "general" : activityOptions[0]?.value)),
    field("Description", textInput("description", "Work completed")),
    field("Billable", el("input", {name: "billable", type: "checkbox"})),
    ...configuredCustomFieldEditors(capabilities, {}, "time-entry"),
    el("button", {class: "button button--primary", type: "submit"}, "Save time")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formValues(form);
    data.durationMinutes = Number(data.durationMinutes);
    data.billable = Boolean(data.billable);
    data.customFields = configuredCustomFieldValues(data, capabilities, {}, "time-entry");
    try {
      await client.timeEntries.create(data, {idempotencyKey: crypto.randomUUID()});
      saveStatus(form, "Time saved.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function timerControl(client, projects = [], timer = {active: false}, {onSaved, selectedProjectId = "", capabilities = {}} = {}) {
  const root = el("section", {class: "timer"});
  const readout = el("strong", {}, "00:00");
  let startedAt = timer.active ? new Date(timer.startedAt).getTime() : 0;
  let interval;
  const project = selectInput("projectId", projects.map((item) => ({value: item.id, label: item.name})), timer.projectId ?? selectedProjectId);
  const activityOptions = timeEntryActivityOptions(capabilities);
  const activity = selectInput("activityId", activityOptions, timer.activityId ?? (activityOptions.some((item) => item.value === "general") ? "general" : activityOptions[0]?.value));
  const description = textInput("description", "What are you working on?", timer.description ?? "");
  const billable = el("input", {name: "billable", type: "checkbox"});
  billable.checked = Boolean(timer.billable);
  const start = el("button", {class: "button", type: "button", disabled: timer.active ? "true" : undefined}, "Start server timer");
  const stop = el("button", {class: "button", type: "button", disabled: timer.active ? undefined : "true"}, "Stop and save");
  const status = el("p", {class: "form-status", role: "status", "aria-live": "polite"});
  const controls = el("form", {class: "editor-form"}, [
    field("Project", project),
    field("Activity", activity),
    field("Description", description),
    field("Billable", billable),
    ...configuredCustomFieldEditors(capabilities, timer.customFields ?? {}, "time-entry"),
    el("div", {class: "button-row"}, [start, stop]),
    status
  ]);
  controls.addEventListener("submit", (event) => event.preventDefault());
  const tick = () => {
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    readout.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const startClock = () => {
    clearInterval(interval);
    tick();
    interval = setInterval(tick, 1000);
  };
  if (timer.active) startClock();
  start.addEventListener("click", async () => {
    if (!client || !project.value) return;
    start.disabled = true;
    try {
      const data = formValues(controls);
      const active = await client.timer.start({
        projectId: project.value,
        activityId: activity.value,
        description: description.value,
        billable: billable.checked,
        customFields: configuredCustomFieldValues(data, capabilities, timer.customFields ?? {}, "time-entry")
      });
      startedAt = new Date(active.startedAt).getTime();
      stop.disabled = false;
      startClock();
      status.className = "form-status ok";
      status.textContent = "Timer is running across devices.";
    } catch (error) {
      start.disabled = false;
      status.className = "form-status error";
      status.textContent = error.message;
    }
  });
  stop.addEventListener("click", async () => {
    if (!client) return;
    stop.disabled = true;
    try {
      const result = await client.timer.stop();
      clearInterval(interval);
      readout.textContent = "00:00";
      status.className = "form-status ok";
      status.textContent = `Saved ${result.entry.durationMinutes} minute${result.entry.durationMinutes === 1 ? "" : "s"}.`;
      onSaved?.();
    } catch (error) {
      stop.disabled = false;
      status.className = "form-status error";
      status.textContent = error.message;
    }
  });
  root.append(
    el("h2", {}, "Persistent timer"),
    readout,
    controls
  );
  return root;
}

export function timeSummary(entries) {
  const total = entries.reduce((sum, entry) => sum + Number(entry.durationMinutes ?? 0), 0);
  return dataTable(["Signal", "Value"], [["Entries", entries.length], ["Recorded", `${Math.round(total / 60 * 10) / 10}h`]]);
}

export function timesheetTable(entries, projects, client, {onSaved, capabilities = {}} = {}) {
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const activities = new Map(timeEntryActivityOptions(capabilities).map((activity) => [activity.value, activity.label]));
  return dataTable(["Date", "Project", "Activity", "Minutes", "Billable", "Description", "Actions"], entries.map((entry) => [
    entry.entryDate,
    entry.projectId ? el("a", {href: projectHref(entry.projectId)}, names.get(entry.projectId) ?? entry.projectId ?? "") : "",
    activities.get(entry.activityId ?? "general") ?? entry.activityId ?? "General",
    entry.durationMinutes,
    entry.billable ? "Yes" : "No",
    entry.description ?? "",
    client ? timeEntryActions(client, entry, {onSaved, capabilities}) : ""
  ]));
}

function timeEntryActions(client, entry, {onSaved, capabilities = {}} = {}) {
  const date = el("input", {type: "date", value: entry.entryDate});
  const minutes = el("input", {type: "number", min: "1", max: "1440", value: entry.durationMinutes});
  const activity = selectInput("activityId", timeEntryActivityOptions(capabilities), entry.activityId ?? "general");
  const description = textInput("description", "Work completed", entry.description ?? "");
  const billable = el("input", {type: "checkbox"});
  billable.checked = Boolean(entry.billable);
  const save = el("button", {class: "button", type: "button"}, "Save");
  const remove = el("button", {class: "button", type: "button"}, "Delete");
  const status = el("span", {class: "form-status", role: "status"});
  const editor = el("form", {class: "editor-form"}, [
    field("Date", date),
    field("Minutes", minutes),
    field("Activity", activity),
    field("Description", description),
    field("Billable", billable),
    ...configuredCustomFieldEditors(capabilities, entry.customFields ?? {}, "time-entry"),
    el("div", {class: "button-row"}, [save, remove]),
    status
  ]);
  editor.addEventListener("submit", (event) => event.preventDefault());
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      const values = formValues(editor);
      await client.timeEntries.patch(entry.id, {
        version: entry.version,
        originalEntryDate: entry.entryDate,
        entryDate: date.value,
        durationMinutes: Number(minutes.value),
        activityId: activity.value,
        description: description.value,
        billable: billable.checked,
        customFields: configuredCustomFieldValues(values, capabilities, entry.customFields ?? {}, "time-entry")
      });
      status.className = "form-status ok";
      status.textContent = "Saved";
      onSaved?.();
    } catch (error) {
      save.disabled = false;
      status.className = "form-status error";
      status.textContent = error.message;
    }
  });
  remove.addEventListener("click", async () => {
    remove.disabled = true;
    try {
      await client.timeEntries.delete(entry.id, {version: entry.version, originalEntryDate: entry.entryDate});
      onSaved?.();
    } catch (error) {
      remove.disabled = false;
      status.className = "form-status error";
      status.textContent = error.message;
    }
  });
  return el("details", {class: "inline-editor"}, [
    el("summary", {}, "Edit"),
    editor
  ]);
}

export function weeklyTimesheet(entries = []) {
  const byWeek = new Map();
  for (const entry of entries) {
    const date = new Date(`${entry.entryDate}T00:00:00Z`);
    const monday = new Date(date);
    monday.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    const week = monday.toISOString().slice(0, 10);
    const day = (date.getUTCDay() + 6) % 7;
    const row = byWeek.get(week) ?? {week, days: Array(7).fill(0), total: 0};
    row.days[day] += Number(entry.durationMinutes ?? 0);
    row.total += Number(entry.durationMinutes ?? 0);
    byWeek.set(week, row);
  }
  return dataTable(["Week of", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Total"], [...byWeek.values()].sort((a, b) => b.week.localeCompare(a.week)).map((row) => [
    row.week,
    ...row.days.map(formatHours),
    formatHours(row.total)
  ]));
}

function meetingStringValues(value) {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeMeetingDateTime(value, label) {
  const date = new Date(String(value ?? ""));
  if (!value || Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date and time.`);
  return date.toISOString();
}

export function meetingMutationPayload(values = {}, agendaItems = [], {allowedWorkItemIds} = {}) {
  const projectId = String(values.projectId ?? "").trim();
  const title = String(values.title ?? "").trim();
  const status = String(values.status ?? "draft").trim();
  if (!projectId) throw new Error("Select a project before saving the meeting.");
  if (!title) throw new Error("Meeting title is required.");
  if (title.length > 200) throw new Error("Meeting title must be at most 200 characters.");
  if (!meetingStatusList.includes(status)) throw new Error("Choose a valid meeting status.");

  const startsAt = normalizeMeetingDateTime(values.startsAt, "Start");
  const endsAt = normalizeMeetingDateTime(values.endsAt, "End");
  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) throw new Error("Meeting end must be after its start.");
  if (agendaItems.length > 50) throw new Error("A meeting can contain no more than 50 agenda items.");

  const allowedTasks = allowedWorkItemIds ? new Set(allowedWorkItemIds) : undefined;
  const normalizedAgenda = agendaItems.map((item, index) => {
    const id = String(item.id ?? "").trim();
    const agendaTitle = String(item.title ?? "").trim();
    if (!id) throw new Error(`Agenda item ${index + 1} needs a stable identifier.`);
    if (!agendaTitle) throw new Error(`Agenda item ${index + 1} needs a title.`);
    if (agendaTitle.length > 200) throw new Error(`Agenda item ${index + 1} title must be at most 200 characters.`);
    const durationMinutes = Number(item.durationMinutes ?? 0);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 0 || durationMinutes > 1_440) {
      throw new Error(`Agenda item ${index + 1} duration must be between 0 and 1440 minutes.`);
    }
    const workItemIds = meetingStringValues(item.workItemIds);
    if (workItemIds.length > 25) throw new Error(`Agenda item ${index + 1} can link no more than 25 tasks.`);
    if (allowedTasks && workItemIds.some((id) => !allowedTasks.has(id))) {
      throw new Error(`Agenda item ${index + 1} contains a task outside this project.`);
    }
    return {
      id,
      section: String(item.section ?? "General").trim() || "General",
      title: agendaTitle,
      durationMinutes,
      presenterId: String(item.presenterId ?? "").trim(),
      workItemIds,
      notes: String(item.notes ?? "").trim(),
      outcome: String(item.outcome ?? "").trim()
    };
  });
  const agendaIds = normalizedAgenda.map((item) => item.id);
  if (new Set(agendaIds).size !== agendaIds.length) throw new Error("Agenda item identifiers must be unique.");
  const linkedWorkItemIds = normalizedAgenda.flatMap((item) => item.workItemIds);
  if (linkedWorkItemIds.length > 100) throw new Error("An agenda can link no more than 100 tasks.");
  if (new Set(linkedWorkItemIds).size !== linkedWorkItemIds.length) throw new Error("A task can be linked only once in an agenda.");

  const participantIds = meetingStringValues(values.participantIds);
  if (participantIds.length > 50) throw new Error("A meeting can contain no more than 50 participants.");
  const participantSet = new Set(participantIds);
  if (normalizedAgenda.some((item) => item.presenterId && !participantSet.has(item.presenterId))) {
    throw new Error("Every agenda presenter must also be selected as a participant.");
  }
  const payload = {
    projectId,
    title,
    description: String(values.description ?? "").trim(),
    startsAt,
    endsAt,
    status,
    location: String(values.location ?? "").trim(),
    participantIds,
    agendaItems: normalizedAgenda,
    minutes: String(values.minutes ?? "").trim(),
    recurrence: values.recurrenceFrequency && values.recurrenceFrequency !== "none" ? {
      frequency: values.recurrenceFrequency,
      interval: Number(values.recurrenceInterval ?? 1),
      weekdays: meetingStringValues(values.recurrenceWeekdays).flatMap((value) => value.split(",")).map((value) => Number(value.trim())).filter((value) => Number.isInteger(value)),
      until: String(values.recurrenceUntil ?? ""),
      occurrences: Number(values.recurrenceOccurrences ?? 0)
    } : undefined,
    template: Boolean(values.template),
    attachmentIds: meetingStringValues(values.attachmentIds),
    attendance: Array.isArray(values.attendance) ? values.attendance : participantIds.map((userId) => ({userId, status: "invited", note: ""})),
    invitationMessage: String(values.invitationMessage ?? "").trim()
  };
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > maxMeetingPayloadBytes) {
    throw new Error("Meeting content must be at most 32 KiB.");
  }
  return payload;
}

const meetingPatchFields = [
  "title",
  "description",
  "startsAt",
  "endsAt",
  "status",
  "location",
  "participantIds",
  "agendaItems",
  "minutes",
  "recurrence",
  "template",
  "attachmentIds",
  "attendance",
  "invitationMessage"
];

function comparableMeetingField(field, value) {
  if (field === "participantIds") return [...(value ?? [])].map(String).sort();
  if (field === "agendaItems") {
    return (value ?? []).map((item) => ({
      id: item.id ?? "",
      section: item.section ?? "General",
      section: item.section ?? "General",
      title: item.title ?? "",
      durationMinutes: Number(item.durationMinutes ?? 0),
      presenterId: item.presenterId ?? "",
      workItemIds: [...(item.workItemIds ?? [])].map(String).sort(),
      notes: item.notes ?? "",
      outcome: item.outcome ?? ""
    }));
  }
  if (["attachmentIds"].includes(field)) return [...(value ?? [])].map(String).sort();
  return value ?? "";
}

export function meetingPatchPayload(meeting, payload) {
  const patch = {projectId: meeting.projectId, version: meeting.version};
  for (const field of meetingPatchFields) {
    if (JSON.stringify(comparableMeetingField(field, meeting[field])) !== JSON.stringify(comparableMeetingField(field, payload[field]))) {
      patch[field] = payload[field];
    }
  }
  return patch;
}

function meetingInputDateTime(value, offsetMinutes = 0) {
  const source = value ? new Date(value) : new Date(Date.now() + offsetMinutes * 60_000);
  if (Number.isNaN(source.getTime())) return "";
  const local = new Date(source.getTime() - source.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 23);
}

function meetingDisplayDateTime(value) {
  if (!value) return "No date set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {dateStyle: "medium", timeStyle: "short"}).format(date);
}

function meetingTone(status) {
  return {
    draft: "neutral",
    open: "watch",
    "in-progress": "info",
    closed: "good",
    cancelled: "danger"
  }[status] ?? "neutral";
}

function meetingAgendaRow(item = {}, memberships = [], workItems = [], {allowOutcomes = false} = {}) {
  const row = el("fieldset", {class: "meeting-agenda-row"});
  const agendaId = String(item.id ?? crypto.randomUUID());
  const title = textInput("agendaTitle", "Decision, topic, or review", item.title ?? "");
  title.required = true;
  title.setAttribute("data-agenda-field", "title");
  const section = textInput("agendaSection", "General, Decisions, Backlog", item.section ?? "General");
  section.setAttribute("data-agenda-field", "section");
  const duration = el("input", {name: "agendaDuration", type: "number", min: "0", max: "1440", step: "1", value: String(item.durationMinutes ?? 15), "data-agenda-field": "durationMinutes"});
  const presenter = selectInput("agendaPresenter", memberOptions(memberships, "No presenter"), item.presenterId ?? "");
  presenter.setAttribute("data-agenda-field", "presenterId");
  const knownWorkItemIds = new Set(workItems.map((workItem) => workItem.id));
  const preservedTaskOptions = (item.workItemIds ?? [])
    .filter((id) => !knownWorkItemIds.has(id))
    .map((id) => ({value: id, label: `${id} (not in the current task results)`}));
  const tasks = multiSelectInput("agendaWorkItemIds", [...taskOptions(workItems, "", "No linked tasks").slice(1), ...preservedTaskOptions], item.workItemIds ?? []);
  tasks.querySelector("select")?.setAttribute("data-agenda-field", "workItemIds");
  const notes = textareaInput("agendaNotes", "Context, questions, or talking points", item.notes ?? "");
  notes.setAttribute("data-agenda-field", "notes");
  const outcome = textareaInput("agendaOutcome", allowOutcomes ? "Decision, owner, or follow-up" : "Available while the meeting is in progress", item.outcome ?? "");
  outcome.setAttribute("data-agenda-field", "outcome");
  outcome.disabled = !allowOutcomes;
  if (!allowOutcomes) outcome.setAttribute("aria-describedby", `${agendaId}-outcome-help`);
  const remove = el("button", {class: "button button--ghost", type: "button"}, "Remove item");
  const preservesRecordedOutcome = Boolean(String(item.outcome ?? "").trim()) && !allowOutcomes;
  remove.disabled = preservesRecordedOutcome;
  if (preservesRecordedOutcome) remove.title = "Reopen the meeting in progress before removing an item with a recorded outcome.";
  remove.addEventListener("click", () => row.remove());
  row.dataset.agendaId = agendaId;
  row.append(
    el("legend", {}, item.title ? `Agenda: ${item.title}` : "Agenda item"),
    field("Section", section),
    field("Title", title),
    field("Duration (minutes)", duration),
    field("Presenter", presenter),
    field("Linked project tasks", tasks),
    field("Notes", notes),
    field("Outcome", outcome),
    allowOutcomes ? "" : el("small", {class: "meeting-agenda-row__help", id: `${agendaId}-outcome-help`}, "Outcomes can be recorded only while the meeting is in progress."),
    remove
  );
  return row;
}

function meetingAgendaValues(form) {
  return [...form.querySelectorAll(".meeting-agenda-row")].map((row) => ({
    id: row.dataset.agendaId ?? "",
    section: row.querySelector('[data-agenda-field="section"]')?.value ?? "General",
    title: row.querySelector('[data-agenda-field="title"]')?.value ?? "",
    durationMinutes: row.querySelector('[data-agenda-field="durationMinutes"]')?.value ?? "0",
    presenterId: row.querySelector('[data-agenda-field="presenterId"]')?.value ?? "",
    workItemIds: [...(row.querySelector('[data-agenda-field="workItemIds"]')?.selectedOptions ?? [])].map((option) => option.value),
    notes: row.querySelector('[data-agenda-field="notes"]')?.value ?? "",
    outcome: row.querySelector('[data-agenda-field="outcome"]')?.value ?? ""
  }));
}

export function meetingForm(client, project, {meeting, memberships = [], workItems = [], documents = [], currentUserId = "", onSaved} = {}) {
  const editing = Boolean(meeting);
  const inProgress = meeting?.status === "in-progress";
  const eligibleMemberships = memberships.filter((membership) => (
    (membership.status === undefined || membership.status === "active")
    && (!membership.projectIds?.length || membership.projectIds.includes(project.id))
  ));
  const participants = meeting?.participantIds?.length ? meeting.participantIds : currentUserId ? [currentUserId] : [];
  const eligibleParticipantIds = new Set(eligibleMemberships.map((membership) => membership.userId));
  const historicalParticipantIds = new Set(participants.filter((participantId) => !eligibleParticipantIds.has(participantId)));
  const historicalMemberships = [...historicalParticipantIds].map((userId) => ({
    userId,
    name: `${memberName(memberships, userId)} (historical participant)`
  }));
  const participantMemberships = [...eligibleMemberships, ...historicalMemberships];
  const participantInput = multiSelectInput(
    "participantIds",
    memberOptions(participantMemberships, "No participants").slice(1),
    participants
  );
  const participantSelect = participantInput.querySelector("select");
  const creatorId = meeting?.createdBy ?? currentUserId;
  for (const option of participantSelect?.options ?? []) {
    if (option.value === creatorId) option.disabled = true;
  }
  const selectedParticipantMemberships = () => {
    const selectedIds = new Set([...(participantSelect?.selectedOptions ?? [])].map((option) => option.value));
    return participantMemberships.filter((membership) => selectedIds.has(membership.userId));
  };
  const agendaHost = el("div", {class: "meeting-agenda-editor", "aria-live": "polite"});
  for (const item of meeting?.agendaItems ?? []) agendaHost.append(meetingAgendaRow(item, selectedParticipantMemberships(), workItems, {allowOutcomes: inProgress}));
  const refreshPresenterOptions = () => {
    const presenters = memberOptions(selectedParticipantMemberships(), "No presenter");
    for (const select of agendaHost.querySelectorAll('[data-agenda-field="presenterId"]')) {
      replaceSelectOptions(select, presenters, select.value);
    }
  };
  participantSelect?.addEventListener("change", refreshPresenterOptions);
  const addAgenda = el("button", {class: "button", type: "button"}, "Add agenda item");
  addAgenda.addEventListener("click", () => {
    if (agendaHost.children.length >= 50) return;
    agendaHost.append(meetingAgendaRow({}, selectedParticipantMemberships(), workItems, {allowOutcomes: inProgress}));
    agendaHost.lastElementChild?.querySelector("input")?.focus();
  });
  const minutes = textareaInput("minutes", inProgress ? "Live notes and meeting minutes" : "Minutes unlock when the meeting is in progress", meeting?.minutes ?? "");
  minutes.disabled = !inProgress;
  const agendaHeadingId = `meeting-agenda-${meeting?.id ?? crypto.randomUUID()}`;
  const operationIdempotencyKey = editing ? undefined : crypto.randomUUID();
  const templateInput = el("input", {name: "template", type: "checkbox"});
  templateInput.checked = Boolean(meeting?.template);
  const attachmentInput = multiSelectInput("attachmentIds", documents.map((document) => ({value: document.id, label: document.name ?? document.filename ?? document.id})), meeting?.attachmentIds ?? []);
  const statusControl = editing
    ? field("Status", selectInput("status", [meeting.status, ...(meetingStatusTransitions[meeting.status] ?? [])], meeting.status))
    : el("div", {class: "meeting-editor__fixed-status"}, [
      el("input", {type: "hidden", name: "status", value: "draft"}),
      el("span", {}, "Status"),
      badge("draft", "neutral")
    ]);
  const submitButton = el("button", {class: "button button--primary", type: "submit"}, editing ? "Save meeting" : "Create meeting");
  const form = el("form", {class: "editor-form editor-form--wide meeting-editor"}, [
    el("input", {type: "hidden", name: "projectId", value: project.id}),
    field("Title", el("input", {name: "title", value: meeting?.title ?? "", placeholder: "Weekly delivery review", required: "true"})),
    statusControl,
    field("Starts", el("input", {name: "startsAt", type: "datetime-local", step: "0.001", required: "true", value: meetingInputDateTime(meeting?.startsAt, 30)})),
    field("Ends", el("input", {name: "endsAt", type: "datetime-local", step: "0.001", required: "true", value: meetingInputDateTime(meeting?.endsAt, 90)})),
    field("Location or call link", textInput("location", "Room 4 or https://...", meeting?.location ?? "")),
    field("Participants", participantInput),
    field("Invitation message", textareaInput("invitationMessage", "Optional context sent with the invitation", meeting?.invitationMessage ?? "")),
    field("Recurrence", selectInput("recurrenceFrequency", ["none", "daily", "weekly", "monthly"], meeting?.recurrence?.frequency ?? "none")),
    field("Repeat every", el("input", {name: "recurrenceInterval", type: "number", min: "1", max: "52", value: String(meeting?.recurrence?.interval ?? 1)})),
    field("Recurrence weekdays", textInput("recurrenceWeekdays", "1,3,5", (meeting?.recurrence?.weekdays ?? []).join(","))),
    field("Recurrence until", el("input", {name: "recurrenceUntil", type: "date", value: meeting?.recurrence?.until ?? ""})),
    field("Maximum occurrences", el("input", {name: "recurrenceOccurrences", type: "number", min: "0", max: "500", value: String(meeting?.recurrence?.occurrences ?? 0)})),
    field("Reusable meeting template", templateInput),
    field("Attachments", attachmentInput),
    field("Description", textareaInput("description", "Purpose and expected decisions", meeting?.description ?? "")),
    el("section", {class: "meeting-editor__agenda", "aria-labelledby": agendaHeadingId}, [
      el("div", {class: "section-heading"}, [
        el("div", {}, [
          el("h2", {id: agendaHeadingId}, "Agenda"),
          el("p", {}, "Link only tasks from this project. Outcomes unlock when the meeting is in progress.")
        ]),
        addAgenda
      ]),
      agendaHost
    ]),
    field("Minutes", minutes),
    submitButton
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitButton.disabled) return;
    submitButton.disabled = true;
    form.setAttribute("aria-busy", "true");
    const data = formValues(form);
    const selectedParticipants = [...(form.querySelector('select[name="participantIds"]')?.selectedOptions ?? [])].map((option) => option.value);
    try {
      const payload = meetingMutationPayload({
        ...data,
        projectId: project.id,
        participantIds: selectedParticipants,
        minutes: minutes.value,
        template: templateInput.checked,
        attachmentIds: [...(attachmentInput.querySelector("select")?.selectedOptions ?? [])].map((option) => option.value),
        attendance: selectedParticipants.map((userId) => meeting?.attendance?.find((item) => item.userId === userId) ?? {userId, status: "invited", note: ""})
      }, meetingAgendaValues(form), {
        allowedWorkItemIds: [
          ...workItems.map((item) => item.id),
          ...(meeting?.agendaItems ?? []).flatMap((item) => item.workItemIds ?? [])
        ]
      });
      let saved;
      if (editing) {
        const patch = meetingPatchPayload(meeting, payload);
        if (Object.keys(patch).length === 2) {
          saveStatus(form, "No meeting changes to save.", "ok");
          return;
        }
        saved = await client.meetings.patch(project.id, meeting.id, patch);
      } else saved = await client.meetings.create(project.id, payload, {idempotencyKey: operationIdempotencyKey});
      saveStatus(form, editing ? "Meeting saved." : "Meeting created.", "ok");
      onSaved?.(saved);
    } catch (error) {
      saveStatus(form, error.message, "error");
    } finally {
      submitButton.disabled = false;
      form.removeAttribute("aria-busy");
    }
  });
  return form;
}

export function meetingProjectSelector(projects = [], selectedProjectId = "") {
  return el("form", {class: "filter-form meeting-project-selector", method: "get", action: "/app/meetings"}, [
    field("Project", selectInput("projectId", projectOptions(projects), selectedProjectId)),
    el("button", {class: "button button--primary", type: "submit"}, "Open meetings")
  ]);
}

export function meetingTaskSearchForm(projectId, search = "") {
  return el("form", {class: "filter-form meeting-task-search", method: "get", action: "/app/meetings"}, [
    el("input", {type: "hidden", name: "projectId", value: projectId}),
    field("Find project tasks to link", textInput("taskSearch", "Title, description, tag, or custom field", search)),
    el("button", {class: "button", type: "submit"}, "Search tasks"),
    search ? el("a", {class: "button button--ghost", href: `/app/meetings?projectId=${encodeURIComponent(projectId)}`}, "Clear search") : "",
    el("small", {}, "The agenda selector loads at most 100 matching project tasks per search; existing links remain preserved.")
  ]);
}

function meetingParticipantNames(participantIds = [], memberships = []) {
  return participantIds.length
    ? participantIds.map((id) => memberName(memberships, id)).join(", ")
    : "No participants";
}

export function meetingsWorkspace(meetings = [], project, {memberships = [], cursor = "", canManage = false} = {}) {
  if (!meetings.length) return emptyActionView(
    "No meetings for this project",
    canManage ? "Create a draft agenda without loading meetings or tasks from other projects." : "No meeting records are available in this project.",
    canManage ? {label: "Create meeting", href: "#new-meeting"} : undefined
  );
  return el("section", {class: "meeting-list", "aria-labelledby": "meeting-list-heading"}, [
    el("div", {class: "section-heading"}, [
      el("h2", {id: "meeting-list-heading"}, "Project meetings"),
      el("span", {}, `${meetings.length} on this page`)
    ]),
    el("div", {class: "meeting-list__grid"}, meetings.map((meeting) => {
      const detailParams = new URLSearchParams({projectId: project.id, meetingId: meeting.id});
      if (cursor) detailParams.set("cursor", cursor);
      const decisions = (meeting.agendaItems ?? []).filter((item) => item.outcome).length;
      const followUps = new Set((meeting.agendaItems ?? []).flatMap((item) => item.workItemIds ?? [])).size;
      return el("article", {class: `meeting-card meeting-card--${meetingTone(meeting.status)}`}, [
        el("div", {class: "meeting-card__heading"}, [
          el("a", {href: `/app/meetings?${detailParams}`}, meeting.title),
          badge(meeting.status ?? "draft", meetingTone(meeting.status))
        ]),
        meeting.description ? el("p", {}, meeting.description) : "",
        el("dl", {class: "meeting-card__facts"}, [
          el("div", {}, [el("dt", {}, "When"), el("dd", {}, meetingDisplayDateTime(meeting.startsAt))]),
          el("div", {}, [el("dt", {}, "Location"), el("dd", {}, meeting.location || "Not set")]),
          el("div", {}, [el("dt", {}, "Participants"), el("dd", {}, String(meeting.participantIds?.length ?? 0))]),
          el("div", {}, [el("dt", {}, "Record"), el("dd", {}, `${meeting.agendaItems?.length ?? 0} agenda · ${decisions} ${decisions === 1 ? "decision" : "decisions"} · ${followUps} ${followUps === 1 ? "follow-up" : "follow-ups"}`)])
        ]),
        el("small", {}, meetingParticipantNames(meeting.participantIds ?? [], memberships))
      ]);
    }))
  ]);
}

export function globalMeetingsTable(meetings = [], projects = []) {
  const projectById = new Map(projects.map((project) => [project.id, project.name]));
  if (!meetings.length) return emptyView("No upcoming meetings are visible in this workspace.");
  return dataTable(["Meeting", "Project", "Starts", "Status", "Series"], meetings.map((meeting) => [
    el("a", {href: `/app/meetings?projectId=${encodeURIComponent(meeting.projectId)}&meetingId=${encodeURIComponent(meeting.id)}`}, meeting.title),
    projectById.get(meeting.projectId) ?? meeting.projectId,
    meetingDisplayDateTime(meeting.startsAt),
    badge(meeting.status, meetingTone(meeting.status)),
    meeting.recurrence ? titleCase(meeting.recurrence.frequency) : meeting.template ? "Template" : "One time"
  ]));
}

function meetingAgendaView(items = [], memberships = [], workItems = [], projectId = "") {
  const workById = workItemLookup(workItems);
  if (!items.length) return emptyView("No agenda items have been added.");
  return el("ol", {class: "meeting-agenda"}, items.map((item) => el("li", {}, [
    el("div", {class: "meeting-agenda__heading"}, [
      el("strong", {}, `${item.section ?? "General"} · ${item.title}`),
      item.durationMinutes ? el("span", {}, `${item.durationMinutes} min`) : ""
    ]),
    item.presenterId ? el("small", {}, `Presenter: ${memberName(memberships, item.presenterId)}`) : "",
    item.notes ? el("p", {}, item.notes) : "",
    item.outcome ? el("div", {class: "meeting-agenda__outcome"}, [el("strong", {}, "Decision / outcome"), el("p", {}, item.outcome)]) : "",
    item.workItemIds?.length ? el("div", {class: "meeting-followups"}, [
      el("strong", {}, "Linked follow-ups"),
      ...item.workItemIds.map((id) => {
        const workItem = workById.get(id);
        return el("div", {class: "meeting-followup"}, [
          el("a", {href: workItemHref(workItem ?? {id, projectId})}, workItem?.title ?? id),
          workItem ? badge(workStatusLabel(workItem.status ?? configuredDefaultStatusId), statusTone(workItem.status)) : "",
          workItem ? el("span", {}, workItem.assigneeName ?? memberName(memberships, workItem.assigneeId) ?? "Unassigned") : "",
          workItem?.dueDate ? el("span", {}, `Due ${formatDate(workItem.dueDate)}`) : ""
        ]);
      })
    ]) : ""
  ])));
}

function meetingLifecycleView(status = "draft") {
  const steps = [
    {key: "draft", label: "Draft"},
    {key: "open", label: "Scheduled"},
    {key: "in-progress", label: "In progress"},
    {key: "closed", label: "Closed"}
  ];
  const currentIndex = steps.findIndex((step) => step.key === status);
  if (status === "cancelled") {
    return el("div", {class: "meeting-lifecycle", "aria-label": "Meeting lifecycle"}, [badge("Cancelled", "danger")]);
  }
  return el("ol", {class: "meeting-lifecycle", "aria-label": "Meeting lifecycle"}, steps.map((step, index) => el("li", {
    class: `${index < currentIndex ? "is-complete" : ""}${index === currentIndex ? " is-current" : ""}`.trim(),
    "aria-current": index === currentIndex ? "step" : undefined
  }, step.label)));
}

function downloadMeetingExport(result) {
  const bytes = result.base64
    ? Uint8Array.from(atob(result.base64), (character) => character.charCodeAt(0))
    : result.content;
  const url = URL.createObjectURL(new Blob([bytes], {type: result.contentType}));
  const link = el("a", {href: url, download: result.filename});
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function meetingDetailView(meeting, client, {memberships = [], workItems = [], documents = [], currentUserId = "", canManage = false, onSaved} = {}) {
  const locked = meeting.status === "closed" || meeting.status === "cancelled";
  const reopen = el("button", {class: "button", type: "button"}, "Reopen meeting");
  reopen.addEventListener("click", async () => {
    reopen.disabled = true;
    try {
      await client.meetings.patch(meeting.projectId, meeting.id, {projectId: meeting.projectId, version: meeting.version, status: "open"});
      onSaved?.();
    } catch (error) {
      reopen.disabled = false;
      reopen.insertAdjacentElement("afterend", el("span", {class: "form-status error", role: "alert"}, error.message));
    }
  });
  const calendar = el("button", {class: "button", type: "button"}, "iCalendar");
  calendar.addEventListener("click", async () => downloadMeetingExport(await client.meetings.calendar(meeting.projectId, meeting.id)));
  const pdf = el("button", {class: "button", type: "button"}, "PDF");
  pdf.addEventListener("click", async () => downloadMeetingExport(await client.meetings.pdf(meeting.projectId, meeting.id)));
  const copy = el("button", {class: "button", type: "button"}, "Copy");
  copy.addEventListener("click", async () => {
    copy.disabled = true;
    try {
      await client.meetings.copy(meeting.projectId, meeting.id, {title: `${meeting.title} copy`});
      onSaved?.();
    } catch (error) {
      copy.disabled = false;
      copy.insertAdjacentElement("afterend", el("span", {class: "form-status error", role: "alert"}, error.message));
    }
  });
  const remove = el("button", {class: "button button--ghost", type: "button"}, "Delete");
  remove.addEventListener("click", async () => {
    if (!confirm(`Delete “${meeting.title}”?`)) return;
    remove.disabled = true;
    try {
      await client.meetings.delete(meeting.projectId, meeting.id, {version: meeting.version});
      onSaved?.();
    } catch (error) {
      remove.disabled = false;
      remove.insertAdjacentElement("afterend", el("span", {class: "form-status error", role: "alert"}, error.message));
    }
  });
  const attendance = meeting.participantIds?.includes(currentUserId) ? (() => {
    const current = meeting.attendance?.find((item) => item.userId === currentUserId);
    const status = selectInput("attendanceStatus", ["accepted", "tentative", "declined", "attended", "absent"], current?.status === "invited" ? "accepted" : current?.status ?? "accepted");
    const respond = el("button", {class: "button", type: "submit"}, "Save response");
    const form = el("form", {class: "editor-form"}, [field("Your attendance", status), respond]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      respond.disabled = true;
      try {
        await client.meetings.attendance(meeting.projectId, meeting.id, {version: meeting.version, status: status.value});
        onSaved?.();
      } catch (error) {
        respond.disabled = false;
        saveStatus(form, error.message, "error");
      }
    });
    return form;
  })() : "";
  return el("article", {class: "meeting-detail", id: "meeting-detail"}, [
    el("div", {class: "section-heading"}, [
      el("div", {}, [
        el("p", {class: "eyebrow"}, "Meeting record"),
        el("h2", {}, meeting.title)
      ]),
      el("div", {class: "badge-row"}, [badge(meeting.status ?? "draft", meetingTone(meeting.status)), meeting.template ? badge("Template", "info") : "", locked && canManage ? reopen : ""])
    ]),
    meeting.description ? el("p", {class: "meeting-detail__description"}, meeting.description) : "",
    meetingLifecycleView(meeting.status),
    el("dl", {class: "meeting-detail__facts"}, [
      el("div", {}, [el("dt", {}, "Starts"), el("dd", {}, meetingDisplayDateTime(meeting.startsAt))]),
      el("div", {}, [el("dt", {}, "Ends"), el("dd", {}, meetingDisplayDateTime(meeting.endsAt))]),
      el("div", {}, [el("dt", {}, "Location"), el("dd", {}, meeting.location || "Not set")]),
      el("div", {}, [el("dt", {}, "Participants"), el("dd", {}, meetingParticipantNames(meeting.participantIds ?? [], memberships))]),
      el("div", {}, [el("dt", {}, "Recurrence"), el("dd", {}, meeting.recurrence ? `${titleCase(meeting.recurrence.frequency)} every ${meeting.recurrence.interval}` : "One time")]),
      el("div", {}, [el("dt", {}, "Attachments"), el("dd", {}, (meeting.attachmentIds ?? []).map((id) => documents.find((document) => document.id === id)?.name ?? id).join(", ") || "None")])
    ]),
    el("div", {class: "button-row"}, [calendar, pdf, canManage ? copy : "", canManage ? remove : ""]),
    attendance,
    meeting.attendance?.length ? el("section", {class: "meeting-detail__section"}, [el("h3", {}, "Attendance and invitations"), dataTable(["Participant", "Response", "Note"], meeting.attendance.map((item) => [memberName(memberships, item.userId), badge(item.status, item.status === "accepted" || item.status === "attended" ? "good" : "neutral"), item.note || "—"]))]) : "",
    el("section", {class: "meeting-detail__section"}, [el("h3", {}, "Agenda and outcomes"), meetingAgendaView(meeting.agendaItems ?? [], memberships, workItems, meeting.projectId)]),
    el("section", {class: "meeting-detail__section"}, [
      el("h3", {}, "Minutes"),
      meeting.minutes ? el("p", {class: "meeting-minutes"}, meeting.minutes) : emptyView(meeting.status === "in-progress" ? "No minutes recorded yet." : "Minutes can be recorded while the meeting is in progress.")
    ]),
    locked
      ? el("p", {class: "meeting-detail__readonly"}, `${titleCase(meeting.status)} meetings are read-only.${canManage ? " Reopen this meeting to make changes." : ""}`)
      : !canManage ? el("p", {class: "meeting-detail__readonly"}, "Your viewer role has read-only meeting access.") : ""
  ]);
}

export function meetingDeferredNotice() {
  return el("div", {class: "meeting-deferred"}, [
    el("p", {}, "Meeting records support:"),
    el("ul", {}, [
      "recurring series and templates",
      "agenda sections and backlog workflows",
      "attendance responses and participant invitations",
      "calendar and iCalendar delivery",
      "presentation mode and PDF export",
      "attachments, copy, and delete actions"
    ].map((item) => el("li", {}, item)))
  ]);
}

const projectContentKindOptions = [
  {value: "wiki-page", label: "Wiki page"},
  {value: "document", label: "Collaborative document"},
  {value: "news", label: "News post"},
  {value: "forum-topic", label: "Forum topic"}
];

const projectContentStatusOptions = ["draft", "published", "locked", "archived"];

export function projectContentFilter(projects = [], values = {}) {
  return el("form", {class: "filter-form", method: "get", action: "/app/content"}, [
    field("Project", selectInput("projectId", projectOptions(projects), values.projectId ?? "")),
    field("Content type", selectInput("kind", [{value: "", label: "All content"}, ...projectContentKindOptions], values.kind ?? "")),
    field("Status", selectInput("status", ["", ...projectContentStatusOptions], values.status ?? "")),
    field("Search", textInput("search", "Title, body, or tag", values.search ?? "")),
    el("button", {class: "button button--primary", type: "submit"}, "Apply")
  ]);
}

export function projectContentForm(client, project, {content, availableContent = [], onSaved} = {}) {
  const editing = Boolean(content);
  const pinned = el("input", {name: "pinned", type: "checkbox"});
  pinned.checked = Boolean(content?.pinned);
  const parentOptions = [
    {value: "", label: "No parent"},
    ...availableContent.filter((item) => item.id !== content?.id).map((item) => ({value: item.id, label: item.title}))
  ];
  const submit = el("button", {class: "button button--primary", type: "submit"}, editing ? "Save revision" : "Create content");
  const form = el("form", {class: "editor-form editor-form--wide"}, [
    field("Type", selectInput("kind", projectContentKindOptions, content?.kind ?? "wiki-page")),
    field("Title", el("input", {name: "title", required: "true", maxlength: "240", value: content?.title ?? "", placeholder: "Project handbook"})),
    field("Parent page", selectInput("parentId", parentOptions, content?.parentId ?? "")),
    field("Status", selectInput("status", projectContentStatusOptions, content?.status ?? "draft")),
    field("Body", textareaInput("body", "Markdown content, decisions, or discussion prompt", content?.body ?? "")),
    field("Tags", textInput("tags", "handbook, release, decision", (content?.tags ?? []).join(", "))),
    field("Pin to top", pinned),
    submit
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    const values = formValues(form);
    const payload = {
      projectId: project.id,
      kind: values.kind,
      title: values.title,
      parentId: values.parentId,
      status: values.status,
      body: values.body,
      format: "markdown",
      tags: String(values.tags ?? "").split(",").map((tag) => tag.trim()).filter(Boolean),
      pinned: Boolean(values.pinned)
    };
    try {
      const saved = editing
        ? await client.projectContent.patch(project.id, content.id, {version: content.version, ...payload})
        : await client.projectContent.create(payload);
      saveStatus(form, editing ? "Revision saved." : "Content created.", "ok");
      onSaved?.(saved);
    } catch (error) {
      saveStatus(form, error.message, "error");
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}

export function projectContentList(items = [], projectId = "") {
  if (!items.length) return emptyView("No matching project content.");
  const byParent = new Map();
  for (const item of items) {
    const siblings = byParent.get(item.parentId ?? "") ?? [];
    siblings.push(item);
    byParent.set(item.parentId ?? "", siblings);
  }
  const renderItem = (item, visited = new Set()) => {
    const nextVisited = new Set(visited).add(item.id);
    const children = (byParent.get(item.id) ?? []).filter((child) => !nextVisited.has(child.id));
    return el("li", {}, [
      el("article", {class: "content-card"}, [
        el("div", {class: "section-heading"}, [
          el("a", {href: `/app/content?projectId=${encodeURIComponent(projectId)}&contentId=${encodeURIComponent(item.id)}`}, item.title),
          el("div", {class: "badge-row"}, [badge(item.kind, "neutral"), badge(item.status, item.status === "published" ? "good" : item.status === "locked" ? "watch" : "neutral"), item.pinned ? badge("Pinned", "info") : ""])
        ]),
        item.body ? el("p", {}, item.body.slice(0, 240)) : "",
        el("small", {}, `Revision ${item.version} · updated ${formatDate(item.updatedAt)}`)
      ]),
      children.length ? el("ul", {class: "content-tree"}, children.map((child) => renderItem(child, nextVisited))) : ""
    ]);
  };
  const roots = items.filter((item) => !item.parentId || !items.some((candidate) => candidate.id === item.parentId));
  return el("ul", {class: "content-tree"}, roots.map((item) => renderItem(item)));
}

function expandContentMacros(body, {project, content} = {}) {
  const macros = {
    "project.name": project?.name ?? "Project",
    "project.id": project?.id ?? content?.projectId ?? "",
    "content.title": content?.title ?? "",
    today: new Date().toISOString().slice(0, 10)
  };
  return String(body ?? "").replace(/\{\{\s*([a-z][a-z0-9.-]*)\s*\}\}/gi, (match, name) => (
    name === "toc" ? match : Object.hasOwn(macros, name) ? macros[name] : match
  ));
}

function inlineMarkdown(text, projectId) {
  const fragment = document.createDocumentFragment();
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https:\/\/[^\s)]+|\/[^\s)]*)\)|\[work-item:([^\]]+)\])/g;
  let cursor = 0;
  for (const match of String(text).matchAll(pattern)) {
    fragment.append(String(text).slice(cursor, match.index));
    if (match[2]) fragment.append(el("strong", {}, match[2]));
    else if (match[3]) fragment.append(el("code", {}, match[3]));
    else if (match[4]) fragment.append(el("a", {href: match[5], rel: match[5].startsWith("https://") ? "noopener noreferrer" : undefined, target: match[5].startsWith("https://") ? "_blank" : undefined}, match[4]));
    else if (match[6]) fragment.append(el("a", {href: projectId ? `/app/project?id=${encodeURIComponent(projectId)}#${encodeURIComponent(match[6])}` : "#"}, `Work item ${match[6]}`));
    cursor = Number(match.index) + match[0].length;
  }
  fragment.append(String(text).slice(cursor));
  return fragment;
}

export function projectContentBody(body, context = {}) {
  const source = expandContentMacros(body, context);
  const lines = source.split("\n");
  const headings = lines.map((line, index) => {
    const match = line.match(/^(#{1,3})\s+(.+)$/);
    return match ? {level: match[1].length, label: match[2], id: `content-heading-${index}`} : undefined;
  }).filter(Boolean);
  const container = el("div", {class: "content-body content-body--rendered"});
  let list;
  let code;
  const finishList = () => { list = undefined; };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().startsWith("```")) {
      finishList();
      if (code) {
        container.append(el("pre", {}, el("code", {}, code.join("\n"))));
        code = undefined;
      } else code = [];
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (/^\{\{\s*toc\s*\}\}$/i.test(line.trim())) {
      finishList();
      container.append(el("nav", {class: "content-toc", "aria-label": "On this page"}, [el("strong", {}, "On this page"), el("ul", {}, headings.map((heading) => el("li", {class: `content-toc__level-${heading.level}`}, el("a", {href: `#${heading.id}`}, heading.label))))]));
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      finishList();
      const item = headings.find((candidate) => candidate.id === `content-heading-${index}`);
      container.append(el(`h${heading[1].length}`, {id: item?.id}, inlineMarkdown(heading[2], context.project?.id ?? context.content?.projectId)));
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      if (!list) {
        list = el("ul", {});
        container.append(list);
      }
      list.append(el("li", {}, inlineMarkdown(bullet[1], context.project?.id ?? context.content?.projectId)));
      continue;
    }
    finishList();
    if (line.startsWith("> ")) container.append(el("blockquote", {}, inlineMarkdown(line.slice(2), context.project?.id ?? context.content?.projectId)));
    else if (line.trim()) container.append(el("p", {}, inlineMarkdown(line, context.project?.id ?? context.content?.projectId)));
  }
  if (code) container.append(el("pre", {}, el("code", {}, code.join("\n"))));
  if (!container.childNodes.length) container.append(el("p", {}, "No content yet."));
  return container;
}

export function contentEditOperations(previous, next) {
  previous = String(previous ?? "");
  next = String(next ?? "");
  if (previous === next) return [];
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < previous.length - prefix && suffix < next.length - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;
  const operations = [];
  const deleteCount = previous.length - prefix - suffix;
  const insertText = next.slice(prefix, next.length - suffix);
  if (deleteCount) operations.push({type: "delete", index: prefix, count: deleteCount});
  if (insertText) operations.push({type: "insert", index: prefix, text: insertText});
  return operations;
}

export function collaborativeContentEditor(client, project, content, presence = [], {onSaved} = {}) {
  const clientId = globalThis.crypto?.randomUUID?.() ?? `editor-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let baseBody = String(content.body ?? "");
  let baseVersion = Number(content.version);
  let dirty = false;
  let saving = false;
  let autoSaveTimer;
  let syncTimer;
  const editor = textareaInput("body", "Write Markdown, {{project.name}}, {{toc}}, or [work-item:ID]", baseBody);
  editor.rows = 14;
  const preview = el("div", {class: "content-editor__preview"}, projectContentBody(editor.value, {project, content}));
  const collaborators = el("div", {class: "content-presence", "aria-live": "polite"});
  const renderPresence = (items = []) => collaborators.replaceChildren(
    badge(`${items.length || 1} active editor${(items.length || 1) === 1 ? "" : "s"}`, "info"),
    el("span", {}, items.map((item) => item.userName).filter(Boolean).join(", ") || "You")
  );
  renderPresence(presence);
  const syncStatus = el("p", {class: "form-status", role: "status", "aria-live": "polite"}, `Synced revision ${baseVersion}`);
  const setSyncStatus = (message, tone = "") => {
    syncStatus.className = `form-status${tone ? ` ${tone}` : ""}`;
    syncStatus.textContent = message;
  };
  const submit = el("button", {class: "button button--primary", type: "submit"}, "Save now");
  const form = el("form", {class: "editor-form editor-form--wide content-editor"}, [
    el("div", {class: "content-editor__toolbar", role: "toolbar", "aria-label": "Formatting"}),
    field("Markdown content", editor),
    collaborators,
    el("details", {class: "content-editor__help"}, [el("summary", {}, "Macros and links"), el("p", {}, "Use {{project.name}}, {{project.id}}, {{content.title}}, {{today}}, {{toc}}, and [work-item:ID]. Markdown links must use HTTPS or an application-relative path.")]),
    el("section", {}, [el("h3", {}, "Live preview"), preview]),
    syncStatus,
    submit
  ]);
  const toolbar = form.querySelector(".content-editor__toolbar");
  const applyMarkup = (before, after = before, fallback = "text") => {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const selected = editor.value.slice(start, end) || fallback;
    editor.setRangeText(`${before}${selected}${after}`, start, end, "end");
    editor.dispatchEvent(new Event("input", {bubbles: true}));
    editor.focus();
  };
  for (const action of [
    {label: "Heading", run: () => applyMarkup("## ", "", "Heading")},
    {label: "Bold", run: () => applyMarkup("**", "**")},
    {label: "Code", run: () => applyMarkup("`", "`")},
    {label: "Link", run: () => applyMarkup("[", "](https://example.com)", "link text")},
    {label: "Work item", run: () => applyMarkup("[work-item:", "]", "ID")},
    {label: "Contents", run: () => applyMarkup("", "", "{{toc}}")}
  ]) {
    const button = el("button", {class: "button", type: "button"}, action.label);
    button.addEventListener("click", action.run);
    toolbar.append(button);
  }
  let presenceTimer;
  const reportPresence = () => {
    clearTimeout(presenceTimer);
    presenceTimer = setTimeout(() => client.projectContent.updatePresence(project.id, content.id, {clientId, cursor: editor.selectionStart, selectionEnd: editor.selectionEnd}).catch(() => undefined), 250);
    presenceTimer.unref?.();
  };
  const saveRevision = async ({notify = false} = {}) => {
    if (saving) return;
    const draft = editor.value;
    const operations = contentEditOperations(baseBody, draft);
    if (!operations.length) {
      dirty = false;
      setSyncStatus(`Synced revision ${baseVersion}`, "ok");
      return;
    }
    saving = true;
    submit.disabled = true;
    editor.readOnly = true;
    const changeId = globalThis.crypto?.randomUUID?.() ?? `${clientId}-${Date.now()}`;
    try {
      let saved;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          saved = await client.projectContent.operations(project.id, content.id, {version: baseVersion, clientId, changeId, operations});
          break;
        } catch (error) {
          if (error.status !== 409 || attempt) throw error;
        }
      }
      baseBody = String(saved.body ?? "");
      baseVersion = Number(saved.version);
      editor.value = baseBody;
      dirty = false;
      preview.replaceChildren(projectContentBody(editor.value, {project, content: {...content, body: baseBody, version: baseVersion}}));
      setSyncStatus(`${saved.collaboration?.merged ? "Merged concurrent edits and synced" : "Synced"} revision ${baseVersion}.`, "ok");
      if (notify) onSaved?.(saved);
    } catch (error) {
      dirty = true;
      setSyncStatus(error.status === 409 ? "The collaboration window advanced repeatedly. Your draft is preserved; try Save now again." : error.message, "error");
    } finally {
      editor.readOnly = false;
      submit.disabled = false;
    }
  };
  const scheduleAutoSave = () => {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => saveRevision(), 1200);
    autoSaveTimer.unref?.();
  };
  editor.addEventListener("input", () => {
    dirty = true;
    preview.replaceChildren(projectContentBody(editor.value, {project, content}));
    reportPresence();
    setSyncStatus("Local changes waiting to sync…");
    scheduleAutoSave();
  });
  editor.addEventListener("select", reportPresence);
  reportPresence();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearTimeout(autoSaveTimer);
    await saveRevision({notify: true});
  });
  const syncRemote = async () => {
    if (saving) return;
    try {
      const [latest, activePresence] = await Promise.all([
        client.projectContent.get(project.id, content.id),
        client.projectContent.presence(project.id, content.id)
      ]);
      renderPresence(activePresence.items ?? []);
      if (Number(latest.version) <= baseVersion) return;
      if (dirty) await saveRevision();
      else {
        baseBody = String(latest.body ?? "");
        baseVersion = Number(latest.version);
        editor.value = baseBody;
        preview.replaceChildren(projectContentBody(editor.value, {project, content: latest}));
        setSyncStatus(`Received revision ${baseVersion}.`, "ok");
      }
    } catch {
      if (!dirty) setSyncStatus("Live sync is reconnecting…", "warning");
    }
  };
  syncTimer = setInterval(syncRemote, 2500);
  syncTimer.unref?.();
  globalThis.window?.addEventListener?.("pagehide", () => {
    clearTimeout(autoSaveTimer);
    clearTimeout(presenceTimer);
    clearInterval(syncTimer);
  }, {once: true});
  return form;
}

export function projectContentDetail(content, revisions = [], client, {onSaved, project} = {}) {
  const remove = el("button", {class: "button button--danger", type: "button"}, "Delete");
  remove.addEventListener("click", async () => {
    if (!confirm(`Delete “${content.title}”? Its immutable revision history will remain in the audit store.`)) return;
    remove.disabled = true;
    try {
      await client.projectContent.delete(content.projectId, content.id, {version: content.version});
      onSaved?.();
    } catch (error) {
      remove.disabled = false;
      remove.insertAdjacentElement("afterend", el("span", {class: "form-status error", role: "alert"}, error.message));
    }
  });
  return el("article", {class: "meeting-detail"}, [
    el("div", {class: "section-heading"}, [el("div", {}, [el("p", {class: "eyebrow"}, content.kind), el("h2", {}, content.title)]), remove]),
    el("div", {class: "badge-row"}, [badge(content.status, content.status === "published" ? "good" : "neutral"), badge(`Revision ${content.version}`, "info")]),
    projectContentBody(content.body, {project, content}),
    el("section", {}, [
      el("h3", {}, "Revision history"),
      revisions.length ? dataTable(["Revision", "Editor", "Saved", "Status"], revisions.map((revision) => [String(revision.version), revision.actorId, formatDate(revision.createdAt), revision.status])) : emptyView("No revisions found.")
    ])
  ]);
}

const planningResourceKindOptions = [
  {value: "version", label: "Version / roadmap release"},
  {value: "sprint", label: "Sprint"},
  {value: "baseline", label: "Schedule baseline"},
  {value: "work-calendar", label: "Work calendar"},
  {value: "board", label: "Persistent action board"}
];

const boardDimensionOptions = ["status", "assignee", "team", "version", "sprint", "subproject", "priority", "type"];

export function planningResourceForm(client, project, projects = [], {onSaved, capabilities = {}} = {}) {
  const submit = el("button", {class: "button button--primary", type: "submit"}, "Create planning resource");
  const defaultInput = el("input", {name: "default", type: "checkbox"});
  const kindInput = selectInput("kind", planningResourceKindOptions, "sprint");
  const versionFields = el("div", {class: "editor-form__section", hidden: "true"}, configuredCustomFieldEditors(capabilities, {}, "version"));
  const form = el("form", {class: "editor-form editor-form--wide"}, [
    field("Resource type", kindInput),
    field("Name", el("input", {name: "name", required: "true", maxlength: "160", placeholder: "Sprint 12 or Release 2.0"})),
    field("Status", selectInput("status", ["planned", "active", "closed", "archived"], "planned")),
    field("Start", el("input", {name: "startDate", type: "date"})),
    field("End", el("input", {name: "endDate", type: "date"})),
    field("Goal", textareaInput("goal", "Sprint goal, release outcome, or baseline note")),
    field("Capacity (story points)", el("input", {name: "capacityPoints", type: "number", min: "0", max: "100000", value: "0"})),
    field("Share with projects", multiSelectInput("sharedProjectIds", projectOptions(projects).slice(1), [])),
    field("Working weekdays", textInput("workingDays", "1,2,3,4,5 (0 is Sunday)", "1,2,3,4,5")),
    field("Holidays", textInput("holidays", "2026-12-25, 2027-01-01")),
    field("Hours per day", el("input", {name: "hoursPerDay", type: "number", min: "1", max: "24", value: "8"})),
    field("Board columns", selectInput("boardDimension", boardDimensionOptions, "status")),
    field("Board editor user IDs", textInput("boardEditorIds", "user-one, user-two")),
    field("Use as project default", defaultInput),
    field("Description", textareaInput("description", "Planning context and operating notes")),
    versionFields,
    submit
  ]);
  const syncVersionFields = () => {
    const enabled = kindInput.value === "version";
    versionFields.hidden = !enabled;
    for (const control of versionFields.querySelectorAll("input, select, textarea")) control.disabled = !enabled;
  };
  kindInput.addEventListener("change", syncVersionFields);
  syncVersionFields();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    const data = formValues(form);
    try {
      const customFields = data.kind === "version" ? configuredCustomFieldValues(data, capabilities, {}, "version") : {};
      const saved = await client.planningResources.create({
        projectId: project.id,
        kind: data.kind,
        name: data.name,
        status: data.status,
        startDate: data.startDate,
        endDate: data.endDate,
        goal: data.goal,
        description: data.description,
        capacityPoints: Number(data.capacityPoints ?? 0),
        sharedProjectIds: [...(form.querySelector('select[name="sharedProjectIds"]')?.selectedOptions ?? [])].map((option) => option.value),
        workingDays: csvValues(data.workingDays).map(Number),
        holidays: csvValues(data.holidays),
        hoursPerDay: Number(data.hoursPerDay ?? 8),
        boardDimension: data.boardDimension,
        boardEditorIds: csvValues(data.boardEditorIds),
        default: Boolean(data.default),
        customFields
      });
      saveStatus(form, `${titleCase(saved.kind)} created.`, "ok");
      onSaved?.(saved);
    } catch (error) {
      saveStatus(form, error.message, "error");
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}

function planningResourceCustomFieldsForm(client, resource, capabilities = {}, {onSaved} = {}) {
  if (resource.kind !== "version" || !customFieldDefinitions(capabilities, "version").length) return "";
  const save = el("button", {class: "button", type: "submit"}, "Save version fields");
  const form = el("form", {class: "editor-form"}, [
    ...configuredCustomFieldEditors(capabilities, resource.customFields ?? {}, "version"),
    save
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    const data = formValues(form);
    try {
      const saved = await client.planningResources.patch(resource.projectId, resource.id, {
        version: resource.version,
        customFields: configuredCustomFieldValues(data, capabilities, resource.customFields ?? {}, "version")
      });
      saveStatus(form, "Version fields saved.", "ok");
      onSaved?.(saved);
    } catch (error) {
      save.disabled = false;
      saveStatus(form, error.message, "error");
    }
  });
  return el("details", {class: "inline-editor"}, [el("summary", {}, "Edit version fields"), form]);
}

function planningResourceHref(resource) {
  const params = new URLSearchParams({projectId: resource.projectId, resourceId: resource.id});
  return `/app/planning?${params}`;
}

function planningResourceAssignment(client, resource, workItems, {onSaved} = {}) {
  if (!["version", "sprint"].includes(resource.kind)) return "";
  const fieldName = resource.kind === "version" ? "versionId" : "sprintId";
  const selected = workItems.filter((item) => item[fieldName] === resource.id).map((item) => item.id);
  const taskSelect = multiSelectInput("workItemIds", taskOptions(workItems, "", "No tasks").slice(1), selected);
  const save = el("button", {class: "button", type: "submit"}, `Save ${resource.kind} backlog`);
  const form = el("form", {class: "editor-form"}, [field("Backlog tasks", taskSelect), save]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    const chosen = new Set([...(taskSelect.querySelector("select")?.selectedOptions ?? [])].map((option) => option.value));
    const updates = workItems.filter((item) => chosen.has(item.id) !== (item[fieldName] === resource.id));
    try {
      for (const item of updates) {
        await client.workItems.patch(item.projectId, item.id, {version: item.version, [fieldName]: chosen.has(item.id) ? resource.id : ""});
      }
      saveStatus(form, `${updates.length} task links updated.`, "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    } finally {
      save.disabled = false;
    }
  });
  return form;
}

export function planningResourcesView(resources = [], client, workItems = [], {onSaved, capabilities = {}} = {}) {
  if (!resources.length) return emptyView("No versions, sprints, baselines, calendars, or saved boards yet.");
  return el("div", {class: "card-grid"}, resources.map((resource) => {
    const remove = el("button", {class: "button button--ghost", type: "button"}, "Delete");
    remove.addEventListener("click", async () => {
      if (!confirm(`Delete ${resource.kind} “${resource.name}”?`)) return;
      remove.disabled = true;
      try {
        await client.planningResources.delete(resource.projectId, resource.id, {version: resource.version});
        onSaved?.();
      } catch (error) {
        remove.disabled = false;
        remove.insertAdjacentElement("afterend", el("span", {class: "form-status error", role: "alert"}, error.message));
      }
    });
    return el("article", {class: "metric-card"}, [
      el("div", {class: "section-heading"}, [el("a", {href: planningResourceHref(resource)}, resource.name), badge(resource.kind, "neutral")]),
      el("div", {class: "badge-row"}, [badge(resource.status, resource.status === "active" ? "good" : "neutral"), resource.default ? badge("Default", "info") : ""]),
      resource.goal ? el("p", {}, resource.goal) : "",
      el("dl", {class: "meeting-card__facts"}, [
        el("div", {}, [el("dt", {}, "Window"), el("dd", {}, resource.startDate || resource.endDate ? `${formatDate(resource.startDate) || "…"} – ${formatDate(resource.endDate) || "…"}` : "Not dated")]),
        el("div", {}, [el("dt", {}, "Tasks"), el("dd", {}, String(resource.workItemCount ?? 0))]),
        el("div", {}, [el("dt", {}, "Points"), el("dd", {}, `${resource.completedPoints ?? 0}/${resource.totalPoints ?? 0}`)]),
        resource.kind === "board" ? el("div", {}, [el("dt", {}, "Columns"), el("dd", {}, titleCase(resource.boardDimension))]) : ""
      ]),
      planningResourceAssignment(client, resource, workItems, {onSaved}),
      planningResourceCustomFieldsForm(client, resource, capabilities, {onSaved}),
      remove
    ]);
  }));
}

export function scheduleProjectControl(client, project, {onSaved} = {}) {
  const run = el("button", {class: "button button--primary", type: "button"}, "Recalculate automatic schedule");
  const host = el("div", {class: "editor-form"}, [
    el("p", {}, "Use the default work calendar, dependency lags, estimates, and hierarchy to update automatic tasks and roll up parent totals."),
    run
  ]);
  run.addEventListener("click", async () => {
    run.disabled = true;
    try {
      const result = await client.planning.schedule(project.id);
      saveStatus(host, `${result.updates.length} tasks scheduled.${result.warnings.length ? ` ${result.warnings.join(" ")}` : ""}`, result.warnings.length ? "warning" : "ok");
      onSaved?.(result);
    } catch (error) {
      saveStatus(host, error.message, "error");
    } finally {
      run.disabled = false;
    }
  });
  return host;
}

function planningMetricGrid(items) {
  return el("div", {class: "card-grid"}, items.map((item) => el("article", {class: "metric-card"}, [
    el("span", {}, item.label),
    el("strong", {}, String(item.value ?? 0))
  ])));
}

export function baselineComparisonView(comparison) {
  if (!comparison) return emptyView("Choose a baseline to compare current work.");
  return el("div", {}, [
    comparison.range ? el("p", {}, `Comparing end of ${comparison.range.from} with end of ${comparison.range.to}.`) : "",
    comparison.historyComplete === false ? el("p", {class: "status status--warning", role: "status"}, "Some older activity predates historical snapshots; affected changes are listed with incomplete coverage.") : "",
    planningMetricGrid([
      {label: "Changed", value: comparison.summary.changed},
      {label: "Added", value: comparison.summary.added},
      {label: "Removed", value: comparison.summary.removed},
      {label: "Unchanged", value: comparison.summary.unchanged}
    ]),
    dataTable(["Task", "Change", "Fields"], comparison.items.map((item) => [item.title ?? item.previous?.title ?? item.id, badge(item.change, item.change === "changed" ? "warning" : item.change === "added" ? "good" : "neutral"), (item.changes ?? []).map(titleCase).join(", ") || "—"]))
  ]);
}

export function historicalBaselineForm(client, project) {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(`${today}T00:00:00.000Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const form = el("form", {class: "inline-form"}, [
    field("Compare from", el("input", {name: "from", type: "date", value: yesterday.toISOString().slice(0, 10), max: today, required: "true"})),
    field("Through", el("input", {name: "to", type: "date", value: today, max: today, required: "true"})),
    el("button", {class: "button button--primary", type: "submit"}, "Compare history")
  ]);
  const result = el("div", {}, emptyView("Choose any retained historical date range, including yesterday, to compare task state."));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      const values = new FormData(form);
      const comparison = await client.planning.baselineComparison(project.id, {from: values.get("from"), to: values.get("to")});
      result.replaceChildren(baselineComparisonView(comparison));
    } catch (error) {
      saveStatus(form, error.message, "error");
    } finally {
      button.disabled = false;
    }
  });
  return el("div", {class: "editor-form editor-form--wide"}, [form, result]);
}

export function sprintBurndownView(burndown) {
  if (!burndown) return emptyView("Choose a dated sprint to view burndown.");
  return el("div", {}, [
    planningMetricGrid([
      {label: "Committed", value: burndown.totalPoints},
      {label: "Completed", value: burndown.completedPoints},
      {label: "Remaining", value: burndown.remainingPoints}
    ]),
    dataTable(["Date", "Ideal remaining", "Actual remaining"], burndown.series.map((point) => [point.date, String(point.idealRemaining), point.actualRemaining === undefined ? "—" : String(point.actualRemaining)]))
  ]);
}

export function activityCommentForm(client, project, workItems = [], {onSaved} = {}) {
  const entityOptions = [
    {value: project.id, label: project.name},
    ...workItems.map((item) => ({value: item.id, label: item.title}))
  ];
  const form = el("form", {class: "editor-form editor-form--wide"}, [
    field("Record", selectInput("entityId", entityOptions, project.id)),
    field("Comment", textareaInput("summary", "Use Markdown for decisions, blockers, checklists, or handoffs.")),
    field("Reply to activity ID", textInput("parentId", "Optional activity ID")),
    field("Mention user IDs", textInput("mentions", "user-one, user-two")),
    field("Reactions", textInput("reactions", "👍, ✅")),
    field("Visibility", selectInput("visibility", [{value: "project", label: "Everyone with project access"}, {value: "internal", label: "Project managers only"}], "project")),
    field("Personal reminder", el("input", {name: "reminderAt", type: "datetime-local"})),
    el("button", {class: "button button--primary", type: "submit"}, "Add note")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formValues(form);
    const entityId = data.entityId || project.id;
    try {
      await client.activity.create({
        projectId: project.id,
        entityType: entityId === project.id ? "project" : "work-item",
        entityId,
        summary: data.summary,
        parentId: data.parentId,
        mentions: csvValues(data.mentions),
        reactions: csvValues(data.reactions),
        visibility: data.visibility,
        format: "markdown",
        reminderAt: data.reminderAt ? new Date(data.reminderAt).toISOString() : undefined
      }, {idempotencyKey: crypto.randomUUID()});
      form.reset();
      saveStatus(form, "Note added.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function projectStatusUpdateForm(client, project, {onSaved} = {}) {
  const form = el("form", {class: "editor-form editor-form--wide"}, [
    field("Health", selectInput("health", healthStateList, project.health ?? "on-track")),
    field("Status", selectInput("status", projectStatusList, project.status ?? "active")),
    field("Target", el("input", {name: "targetDate", type: "date", value: formatDate(project.targetDate)})),
    field("Message", textareaInput("summary", "What changed, what is blocked, and what happens next?")),
    el("button", {class: "button button--primary", type: "submit"}, "Share update")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formValues(form);
    try {
      await client.projects.patch(project.id, {
        health: data.health,
        status: data.status,
        targetDate: data.targetDate,
        version: project.version
      });
      if (data.summary) {
        await client.activity.create({
          projectId: project.id,
          entityType: "project",
          entityId: project.id,
          summary: data.summary
        }, {idempotencyKey: crypto.randomUUID()});
      }
      saveStatus(form, "Status update shared.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function activityList(items) {
  return dataTable(["Time", "Actor", "Event", "Summary"], items.map((item) => [
    item.timestamp ? `${String(item.timestamp).slice(0, 10)} ${String(item.timestamp).slice(11, 16)} UTC` : "Unknown",
    item.actorName ?? item.actorId,
    (() => {
      const href = item.projectId && item.entityType === "work-item"
        ? projectHref(item.projectId, item.entityId)
        : item.projectId && item.entityType === "project"
          ? projectHref(item.projectId)
          : item.projectId && item.entityType === "meeting"
            ? `/app/meetings?projectId=${encodeURIComponent(item.projectId)}&meetingId=${encodeURIComponent(item.entityId)}`
            : item.projectId && item.entityType === "document"
              ? `/app/documents?projectId=${encodeURIComponent(item.projectId)}`
              : item.projectId && item.entityType === "time-entry"
                ? `/app/time?projectId=${encodeURIComponent(item.projectId)}`
                : item.entityType === "saved-view" ? "/app/planning" : "";
      const label = titleCase(String(item.eventType ?? "Activity").replaceAll(".", " "));
      return href ? el("a", {href}, label) : label;
    })(),
    el("div", {class: "activity-summary"}, [
      item.parentId ? el("small", {}, `Reply to ${item.parentId}`) : "",
      el("span", {}, item.summary),
      item.mentions?.length ? el("small", {}, `Mentions: ${item.mentions.join(", ")}`) : "",
      item.reactions?.length ? el("small", {}, `Reactions: ${item.reactions.join(" ")}`) : "",
      item.reminderAt ? el("small", {}, `Reminder: ${String(item.reminderAt).replace("T", " ").slice(0, 16)} UTC`) : "",
      item.visibility === "internal" ? badge("Project managers", "warning") : "",
      item.changedFields?.length && !item.eventType?.startsWith("comment.") ? el("small", {}, `Changed: ${item.changedFields.map(titleCase).join(", ")}`) : ""
    ])
  ]));
}

export function globalSearchForm(query = "") {
  return el("form", {class: "filter-form", method: "get", action: "/app/search"}, [
    field("Search the workspace", el("input", {type: "search", name: "q", value: query, placeholder: "Projects, tasks, meetings, and document metadata", required: "true", maxlength: "200"})),
    el("button", {class: "button button--primary", type: "submit"}, "Search")
  ]);
}

export function globalSearchResults(items = [], query = "") {
  if (!query) return emptyView("Enter a search term to find workspace records.");
  if (!items.length) return emptyView(`No workspace records match “${query}”.`);
  return el("section", {class: "search-results"}, items.map((item) => {
    const href = item.type === "project"
      ? projectHref(item.projectId)
      : item.type === "work-item"
        ? projectHref(item.projectId, item.id)
        : item.type === "meeting"
          ? `/app/meetings?projectId=${encodeURIComponent(item.projectId)}&meetingId=${encodeURIComponent(item.id)}`
          : ["wiki-page", "news", "forum-topic", "collaborative-document"].includes(item.type)
            ? `/app/content?projectId=${encodeURIComponent(item.projectId)}&contentId=${encodeURIComponent(item.id)}`
            : `/app/documents?projectId=${encodeURIComponent(item.projectId)}&search=${encodeURIComponent(item.title)}`;
    return el("article", {class: "search-result"}, [
      el("div", {class: "section-heading"}, [el("a", {href}, item.title), badge(titleCase(item.type), "neutral")]),
      item.summary ? el("p", {}, item.summary) : "",
      item.updatedAt ? el("small", {}, `Updated ${formatDate(item.updatedAt)}`) : ""
    ]);
  }));
}

export function notificationCenter(center = {}, client, {onSaved = () => location.reload(), filter = center.filter ?? "all"} = {}) {
  const items = Array.isArray(center) ? center : center.items ?? [];
  const groups = Array.isArray(center) ? items.map((item) => ({...item, events: [item], eventIds: [item.id], reasons: item.reasons ?? [item.notificationType], totalCount: 1, unreadCount: Number(item.unread !== false)})) : center.groups ?? [];
  const summary = Array.isArray(center) ? {totalCount: items.length, unreadCount: items.filter((item) => item.unread !== false).length} : center.summary ?? {};
  const toolbar = el("div", {class: "section-heading"}, [
    el("nav", {class: "button-group", "aria-label": "Notification filters"}, ["all", "unread", "read"].map((value) => el("a", {
      class: `button${filter === value ? " button--primary" : ""}`,
      href: `/app/notifications?filter=${value}`,
      "aria-current": filter === value ? "page" : undefined
    }, `${titleCase(value)}${value === "unread" ? ` (${summary.unreadCount ?? 0})` : ""}`))),
    client && summary.unreadCount ? el("button", {class: "button", type: "button", dataset: {action: "read-all"}}, "Mark all read") : ""
  ]);
  const body = groups.length ? dataTable(["Status", "Latest activity", "Record", "Reason", "Actions"], groups.map((group) => {
    const unread = Number(group.unreadCount ?? 0) > 0;
    const open = group.projectId && group.entityType === "work-item"
      ? el("a", {href: projectHref(group.projectId, group.entityId)}, "Open task")
      : group.projectId ? el("a", {href: projectHref(group.projectId)}, "Open project") : "Workspace";
    const action = client ? el("button", {class: "button", type: "button"}, unread ? "Mark read" : "Mark unread") : "";
    action?.addEventListener?.("click", async () => {
      action.disabled = true;
      try {
        await client.notifications.markRead(group.eventIds, unread);
        onSaved();
      } catch (error) {
        action.disabled = false;
        saveStatus(action.parentElement, error.message, "error");
      }
    });
    return [
      unread ? badge(`${group.unreadCount} unread`, "info") : badge("Read", "neutral"),
      el("div", {class: "activity-summary"}, [el("span", {}, group.latestSummary ?? group.summary), el("small", {}, `${formatDate(group.latestAt ?? group.timestamp)} · ${group.totalCount ?? 1} event${Number(group.totalCount ?? 1) === 1 ? "" : "s"}`)]),
      open,
      el("div", {class: "badge-list"}, (group.reasons ?? []).map((reason) => badge(titleCase(reason), reason === "reminder" ? "warning" : "neutral"))),
      action
    ];
  })) : emptyActionView(filter === "all" ? "You’re caught up" : `No ${filter} notifications`, "Assignments, task participation, mentions, and personal reminders appear here.", {label: "Open my tasks", href: "/app/work"});
  const view = el("div", {}, [toolbar, body]);
  view.querySelector('[data-action="read-all"]')?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      await client.notifications.markAllRead();
      onSaved();
    } catch (error) {
      event.currentTarget.disabled = false;
      saveStatus(toolbar, error.message, "error");
    }
  });
  return view;
}

export function notificationPreferencesForm(preferences = {}, client, webhooks = [], projects = [], {onSaved = () => location.reload()} = {}) {
  const supportedWebhooks = webhooks.filter((item) => item.enabled !== false && ((item.eventTypes ?? item.events ?? []).includes("notification.digest") || (item.eventTypes ?? item.events ?? []).includes("*")));
  const overrides = new Map((preferences.projectOverrides ?? []).map((item) => [item.projectId, item]));
  const form = el("form", {class: "editor-form editor-form--wide"}, [
    field("Notify me when I am", multiSelectInput("participationRules", [
      {value: "assigned", label: "Assigned"},
      {value: "accountable", label: "Accountable"},
      {value: "watching", label: "Watching"}
    ], preferences.participationRules ?? [])),
    field("Date alerts", el("span", {class: "check-row"}, [
      el("input", {name: "dateAlertsEnabled", type: "checkbox", checked: preferences.dateAlertsEnabled === false ? undefined : "true"}),
      " Include configured upcoming and overdue alerts"
    ])),
    field("Email summary", selectInput("emailDigest", ["none", "daily", "weekly"], preferences.emailDigest ?? "none")),
    field("Email delivery gateway", selectInput("deliveryWebhookId", [{value: "", label: "No gateway"}, ...supportedWebhooks.map((item) => ({value: item.id, label: item.name ?? item.id}))], preferences.deliveryWebhookId ?? "")),
    field("Delivery hour (UTC)", selectInput("digestHourUtc", Array.from({length: 24}, (_, hour) => ({value: String(hour), label: `${String(hour).padStart(2, "0")}:00 UTC`})), String(preferences.digestHourUtc ?? 8))),
    field("Weekly delivery day", selectInput("weeklyDay", [
      {value: "0", label: "Sunday"}, {value: "1", label: "Monday"}, {value: "2", label: "Tuesday"}, {value: "3", label: "Wednesday"},
      {value: "4", label: "Thursday"}, {value: "5", label: "Friday"}, {value: "6", label: "Saturday"}
    ], String(preferences.weeklyDay ?? 1))),
    projects.length ? el("details", {class: "advanced-panel"}, [
      el("summary", {}, [el("span", {}, "Project-specific participation"), el("small", {}, `${overrides.size} override${overrides.size === 1 ? "" : "s"}`)]),
      el("div", {class: "editor-form"}, projects.map((project) => {
        const override = overrides.get(project.id);
        return el("div", {class: "check-row"}, [
          el("label", {}, [el("input", {type: "checkbox", name: "overrideProjectIds", value: project.id, checked: override ? "true" : undefined}), ` ${project.name}`]),
          multiSelectInput(`projectRules:${project.id}`, ["assigned", "accountable", "watching"], override?.participationRules ?? preferences.participationRules ?? [])
        ]);
      }))
    ]) : "",
    preferences.scheduledDeliveryAvailable === false ? el("p", {class: "status status--warning"}, "Scheduled delivery is disabled for this deployment. Enable the notification worker before choosing daily or weekly summaries.") : "",
    el("button", {class: "button button--primary", type: "submit"}, "Save notification preferences")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = new FormData(form);
    const projectOverrides = values.getAll("overrideProjectIds").map((projectId) => ({
      projectId: String(projectId),
      participationRules: values.getAll(`projectRules:${projectId}`).map(String).filter(Boolean)
    }));
    const body = {
      version: preferences.version,
      participationRules: values.getAll("participationRules").map(String).filter(Boolean),
      projectOverrides,
      dateAlertsEnabled: values.has("dateAlertsEnabled"),
      emailDigest: values.get("emailDigest"),
      deliveryWebhookId: values.get("deliveryWebhookId"),
      digestHourUtc: Number(values.get("digestHourUtc")),
      weeklyDay: Number(values.get("weeklyDay"))
    };
    try {
      await client.notifications.savePreferences(body);
      saveStatus(form, "Notification preferences saved.", "ok");
      onSaved();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function notificationDigestView(digest = {}, client, webhooks = [], preferences = {}) {
  const supportedWebhooks = webhooks.filter((item) => item.enabled !== false && ((item.eventTypes ?? item.events ?? []).includes("notification.digest") || (item.eventTypes ?? item.events ?? []).includes("*")));
  const delivery = el("form", {class: "inline-form"}, [
    field("Email delivery webhook", selectInput("webhookId", [{value: "", label: "Use saved gateway"}, ...supportedWebhooks.map((item) => ({value: item.id, label: item.name ?? item.id}))], preferences.deliveryWebhookId ?? "")),
    el("button", {class: "button", type: "submit", disabled: digest.frequency === "none" || !supportedWebhooks.length ? "true" : undefined}, "Send digest now")
  ]);
  delivery.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await client.notifications.deliverDigest({webhookId: new FormData(delivery).get("webhookId")});
      saveStatus(delivery, `Digest ${result.delivery.status}.`, result.delivery.status === "delivered" ? "ok" : "error");
    } catch (error) {
      saveStatus(delivery, error.message, "error");
    }
  });
  return el("section", {}, [
    dataTable(["Digest signal", "Value"], [
      ["Frequency", titleCase(digest.frequency ?? "none")],
      ["Upcoming or overdue alerts", digest.summary?.dateAlertCount ?? 0],
      ["Participating tasks", digest.summary?.participatedCount ?? 0],
      ["Notification events", digest.summary?.notificationCount ?? 0]
    ]),
    (digest.dateAlerts ?? []).length ? dataTable(["Rule", "Task", "Due", "Timing"], digest.dateAlerts.map((alert) => [alert.ruleName, el("a", {href: projectHref(alert.workItem.projectId, alert.workItem.id)}, alert.workItem.title), formatDate(alert.workItem.dueDate), alert.daysUntilDue < 0 ? `${Math.abs(alert.daysUntilDue)} days overdue` : alert.daysUntilDue === 0 ? "Due today" : `Due in ${alert.daysUntilDue} days`])) : emptyView("No configured date alerts are due."),
    delivery
  ]);
}

export function applyWorkspaceCapabilities(capabilities = {}) {
  const branding = capabilities.branding ?? {};
  const root = document.documentElement;
  if (/^#[0-9a-f]{6}$/i.test(branding.primaryColor ?? "")) root.style.setProperty("--workspace-primary", branding.primaryColor);
  else root.style.removeProperty("--workspace-primary");
  if (/^#[0-9a-f]{6}$/i.test(branding.accentColor ?? "")) root.style.setProperty("--workspace-accent", branding.accentColor);
  else root.style.removeProperty("--workspace-accent");
  if (branding.organizationName) document.title = `${branding.organizationName} · Team Spaces`;
  try {
    localStorage.setItem("teamspaces.workspaceBranding", JSON.stringify(branding));
  } catch {
    // Branding remains active for this page when storage is unavailable.
  }
  const brand = document.querySelector(".app-header__brand");
  const brandName = brand?.querySelector("strong");
  if (brandName) brandName.textContent = branding.organizationName || "Team Spaces";
  let brandLogo = brand?.querySelector(".app-header__brand-logo");
  if (branding.logoUrl && /^https:\/\//.test(branding.logoUrl) && brand) {
    if (!brandLogo) {
      brandLogo = el("img", {class: "app-header__brand-logo", alt: ""});
      brand.prepend(brandLogo);
    }
    brandLogo.setAttribute("src", branding.logoUrl);
  } else brandLogo?.remove();
  if (branding.faviconUrl && /^https:\/\//.test(branding.faviconUrl)) {
    const favicon = document.querySelector('link[rel="icon"]');
    favicon?.setAttribute("href", branding.faviconUrl);
    let touchIcon = document.querySelector('link[rel="apple-touch-icon"]');
    if (!touchIcon) {
      touchIcon = el("link", {rel: "apple-touch-icon"});
      document.head.append(touchIcon);
    }
    touchIcon.setAttribute("href", branding.touchIconUrl && /^https:\/\//.test(branding.touchIconUrl) ? branding.touchIconUrl : branding.faviconUrl);
  }
}

export function workspaceCapabilitiesSummary(capabilities = {}) {
  const counts = [
    ["Dashboard widgets", capabilities.dashboard?.widgets?.length ?? 0],
    ["Lifecycle phases", capabilities.lifecycle?.phases?.length ?? 0],
    ["Typed fields", capabilities.customFields?.length ?? 0],
    ["Forms and actions", (capabilities.forms?.length ?? 0) + (capabilities.customActions?.length ?? 0)],
    ["Groups and roles", (capabilities.groups?.length ?? 0) + (capabilities.customRoles?.length ?? 0)],
    ["Budgets and reports", (capabilities.finance?.budgets?.length ?? 0) + (capabilities.finance?.reportDefinitions?.length ?? 0)],
    ["Connectors", capabilities.connectors?.length ?? 0],
    ["Webhooks", capabilities.webhooks?.length ?? 0]
  ];
  return el("div", {}, [
    dataTable(["Capability area", "Configured records"], counts.map(([name, count]) => [name, String(count)])),
    el("div", {class: "badge-row"}, [
      badge(capabilities.authentication?.mfaRequired ? "MFA required" : "MFA optional", capabilities.authentication?.mfaRequired ? "good" : "neutral"),
      badge(`Malware scan ${capabilities.security?.malwareScanning ?? "unknown"}`, capabilities.security?.malwareScanning === "required" ? "good" : "warning"),
      badge(`External links ${capabilities.outboundLinks?.policy ?? "warn"}`, "info"),
      badge(capabilities.mcp?.enabled ? "MCP enabled" : "MCP disabled", capabilities.mcp?.enabled ? "good" : "neutral")
    ])
  ]);
}

export function workspaceCapabilitiesEditor(client, capabilities, {onSaved} = {}) {
  const editable = Object.fromEntries(Object.entries(capabilities).filter(([key]) => !["workspaceId", "createdAt", "updatedAt", "updatedBy"].includes(key)));
  const editor = el("textarea", {name: "capabilities", rows: "34", spellcheck: "false", class: "code-editor"}, JSON.stringify(editable, null, 2));
  const save = el("button", {class: "button button--primary", type: "submit"}, "Save capability configuration");
  const form = el("form", {class: "editor-form editor-form--wide"}, [
    el("p", {}, "Configure dashboard templates, lifecycle gates, typed fields and forms, custom actions, groups and roles, finance, resource profiles, branding, identity providers, notification rules, webhooks, repositories, connectors, sharing, link controls, upload security, SCIM, MCP, and task policies. Credential values must be stored externally and referenced by name."),
    field("Versioned workspace capability document", editor),
    save
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const payload = JSON.parse(editor.value);
      payload.version = capabilities.version;
      const saved = await client.capabilities.patch(payload);
      applyWorkspaceCapabilities(saved);
      saveStatus(form, `Capability configuration saved as version ${saved.version}.`, "ok");
      onSaved?.(saved);
    } catch (error) {
      saveStatus(form, error.message, "error");
    } finally {
      save.disabled = false;
    }
  });
  return form;
}

export function costReportView(report = {}) {
  const money = (value) => new Intl.NumberFormat(undefined, {style: "currency", currency: report.currency ?? "USD"}).format(Number(value ?? 0));
  return el("div", {}, [
    report.definition ? el("p", {class: "view-summary"}, `Configured report: ${report.definition.name} · grouped by ${titleCase(report.definition.groupBy)}`) : "",
    planningMetricGrid([
      {label: "Budget", value: money(report.totals?.budget)},
      {label: "Planned labor", value: money(report.totals?.plannedLaborCost)},
      {label: "Actual cost", value: money(report.totals?.actualCost)},
      {label: "Variance", value: money(report.totals?.variance)}
    ]),
    dataTable(["Project", "Budget", "Planned labor", "Actual labor", "Unit cost", "Variance"], (report.projects ?? []).map((row) => [row.projectName, money(row.budget), money(row.plannedLaborCost), money(row.actualLaborCost), money(row.unitCost), money(row.variance)]))
  ]);
}

export function costReportDefinitionFilter(report = {}, selected = "") {
  if (!(report.availableDefinitions ?? []).length) return el("p", {class: "view-summary"}, "Add finance.reportDefinitions in workspace capabilities to publish reusable cost-report filters.");
  return el("form", {class: "filter-form", method: "get", action: "/app/reports"}, [
    field("Saved cost report", selectInput("definitionId", [{value: "", label: "All projects"}, ...report.availableDefinitions.map((item) => ({value: item.id, label: item.name}))], selected)),
    el("button", {class: "button button--primary", type: "submit"}, "Run report")
  ]);
}

export function resourcePlanView(plan = {}) {
  return el("div", {}, [
    planningMetricGrid([
      {label: "Net capacity", value: formatHours(plan.summary?.capacityMinutes)},
      {label: "Allocated", value: formatHours(plan.summary?.allocatedMinutes)},
      {label: "Available", value: formatHours(plan.summary?.availableMinutes)},
      {label: "Overallocated", value: formatHours(plan.summary?.overallocatedMinutes)}
    ]),
    el("p", {class: "view-summary"}, `Week ${plan.weekStart ?? "—"} – ${plan.weekEnd ?? "—"}. Capacity is reduced by time off before planned allocations and active task effort are applied.`),
    dataTable(["Person", "Skills", "Net capacity", "Planned", "Task effort", "Available", "Utilization", "Projects"], (plan.items ?? []).map((item) => [
      el("div", {class: "object-cell"}, [el("strong", {}, item.name), item.placeholder ? badge("Placeholder", "neutral") : "", item.overallocatedMinutes ? badge(`${formatHours(item.overallocatedMinutes)} over`, "warning") : ""]),
      (item.skills ?? []).join(", ") || "—",
      el("div", {class: "object-cell"}, [formatHours(item.capacityMinutes), item.timeOffMinutes ? el("small", {}, `${formatHours(item.timeOffMinutes)} time off`) : ""]),
      formatHours(item.configuredMinutes),
      el("div", {class: "object-cell"}, [formatHours(item.taskMinutes), el("small", {}, `${item.assignedWorkItemCount ?? 0} active tasks`)]),
      formatHours(item.availableMinutes),
      `${item.utilizationPercent}%`,
      (item.projectIds ?? []).map((id) => plan.projects?.find((project) => project.id === id)?.name ?? id).join(", ") || "—"
    ]))
  ]);
}

export function resourcePlannerControls(client, plan = {}, {onSaved = () => location.reload(), canManage = false} = {}) {
  const projects = plan.projects ?? [];
  const people = plan.memberships ?? [];
  const weekStart = plan.weekStart ?? new Date().toISOString().slice(0, 10);
  const weekEnd = plan.weekEnd ?? weekStart;
  const filter = el("form", {class: "filter-form", method: "get", action: "/app/reports"}, [
    field("Week", el("input", {name: "week", type: "date", value: plan.filters?.week ?? weekStart})),
    field("Project", selectInput("projectId", [{value: "", label: "All projects"}, ...projects.map((project) => ({value: project.id, label: project.name}))], plan.filters?.projectId ?? "")),
    field("Required skill", textInput("skill", "Optional exact skill", plan.filters?.skill ?? "")),
    el("button", {class: "button button--primary", type: "submit"}, "Plan week")
  ]);
  if (!canManage) return filter;
  const personOptions = people.map((person) => ({value: person.userId, label: person.name}));
  const projectOptions = projects.map((project) => ({value: project.id, label: project.name}));
  const submit = (form, action, success) => form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(form).entries());
      data.version = plan.version;
      if (data.hours !== undefined) {
        data.minutes = Math.round(Number(data.hours) * 60);
        delete data.hours;
      } else if (data.minutes !== undefined) data.minutes = Number(data.minutes);
      data.weeklyMinutes = Number(data.weeklyMinutes);
      if (typeof data.skills === "string") data.skills = data.skills.split(",").map((item) => item.trim()).filter(Boolean);
      await action(data);
      saveStatus(form, success, "ok");
      onSaved();
    } catch (error) {
      saveStatus(form, error.message, "error");
      button.disabled = false;
    }
  });
  const allocation = el("form", {class: "editor-form"}, [
    field("Person", selectInput("userId", personOptions, personOptions[0]?.value)),
    field("Project", selectInput("projectId", projectOptions, plan.filters?.projectId ?? projectOptions[0]?.value)),
    field("From", el("input", {name: "startDate", type: "date", value: weekStart, required: "true"})),
    field("Through", el("input", {name: "endDate", type: "date", value: weekEnd, required: "true"})),
    field("Planned hours", el("input", {name: "hours", type: "number", min: "0", max: "1666", step: "0.5", value: "8", required: "true"})),
    field("Note", textInput("note", "Role or staffing rationale")),
    el("button", {class: "button button--primary", type: "submit"}, "Add allocation")
  ]);
  submit(allocation, (data) => client.resourcePlanner.saveAllocation(data), "Allocation saved.");
  const profile = el("form", {class: "editor-form"}, [
    field("Person", selectInput("userId", personOptions, personOptions[0]?.value)),
    field("Weekly minutes", el("input", {name: "weeklyMinutes", type: "number", min: "0", max: "10080", step: "30", value: "2400", required: "true"})),
    field("Skills", textInput("skills", "design, facilitation, backend")),
    el("button", {class: "button button--primary", type: "submit"}, "Save profile")
  ]);
  submit(profile, (data) => client.resourcePlanner.saveProfile(data), "Capacity profile saved.");
  const timeOff = el("form", {class: "editor-form"}, [
    field("Person", selectInput("userId", personOptions, personOptions[0]?.value)),
    field("From", el("input", {name: "startDate", type: "date", value: weekStart, required: "true"})),
    field("Through", el("input", {name: "endDate", type: "date", value: weekStart, required: "true"})),
    field("Hours off", el("input", {name: "hours", type: "number", min: "0", max: "1666", step: "0.5", value: "8", required: "true"})),
    field("Note", textInput("note", "Vacation, holiday, or other leave")),
    el("button", {class: "button button--primary", type: "submit"}, "Add time off")
  ]);
  submit(timeOff, (data) => client.resourcePlanner.saveTimeOff(data), "Time off saved.");
  const removableRows = (records, remove) => [...new Map(records.map((item) => [item.id, item])).values()].map((item) => {
    const button = el("button", {class: "button button--danger", type: "button"}, "Remove");
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await remove(item.id, plan.version);
        onSaved();
      } catch (error) {
        button.disabled = false;
        saveStatus(button.parentElement, error.message, "error");
      }
    });
    return [people.find((person) => person.userId === item.userId)?.name ?? item.userId, item.projectId ? projects.find((project) => project.id === item.projectId)?.name ?? item.projectId : "Time off", `${item.startDate} – ${item.endDate}`, formatHours(item.minutes), item.note || "—", button];
  });
  const allocationRows = removableRows((plan.items ?? []).flatMap((item) => item.allocations ?? []), (id, version) => client.resourcePlanner.deleteAllocation(id, version));
  const timeOffRows = removableRows((plan.items ?? []).flatMap((item) => item.timeOff ?? []), (id, version) => client.resourcePlanner.deleteTimeOff(id, version));
  return el("div", {}, [filter, toolbar([
    actionPanel("Plan allocation", allocation, {meta: "Person, project, dates, effort"}),
    actionPanel("Capacity and skills", profile, {meta: "Weekly availability and matching"}),
    actionPanel("Time off", timeOff, {meta: "Reduce net weekly capacity"})
  ]), allocationRows.length || timeOffRows.length ? dataTable(["Person", "Scope", "Dates", "Effort", "Note", "Actions"], [...allocationRows, ...timeOffRows]) : emptyView("No configured allocations or time off overlap this week.")]);
}

export function securityBadgeView(security = {}) {
  return el("div", {}, [
    el("div", {class: "badge-row"}, [badge(security.status ?? "unknown", security.status === "secure" ? "good" : security.status === "review" ? "warning" : "danger"), el("strong", {}, `${security.passed ?? 0}/${security.total ?? 0} controls passing`)]),
    dataTable(["Control", "Status"], Object.entries(security.checks ?? {}).map(([name, passed]) => [titleCase(name), badge(passed ? "Passing" : "Review", passed ? "good" : "warning")]))
  ]);
}

export function workspaceSettingsForm(client, workspace, {onSaved} = {}) {
  const form = el("form", {class: "editor-form"}, [
    field("Workspace name", textInput("name", "Team Spaces Pilot", workspace.name ?? "")),
    field("Account type", selectInput("accountType", accountTypeOptions, workspace.accountType ?? "team")),
    field("Project prefix", textInput("defaultProjectPrefix", "TS", workspace.defaultProjectPrefix ?? "")),
    field("Retention days", el("input", {name: "dataRetentionDays", type: "number", min: "0", max: "3650", value: String(workspace.dataRetentionDays ?? 0)})),
    el("button", {class: "button button--primary", type: "submit"}, "Save workspace")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      await client.workspace.patch(data);
      saveStatus(form, "Workspace saved.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function accountSwitcher(client, accounts = [], currentAccountId = "", {onSaved} = {}) {
  const form = el("form", {class: "editor-form"}, [
    field("Current account", selectInput("accountId", accounts.map((account) => ({
      value: account.workspaceId,
      label: `${account.workspace?.name ?? account.workspaceId}${account.workspace?.accountType ? ` (${titleCase(account.workspace.accountType)})` : ""}`
    })), currentAccountId)),
    el("button", {class: "button button--primary", type: "submit"}, "Switch account")
  ]);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    client.accounts.select(data.accountId);
    saveStatus(form, "Account selected. Reloading workspace.", "ok");
    onSaved?.();
  });
  return form;
}

export function accountCreateForm(client, {onSaved} = {}) {
  const form = el("form", {class: "editor-form editor-form--wide"}, [
    field("Account name", textInput("name", "Client portfolio")),
    field("Account type", selectInput("accountType", accountTypeOptions, "client")),
    field("Project prefix", textInput("defaultProjectPrefix", "CP")),
    el("button", {class: "button button--primary", type: "submit"}, "Create account")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      const account = await client.accounts.create(data, {idempotencyKey: crypto.randomUUID()});
      client.accounts.select(account.id);
      saveStatus(form, "Account created. Reloading workspace.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

function accountLabel(account) {
  return account.workspace?.name ?? account.name ?? account.workspaceId ?? account.id ?? "Account";
}

function accountTypeLabel(account) {
  return titleCase(account.workspace?.accountType ?? account.accountType ?? "team");
}

function accountId(account) {
  return account.workspaceId ?? account.id ?? account.workspace?.id ?? "";
}

function accountCard(client, account, currentAccountId, {onSaved} = {}) {
  const id = accountId(account);
  const isCurrent = id === currentAccountId;
  const switchButton = el("button", {class: "button", type: "button"}, isCurrent ? "Current account" : "Switch");
  if (isCurrent) switchButton.disabled = true;
  switchButton.addEventListener("click", () => {
    client.accounts.select(id);
    onSaved?.();
  });
  return el("article", {class: `account-card${isCurrent ? " account-card--current" : ""}`}, [
    el("div", {class: "account-card__heading"}, [
      el("div", {class: "object-cell"}, [
        el("strong", {}, accountLabel(account)),
        el("span", {}, `${accountTypeLabel(account)} account`)
      ]),
      isCurrent ? badge("Current", "good") : badge(account.role ?? "member", "neutral")
    ]),
    el("dl", {class: "account-card__facts"}, [
      el("div", {}, [el("dt", {}, "Your role"), el("dd", {}, titleCase(account.role ?? "viewer"))]),
      el("div", {}, [el("dt", {}, "Status"), el("dd", {}, titleCase(account.status ?? "active"))]),
      el("div", {}, [el("dt", {}, "Project scope"), el("dd", {}, account.projectIds?.length ? `${account.projectIds.length} projects` : "All projects")])
    ]),
    switchButton
  ]);
}

export function accountManagementPanel(client, {accounts = [], currentAccountId = "", workspace = {}, onSaved, showHeading = true} = {}) {
  const current = accounts.find((account) => accountId(account) === currentAccountId);
  return el("section", {class: "account-management", id: "accounts"}, [
    showHeading ? el("div", {class: "section-heading"}, [
      el("div", {}, [
        el("h2", {}, "Accounts"),
        el("p", {}, "Account boundaries separate personal workspaces, internal teams, and client portfolios.")
      ])
    ]) : "",
    el("div", {class: "active-account"}, [
      el("div", {class: "object-cell"}, [
        el("strong", {}, current ? accountLabel(current) : workspace.name ?? "Current account"),
        el("span", {}, `${titleCase(workspace.accountType ?? current?.workspace?.accountType ?? "team")} account`)
      ]),
      badge(current?.role ?? "workspace-admin", "info")
    ]),
    accounts.length
      ? el("div", {class: "account-grid"}, accounts.map((account) => accountCard(client, account, currentAccountId, {onSaved})))
      : emptyView("No accounts are available for this user."),
    el("div", {class: "account-management__forms"}, [
      el("details", {class: "advanced-panel", id: "create-account"}, [
        el("summary", {}, [el("span", {}, "Create account"), el("small", {}, "Personal, team, or client workspace")]),
        accountCreateForm(client, {onSaved})
      ]),
      el("details", {class: "advanced-panel", id: "account-settings"}, [
        el("summary", {}, [el("span", {}, "Edit current account"), el("small", {}, "Name, type, project prefix, retention")]),
        workspaceSettingsForm(client, workspace, {onSaved})
      ])
    ])
  ]);
}

export function profileForm(client, data, {onSaved, capabilities = {}} = {}) {
  const user = data.user ?? {};
  const membership = data.membership ?? {};
  const form = el("form", {class: "editor-form editor-form--wide"}, [
    field("Name", textInput("name", "Your name", user.name ?? membership.name ?? "")),
    field("Title", textInput("title", "Delivery lead", user.title ?? membership.title ?? "")),
    field("Department", textInput("department", "Operations", user.department ?? membership.department ?? "")),
    field("Timezone", textInput("timezone", "America/New_York", user.timezone ?? membership.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "")),
    field("Locale", textInput("locale", "en-US", user.locale ?? membership.locale ?? navigator.language ?? "")),
    ...configuredCustomFieldEditors(capabilities, membership.customFields ?? user.customFields ?? {}, "user"),
    el("button", {class: "button button--primary", type: "submit"}, "Save profile")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = formValues(form);
    values.customFields = configuredCustomFieldValues(values, capabilities, membership.customFields ?? user.customFields ?? {}, "user");
    try {
      await client.profile.patch(values);
      saveStatus(form, "Profile saved.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function memberForm(client, {onSaved, projects = [], capabilities = {}} = {}) {
  const form = el("form", {class: "editor-form editor-form--wide"}, [
    field("Email", el("input", {name: "email", type: "email", placeholder: "person@example.com"})),
    field("Name", textInput("name", "Team member")),
    field("Role", selectInput("role", roleOptions, "member")),
    field("Status", selectInput("status", ["active", "invited", "disabled"], "active")),
    field("Project access", multiSelectInput("projectIds", projects.map((project) => ({value: project.id, label: project.name})))),
    ...configuredCustomFieldEditors(capabilities, {}, "user"),
    el("button", {class: "button button--primary", type: "submit"}, "Save member")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formValues(form);
    data.customFields = configuredCustomFieldValues(data, capabilities, {}, "user");
    try {
      await client.memberships.create(data, {idempotencyKey: crypto.randomUUID()});
      form.reset();
      saveStatus(form, "Member saved.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function placeholderForm(client, {onSaved, projects = [], capabilities = {}} = {}) {
  const form = el("form", {class: "editor-form editor-form--wide"}, [
    field("Placeholder name", textInput("name", "External designer")),
    field("Weekly capacity", el("input", {name: "weeklyMinutes", type: "number", min: "0", max: "10080", value: "2400"})),
    field("Skills", textInput("skills", "design, research")),
    field("Project access", multiSelectInput("projectIds", projects.map((project) => ({value: project.id, label: project.name})))),
    ...configuredCustomFieldEditors(capabilities, {}, "user"),
    el("button", {class: "button button--primary", type: "submit"}, "Create placeholder")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = formValues(form);
    values.customFields = configuredCustomFieldValues(values, capabilities, {}, "user");
    try {
      await client.placeholders.create({...values, weeklyMinutes: Number(values.weeklyMinutes), skills: csvValues(values.skills), status: "active"});
      form.reset();
      saveStatus(form, "Placeholder created.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

function projectAccessText(projectIds = [], projectNames = new Map()) {
  if (!projectIds?.length) return "All projects";
  const names = projectIds.map((id) => projectNames.get(id) ?? id);
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} +${names.length - 3} more`;
}

function memberAccessForm(client, membership, projects = [], {onSaved, capabilities = {}} = {}) {
  const form = el("form", {class: "member-access-form"}, [
    field("Name", textInput("name", "Team member", membership.name ?? membership.user?.name ?? "")),
    field("Email", el("input", {name: "email", type: "email", value: membership.email ?? membership.user?.email ?? ""})),
    field("Role", selectInput("role", roleOptions, membership.role ?? "viewer")),
    field("Status", selectInput("status", ["active", "invited", "disabled"], membership.status ?? "active")),
    field("Project access", multiSelectInput("projectIds", projects.map((project) => ({value: project.id, label: project.name})), membership.projectIds ?? [])),
    ...configuredCustomFieldEditors(capabilities, membership.customFields ?? {}, "user"),
    el("button", {class: "button button--primary", type: "submit"}, "Save access")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formValues(form);
    data.customFields = configuredCustomFieldValues(data, capabilities, membership.customFields ?? {}, "user");
    try {
      await client.memberships.patch(membership.userId, data);
      saveStatus(form, "Member access saved.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

function teamMemberCard(client, membership, projects = [], projectNames = new Map(), {onSaved, capabilities = {}} = {}) {
  const status = membership.status ?? "active";
  return el("article", {class: `team-member-card team-member-card--${status}`}, [
    el("div", {class: "team-member-card__heading"}, [
      el("div", {class: "object-cell"}, [
        el("strong", {}, membership.name ?? membership.user?.name ?? membership.email ?? membership.userId),
        el("span", {}, membership.email ?? membership.user?.email ?? membership.userId)
      ]),
      el("div", {class: "badge-row"}, [
        membership.placeholder ? badge("Placeholder", "info") : "",
        badge(membership.role ?? "viewer", "neutral"),
        badge(status, status === "disabled" ? "danger" : status === "invited" ? "watch" : "good")
      ])
    ]),
    el("dl", {class: "team-member-card__facts"}, [
      el("div", {}, [el("dt", {}, "Project access"), el("dd", {}, projectAccessText(membership.projectIds ?? [], projectNames))]),
      el("div", {}, [el("dt", {}, "Updated"), el("dd", {}, formatDate(membership.updatedAt) || "Not saved")])
    ]),
    el("details", {class: "member-edit"}, [
      el("summary", {}, "Edit access"),
      memberAccessForm(client, membership, projects, {onSaved, capabilities})
    ])
  ]);
}

export function teamManagementPanel(client, memberships = [], projects = [], {onSaved, showHeading = true, capabilities = {}} = {}) {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  return el("section", {class: "team-management", id: "team-access"}, [
    showHeading ? el("div", {class: "section-heading"}, [
      el("div", {}, [
        el("h2", {}, "Team access"),
        el("p", {}, "Manage who can work in this account, what role they hold, and whether they see every project or only selected projects.")
      ])
    ]) : "",
    el("details", {class: "advanced-panel team-add-member", id: "add-member", open: memberships.length ? undefined : "true"}, [
      el("summary", {}, [el("span", {}, "Add member access"), el("small", {}, "Create or update a workspace membership")]),
      memberForm(client, {onSaved, projects, capabilities})
    ]),
    el("details", {class: "advanced-panel team-add-placeholder", id: "add-placeholder"}, [
      el("summary", {}, [el("span", {}, "Add placeholder"), el("small", {}, "Plan capacity before a person has an account")]),
      placeholderForm(client, {onSaved, projects, capabilities})
    ]),
    memberships.length
      ? el("div", {class: "team-directory"}, memberships.map((membership) => teamMemberCard(client, membership, projects, projectNames, {onSaved, capabilities})))
      : emptyView("No team members have been added to this account.")
  ]);
}

function configurationTextarea(name, value, rows = 7) {
  return el("textarea", {
    name,
    rows: String(rows),
    spellcheck: "false",
    autocapitalize: "off",
    autocomplete: "off"
  }, value);
}

function configurationLines(value) {
  return String(value ?? "").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

function parseConfiguredTypes(value) {
  return configurationLines(value).map((line, index) => {
    const [id = "", label = "", state = "active"] = line.split("|").map((part) => part.trim());
    if (!id || !label) throw new Error(`Type line ${index + 1} must be: id | label | active or inactive.`);
    return {id, label, active: state.toLowerCase() !== "inactive"};
  });
}

function parseConfiguredStatuses(value) {
  return configurationLines(value).map((line, index) => {
    const [id = "", label = "", state = "active", completion = "open"] = line.split("|").map((part) => part.trim());
    if (!id || !label) throw new Error(`Status line ${index + 1} must be: id | label | active or inactive | open or closed.`);
    return {
      id,
      label,
      active: state.toLowerCase() !== "inactive",
      closed: completion.toLowerCase() === "closed"
    };
  });
}

function parseConfiguredTransitions(value) {
  return configurationLines(value).map((line, index) => {
    const [edge = "", roleText = ""] = line.split("|").map((part) => part.trim());
    const [fromStatusId = "", toStatusId = ""] = edge.split("->").map((part) => part.trim());
    const roles = roleText.split(",").map((role) => role.trim()).filter(Boolean);
    if (!fromStatusId || !toStatusId || !roles.length) {
      throw new Error(`Transition line ${index + 1} must be: from-status -> to-status | role, role.`);
    }
    return {fromStatusId, toStatusId, roles};
  });
}

export function workConfigurationEditor(client, configuration = {}, {onSaved} = {}) {
  const typesInput = configurationTextarea("types", (configuration.types ?? []).map((type) => (
    `${type.id} | ${type.label} | ${type.active ? "active" : "inactive"}`
  )).join("\n"));
  const statusesInput = configurationTextarea("statuses", (configuration.statuses ?? []).map((status) => (
    `${status.id} | ${status.label} | ${status.active ? "active" : "inactive"} | ${status.closed ? "closed" : "open"}`
  )).join("\n"));
  const transitionsInput = configurationTextarea("transitions", (configuration.transitions ?? []).map((transition) => (
    `${transition.fromStatusId} -> ${transition.toStatusId} | ${(transition.roles ?? []).join(", ")}`
  )).join("\n"), 10);
  const activeTypes = (configuration.types ?? []).filter((type) => type.active);
  const activeStatuses = (configuration.statuses ?? []).filter((status) => status.active);
  const defaultType = selectInput("defaultTypeId", activeTypes.map((type) => ({value: type.id, label: type.label})), configuration.defaultTypeId);
  const defaultStatus = selectInput("defaultStatusId", activeStatuses.map((status) => ({value: status.id, label: status.label})), configuration.defaultStatusId);
  const form = el("form", {class: "editor-form editor-form--wide work-configuration-editor"}, [
    el("p", {class: "work-configuration-editor__intro"}, "IDs stay stable after creation. Rename or deactivate existing entries instead of deleting them. Transitions are enforced by role when a task status changes."),
    field("Default task type", defaultType),
    field("Initial status", defaultStatus),
    field("Types — id | label | active/inactive", typesInput),
    field("Statuses — id | label | active/inactive | open/closed", statusesInput),
    field("Transitions — from -> to | comma-separated roles", transitionsInput),
    el("p", {class: "work-configuration-editor__hint"}, `Roles: ${roleOptions.map((role) => role.value).join(", ")}.`),
    el("button", {class: "button button--primary", type: "submit"}, "Save work configuration")
  ]);

  const syncDefaults = () => {
    try {
      const nextTypes = parseConfiguredTypes(typesInput.value).filter((type) => type.active);
      const nextStatuses = parseConfiguredStatuses(statusesInput.value).filter((status) => status.active);
      replaceSelectOptions(defaultType, nextTypes.map((type) => ({value: type.id, label: type.label})), defaultType.value);
      replaceSelectOptions(defaultStatus, nextStatuses.map((status) => ({value: status.id, label: status.label})), defaultStatus.value);
    } catch {
      // Submit reports the precise line error; keep editing responsive meanwhile.
    }
  };
  typesInput.addEventListener("input", syncDefaults);
  statusesInput.addEventListener("input", syncDefaults);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const payload = {
        schemaVersion: 1,
        version: configuration.version,
        defaultTypeId: defaultType.value,
        defaultStatusId: defaultStatus.value,
        types: parseConfiguredTypes(typesInput.value),
        statuses: parseConfiguredStatuses(statusesInput.value),
        transitions: parseConfiguredTransitions(transitionsInput.value)
      };
      const saved = await client.workConfiguration.patch(payload, {idempotencyKey: crypto.randomUUID()});
      configureWorkTaxonomy(saved);
      saveStatus(form, "Work types and workflow saved.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function securityManagementPanel({workspace = {}, me = {}, showHeading = true} = {}) {
  const role = me.membership?.role ?? "viewer";
  return el("section", {class: "security-management"}, [
    showHeading ? el("div", {class: "section-heading"}, [
      el("div", {}, [
        el("h2", {}, "Security & secrets"),
        el("p", {}, "Authentication, protected storage, and secret references for this account.")
      ])
    ]) : "",
    el("div", {class: "security-grid"}, [
      el("article", {class: "security-card"}, [
        badge("Cognito", "info"),
        el("h3", {}, "Authentication"),
        el("p", {}, "Cognito hosted login"),
        miniLinks([{label: "Account profile", href: "/app/admin?section=profile"}, {label: "Team access", href: "/app/admin?section=team"}])
      ]),
      el("article", {class: "security-card"}, [
        badge("Private", "good"),
        el("h3", {}, "Documents"),
        el("p", {}, "S3 object storage scoped by account, project, and task metadata."),
        miniLinks([{label: "Document library", href: "/app/documents"}, {label: "Inventory", href: "/app/admin?section=data#document-inventory"}])
      ]),
      el("article", {class: "security-card"}, [
        badge("Hidden values", "watch"),
        el("h3", {}, "Secrets"),
        el("p", {}, "Secret values stay in AWS-managed configuration and are not displayed in the browser."),
        miniLinks([{label: "Data inventory", href: "/app/admin?section=data"}])
      ]),
      el("article", {class: "security-card"}, [
        badge(role, role === "workspace-admin" ? "good" : "neutral"),
        el("h3", {}, "Permissions"),
        el("p", {}, `${titleCase(workspace.accountType ?? "team")} account permissions are role-based and project-scoped where assigned.`),
        miniLinks([{label: "Members table", href: "/app/admin?section=data#members"}, {label: "Activity", href: "/app/admin?section=data#activity"}])
      ])
    ])
  ]);
}

export function publicDemoTeamOverview(memberships = [], projects = [], workItems = []) {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  return el("section", {class: "demo-team-overview", "aria-labelledby": "demo-team-overview-heading"}, [
    el("div", {class: "section-heading"}, [
      el("div", {}, [
        el("h2", {id: "demo-team-overview-heading"}, "Who is doing what"),
        el("p", {}, "Five fictional teammates show how roles, project access, and assignments fit together.")
      ])
    ]),
    el("div", {class: "demo-team-overview__grid"}, memberships.map((membership) => {
      const assigned = workItems.filter((item) => item.assigneeId === membership.userId && !isClosedWorkStatus(item.status));
      const blocked = assigned.filter((item) => item.status === "blocked" || item.blockedBy?.length).length;
      const scope = membership.projectIds?.length
        ? membership.projectIds.map((id) => projectNames.get(id) ?? id).join(" · ")
        : "All projects";
      return el("article", {class: "demo-team-card"}, [
        el("div", {class: "demo-team-card__heading"}, [
          el("div", {}, [el("strong", {}, membership.name ?? membership.email), membership.title ? el("span", {}, membership.title) : ""]),
          badge(titleCase(membership.role ?? "member"), membership.role === "workspace-admin" ? "good" : "neutral")
        ]),
        el("p", {}, scope),
        el("div", {class: "demo-team-card__signals"}, [
          el("span", {}, `${assigned.length} open ${assigned.length === 1 ? "assignment" : "assignments"}`),
          blocked ? badge(`${blocked} blocked`, "danger") : badge("Clear", "good")
        ]),
        assigned.length ? miniLinks(assigned.slice(0, 2).map((item) => ({label: item.title, href: workItemHref(item)}))) : el("small", {}, "No open work assigned")
      ]);
    }))
  ]);
}

export function workConfigurationSummary(configuration = {}) {
  const types = configuration.types?.filter((type) => type.active) ?? [];
  const statuses = configuration.statuses ?? [];
  return el("section", {class: "workflow-summary", "aria-labelledby": "workflow-summary-heading"}, [
    el("div", {class: "section-heading"}, [
      el("div", {}, [
        el("h2", {id: "workflow-summary-heading"}, "Current workflow"),
        el("p", {}, "Tasks start in the initial column and move only through the role-enabled transitions below.")
      ]),
      el("span", {}, `${configuration.transitions?.length ?? 0} ${(configuration.transitions?.length ?? 0) === 1 ? "transition" : "transitions"}`)
    ]),
    el("ol", {class: "workflow-summary__statuses", "aria-label": "Task status columns"}, statuses.map((status, index) => el("li", {class: status.active ? "" : "is-retired"}, [
      el("span", {class: "workflow-summary__order"}, String(index + 1).padStart(2, "0")),
      el("strong", {}, status.label ?? status.id),
      badge(!status.active ? "Retired" : status.closed ? "Completed" : "Open", !status.active ? "neutral" : status.closed ? "good" : "info"),
      status.id === configuration.defaultStatusId ? el("small", {}, "Initial") : ""
    ]))),
    el("div", {class: "workflow-summary__types"}, [
      el("strong", {}, "Active task types"),
      el("div", {class: "badge-row"}, types.map((type) => badge(type.label ?? type.id, type.id === configuration.defaultTypeId ? "info" : "neutral")))
    ]),
    el("p", {class: "workflow-summary__note"}, "In the shared demo, changes are real for today’s visitors and return to this sample configuration at the daily reset.")
  ]);
}

export function applicationDataSummary(summary, {sampleDocuments = false} = {}) {
  const records = Object.entries(summary.records ?? {}).map(([name, count]) => [titleCase(name), count]);
  const activity = Object.entries(summary.activityByEntity ?? {}).map(([name, count]) => [titleCase(name), count]);
  return el("section", {class: "reports"}, [
    dataTable(["Signal", "Value"], [
      ["Tracked records", Object.values(summary.records ?? {}).reduce((sum, value) => sum + Number(value ?? 0), 0)],
      [sampleDocuments ? "Sample document metadata" : "Document storage", sampleDocuments ? `${summary.records?.documents ?? 0} embedded records` : `${Math.round(Number(summary.documentBytes ?? 0) / 1024)} KB`],
      ["Last activity", formatDate(summary.lastActivityAt) || "None"]
    ]),
    dataTable(["Record type", "Count"], records),
    dataTable(["Activity entity", "Events"], activity.length ? activity : [["None", 0]])
  ]);
}

export function membershipTable(memberships, projects = []) {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  return dataTable(["Member", "Role", "Status", "Project access", "Updated"], memberships.map((membership) => [
    el("div", {class: "object-cell"}, [
      el("strong", {}, membership.name ?? membership.user?.name ?? membership.email),
      el("span", {}, membership.email ?? membership.user?.email ?? membership.userId)
    ]),
    badge(membership.role ?? "viewer", "neutral"),
    el("div", {class: "badge-row"}, [membership.placeholder ? badge("Placeholder", "info") : "", badge(membership.status ?? "active", membership.status === "disabled" ? "danger" : "good")]),
    membership.projectIds?.length ? membership.projectIds.map((id) => projectNames.get(id) ?? id).join(", ") : "All projects",
    formatDate(membership.updatedAt)
  ]));
}

export function documentUploadForm(client, projectsOrProjectId, {onSaved, selectedProjectId = "", selectedWorkItemId = "", workItems = []} = {}) {
  const fixedProjectId = typeof projectsOrProjectId === "string" ? projectsOrProjectId : "";
  const projects = Array.isArray(projectsOrProjectId) ? projectsOrProjectId : [];
  const selectedTask = workItems.find((item) => item.id === selectedWorkItemId);
  const startingProjectId = fixedProjectId || selectedTask?.projectId || selectedProjectId || "";
  const nameInput = textInput("name", "Project brief");
  const fileInput = el("input", {name: "file", type: "file", required: true});
  const projectSelect = fixedProjectId ? undefined : selectInput("projectId", projectOptions(projects), startingProjectId);
  const taskSelect = selectInput("workItemId", taskOptions(workItems, startingProjectId), selectedWorkItemId);
  const refreshTaskOptions = () => {
    const projectId = fixedProjectId || projectSelect?.value || "";
    const previous = taskSelect.value;
    replaceSelectOptions(taskSelect, taskOptions(workItems, projectId), previous);
    if (previous && taskSelect.value !== previous) taskSelect.value = "";
  };
  projectSelect?.addEventListener("change", refreshTaskOptions);
  refreshTaskOptions();
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file && !nameInput.value) nameInput.value = file.name.replace(/\.[^.]+$/, "");
  });
  const fields = [
    fixedProjectId ? "" : field("Project", projectSelect),
    field("Task", taskSelect),
    field("File", fileInput),
    field("Name", nameInput),
    field("Category", selectInput("category", documentCategories, "brief")),
    field("Description", textInput("description", "Optional")),
    el("button", {class: "button button--primary", type: "submit"}, "Upload document")
  ].filter(Boolean);
  const form = el("form", {class: "editor-form editor-form--wide"}, fields);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const file = fileInput.files?.[0];
    if (!file) return;
    const name = data.name || file?.name?.replace(/\.[^.]+$/, "") || "Document";
    const linkedTask = workItems.find((item) => item.id === data.workItemId);
    const projectId = fixedProjectId || linkedTask?.projectId || data.projectId;
    try {
      if (file.size === 0) throw new Error("Document file must not be empty.");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
      const checksumSha256 = btoa(String.fromCharCode(...digest));
      const intent = await client.documents.uploadIntent({
        projectId,
        workItemId: data.workItemId || undefined,
        name,
        filename: file?.name ?? `${name}.txt`,
        contentType: file?.type || "text/plain",
        sizeBytes: file.size,
        checksumSha256,
        category: data.category,
        description: data.description
      }, {idempotencyKey: crypto.randomUUID()});
      if (/^https?:\/\//.test(intent.uploadUrl)) {
        await client.documents.putUpload(intent.uploadUrl, file, intent.uploadHeaders);
      }
      const documentId = intent.documentId ?? intent.document?.id;
      const scan = await client.documents.requestScan(projectId, documentId);
      if (!scan.scanRequested) await client.documents.finalize({documentId, projectId});
      form.reset();
      saveStatus(form, scan.scanRequested ? "Document uploaded and queued for malware scanning." : "Document saved.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

function documentSize(document) {
  return `${Math.max(1, Math.round(Number(document.sizeBytes ?? 0) / 1024))} KB`;
}

function documentProjectLink(document) {
  return document.projectId ? el("a", {href: projectHref(document.projectId)}, document.projectName ?? document.projectId) : "";
}

function documentTaskLink(document, workItemsById = new Map()) {
  const linked = document.workItemId ? workItemsById.get(document.workItemId) : undefined;
  const title = document.workItemName ?? linked?.title ?? document.workItemId ?? "";
  if (!document.workItemId) return "";
  return el("a", {href: workItemHref(linked ?? {id: document.workItemId, projectId: document.projectId})}, title);
}

function documentDownloadButton(client, document) {
  const button = el("button", {class: "button", type: "button"}, "Download");
  button.disabled = document.status !== "ready";
  button.addEventListener("click", async () => {
    const result = await client.documents.download(document.projectId, document.id);
    if (/^https?:\/\//.test(result.downloadUrl)) location.href = result.downloadUrl;
    else button.textContent = "Prepared";
  });
  return button;
}

function documentStatusButton(client, document, onSaved) {
  if (document.status === "pending") {
    const clean = document.scanStatus === "clean";
    const button = el("button", {class: "button", type: "button"}, clean ? "Finalize" : document.scanStatus === "queued" ? "Scan queued" : "Request scan");
    button.disabled = document.scanStatus === "queued";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        if (clean) await client.documents.finalize({documentId: document.id, projectId: document.projectId});
        else await client.documents.requestScan(document.projectId, document.id);
        onSaved?.();
      } catch (error) {
        button.disabled = false;
        button.title = error.message;
      }
    });
    return button;
  }
  const archived = document.status === "archived";
  const button = el("button", {class: "button", type: "button"}, archived ? "Restore" : "Archive");
  button.addEventListener("click", async () => {
    await client.documents.patch(document.projectId, document.id, {status: archived ? "ready" : "archived", version: document.version});
    onSaved?.();
  });
  return button;
}

function documentEditForm(client, document, {onSaved, workItems = []} = {}) {
  const form = el("form", {class: "editor-form document-edit-form"}, [
    field("Name", textInput("name", "Document name", document.name ?? document.filename ?? "")),
    field("Category", selectInput("category", documentCategories, document.category ?? "other")),
    field("Status", selectInput("status", ["ready", "archived"], document.status === "archived" ? "archived" : "ready")),
    field("Task", selectInput("workItemId", taskOptions(workItems, document.projectId), document.workItemId ?? "")),
    field("Description", textInput("description", "Optional", document.description ?? "")),
    field("Tags", textInput("tags", "brief, decision", csvList(document.tags))),
    el("button", {class: "button button--primary", type: "submit"}, "Save document")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      await client.documents.patch(document.projectId, document.id, {
        name: data.name,
        category: data.category,
        status: data.status,
        workItemId: data.workItemId ?? "",
        description: data.description,
        tags: csvValues(data.tags),
        version: document.version
      });
      saveStatus(form, "Document saved.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function documentsTable(documents, client, {onSaved, workItems = []} = {}) {
  if (!documents.length) return emptyView("No documents.");
  const byId = workItemLookup(workItems);
  const canDownload = !client?.isPublicDemo;
  const headers = ["Document", "Project", "Task", "Category", "Status", "Size", "Updated", ...(canDownload ? [""] : []), ""];
  return dataTable(headers, documents.map((document) => [
    el("div", {class: "object-cell"}, [
      el("strong", {}, document.name ?? document.filename),
      el("span", {}, document.filename)
    ]),
    documentProjectLink(document),
    documentTaskLink(document, byId),
    badge(document.category ?? "other", "neutral"),
    badge(document.status ?? "pending", document.status === "ready" ? "good" : "watch"),
    documentSize(document),
    formatDate(document.updatedAt),
    ...(canDownload ? [documentDownloadButton(client, document)] : []),
    documentStatusButton(client, document, onSaved)
  ]));
}

export function documentFilterForm({projects = [], workItems = [], filters = {}} = {}) {
  const projectSelect = selectInput("projectId", projectOptions(projects, "All projects"), filters.projectId ?? "");
  const taskSelect = selectInput("workItemId", taskOptions(workItems, filters.projectId ?? "", "All tasks"), filters.workItemId ?? "");
  projectSelect.addEventListener("change", () => {
    replaceSelectOptions(taskSelect, taskOptions(workItems, projectSelect.value, "All tasks"), "");
  });
  return el("form", {class: "filter-form document-filter-form", method: "get", action: "/app/documents"}, [
    field("Search", el("input", {type: "search", name: "search", placeholder: "Name, file, or description", value: filters.search ?? ""})),
    field("Project", projectSelect),
    field("Task", taskSelect),
    field("Category", selectInput("category", ["", ...documentCategories], filters.category ?? "")),
    field("Status", selectInput("status", ["", "pending", "ready", "archived"], filters.status ?? "")),
    el("button", {class: "button button--primary", type: "submit"}, "Apply"),
    el("a", {class: "button button--ghost", href: "/app/documents"}, "Clear")
  ]);
}

export function documentWorkspaceSummary(documents = [], projects = [], workItems = []) {
  const linkedTasks = documents.filter((document) => document.workItemId).length;
  const ready = documents.filter((document) => document.status === "ready").length;
  const archived = documents.filter((document) => document.status === "archived").length;
  const projectsWithDocs = new Set(documents.map((document) => document.projectId).filter(Boolean)).size;
  return el("section", {class: "document-summary"}, [
    dataTable(["Signal", "Value"], [
      ["Documents", documents.length],
      ["Ready", ready],
      ["Linked to tasks", linkedTasks],
      ["Projects with docs", projectsWithDocs],
      ["Archived", archived]
    ]),
    el("p", {}, projects.length || workItems.length
      ? "Documents are organized by project first and can be attached to a specific task when the file supports a task note, decision, requirement, or delivery record."
      : "Documents are scoped to this workspace and remain behind the current account boundary.")
  ]);
}

export function documentWorkspace(documents, client, {projects = [], workItems = [], onSaved} = {}) {
  if (!documents.length) return emptyView("No documents match this view.");
  const byId = workItemLookup(workItems);
  return el("section", {class: "document-library", id: "document-library"}, [
    el("div", {class: "section-heading"}, [
      el("h2", {}, "Document library"),
      el("span", {}, `${documents.length} file${documents.length === 1 ? "" : "s"}`)
    ]),
    ...documents.map((document) => {
      const project = projects.find((item) => item.id === document.projectId);
      const linkedTask = byId.get(document.workItemId);
      return el("article", {class: "document-card"}, [
        el("div", {class: "document-card__main"}, [
          el("div", {class: "object-cell"}, [
            el("strong", {}, document.name ?? document.filename),
            el("span", {}, document.filename)
          ]),
          el("div", {class: "badge-row"}, [
            document.sampleOnly ? badge("Sample record", "info") : "",
            badge(document.category ?? "other", "neutral"),
            badge(document.status ?? "pending", document.status === "ready" ? "good" : document.status === "archived" ? "neutral" : "watch")
          ]),
          el("div", {class: "document-card__links"}, [
            document.projectId ? el("a", {href: projectHref(document.projectId)}, project?.name ?? document.projectName ?? document.projectId) : el("span", {}, "No project"),
            document.workItemId ? documentTaskLink(document, byId) : el("span", {}, "No task attached")
          ]),
          document.description ? el("p", {}, document.description) : "",
          el("small", {}, `${document.sampleOnly ? "Sample size" : "Size"}: ${documentSize(document)} / Updated ${formatDate(document.updatedAt) || "unknown"}`),
          document.sampleOnly && document.samplePreview ? el("details", {class: "document-card__preview"}, [
            el("summary", {}, "Preview sample content"),
            el("p", {}, "This embedded fictional excerpt demonstrates review and organization without exposing a transferable file."),
            el("pre", {}, document.samplePreview)
          ]) : ""
        ]),
        el("div", {class: "document-card__actions"}, [
          ...(!client?.isPublicDemo ? [documentDownloadButton(client, document)] : []),
          documentStatusButton(client, document, onSaved)
        ]),
        el("details", {class: "document-card__edit"}, [
          el("summary", {}, "Edit details"),
          documentEditForm(client, {...document, workItemName: document.workItemName ?? linkedTask?.title}, {onSaved, workItems})
        ])
      ]);
    })
  ]);
}

export function attachmentIntentForm(client, projectId) {
  return documentUploadForm(client, projectId);
}

export function csvExportButton(filename, rows) {
  const button = el("button", {class: "button", type: "button"}, "Export CSV");
  button.addEventListener("click", () => {
    const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const csv = [keys.join(","), ...rows.map((row) => keys.map((key) => JSON.stringify(row[key] ?? "")).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], {type: "text/csv"}));
    const link = el("a", {href: url, download: filename});
    link.click();
    URL.revokeObjectURL(url);
  });
  return button;
}

export function workItemExportButtons(client, projectId = "") {
  const group = el("div", {class: "button-row", role: "group", "aria-label": "Export work items"});
  for (const format of ["csv", "xls", "pdf", "atom"]) {
    const button = el("button", {class: "button", type: "button"}, `Export ${format.toUpperCase()}`);
    button.addEventListener("click", async () => {
      button.disabled = true;
      const idle = button.textContent;
      button.textContent = "Preparing...";
      try {
        const exported = await client.exports.workItems({projectId: projectId || undefined, format});
        let bytes;
        if (exported.base64) {
          const binary = atob(exported.base64);
          bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        } else bytes = exported.content;
        const url = URL.createObjectURL(new Blob([bytes], {type: exported.contentType}));
        const link = el("a", {href: url, download: exported.filename});
        link.click();
        URL.revokeObjectURL(url);
        button.textContent = idle;
      } catch (error) {
        button.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
    group.append(button);
  }
  if (projectId) {
    const gantt = el("button", {class: "button", type: "button"}, "Export Gantt PDF");
    gantt.addEventListener("click", async () => {
      gantt.disabled = true;
      const idle = gantt.textContent;
      gantt.textContent = "Preparing...";
      try {
        const exported = await client.exports.gantt(projectId);
        const binary = atob(exported.base64);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], {type: exported.contentType}));
        el("a", {href: url, download: exported.filename}).click();
        URL.revokeObjectURL(url);
        gantt.textContent = idle;
      } catch (error) {
        gantt.textContent = error.message;
      } finally {
        gantt.disabled = false;
      }
    });
    group.append(gantt);
  }
  return group;
}

export function savedViewForm(client, scope, filters) {
  const form = el("form", {class: "inline-form"}, [
    field("View name", textInput("name", "My filtered projects")),
    field("Visibility", selectInput("visibility", [{value: "private", label: "Only me"}, {value: "workspace", label: "Share with workspace"}], "private")),
    el("button", {class: "button", type: "submit"}, "Save view")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    await client.savedViews.create({name: data.get("name"), scope, filters, visibility: data.get("visibility")}, {idempotencyKey: crypto.randomUUID()});
    saveStatus(form, "View saved.", "ok");
  });
  return form;
}

export function projectFilterForm({search = "", health = "", status = "", archived = "", template = "", favorite = ""} = {}) {
  return el("form", {class: "filter-form", method: "get", action: "/app/projects"}, [
    field("Search", el("input", {type: "search", name: "search", placeholder: "Project name", value: search})),
    field("Health", selectInput("health", ["", "on-track", "watch", "at-risk", "blocked"], health)),
    field("Status", selectInput("status", ["", "proposed", "active", "paused", "complete", "archived"], status)),
    field("Lifecycle", selectInput("archived", [{value: "", label: "All projects"}, {value: "false", label: "Active list"}, {value: "true", label: "Archived only"}], archived)),
    field("Kind", selectInput("template", [{value: "", label: "Projects and templates"}, {value: "false", label: "Projects only"}, {value: "true", label: "Templates only"}], template)),
    field("Favorites", selectInput("favorite", [{value: "", label: "All"}, {value: "true", label: "Favorites only"}], favorite)),
    el("button", {class: "button button--primary", type: "submit"}, "Apply"),
    el("a", {class: "button button--ghost", href: "/app/projects"}, "Clear")
  ]);
}

export function syncQueryInput(name, value) {
  const input = document.createElement("input");
  input.type = "search";
  input.name = name;
  input.placeholder = "Search";
  input.value = value;
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const url = new URL(location.href);
      if (input.value) url.searchParams.set(name, input.value);
      else url.searchParams.delete(name);
      history.replaceState({}, "", url);
    }, 250);
  });
  return input;
}

export function reportTables(summary) {
  return el("section", {class: "reports"}, [
    dataTable(["Status", "Projects"], entries(summary.byStatus).map((row) => [badge(row.name, statusTone(row.name)), row.value])),
    dataTable(["Phase", "Projects"], entries(summary.byPhase).map((row) => [row.name, row.value])),
    dataTable(["Work status", "Items"], entries(summary.byWorkStatus).map((row) => [badge(row.name, statusTone(row.name)), row.value]))
  ]);
}

function integrationConnectorOptions(connectors = []) {
  return connectors.filter((connector) => connector.enabled !== false).map((connector) => ({value: connector.id, label: `${connector.name ?? connector.id} · ${titleCase(connector.type ?? "connector")}`}));
}

export function integrationCatalogSummary(catalog = {}) {
  const connectors = catalog.connectors ?? [];
  return el("section", {class: "integration-summary"}, [
    dataTable(["Connector", "Type", "Adapter", "Linked records"], connectors.map((connector) => [
      el("div", {class: "object-cell"}, [el("strong", {}, connector.name ?? connector.id), connector.baseUrl ? el("a", {href: connector.baseUrl, target: "_blank", rel: "noreferrer"}, connector.baseUrl) : ""]),
      titleCase(connector.type ?? "connector"),
      connector.enabled === false
        ? badge("disabled", "neutral")
        : connector.adapter?.operational
          ? badge("operational", "good")
          : connector.adapter?.supported
            ? badge(`needs ${connector.adapter.missingConfiguration?.join(", ") || "configuration"}`, "warning")
            : badge("metadata only", "neutral"),
      connector.linkedItemCount ?? 0
    ])),
    dataTable(["Integration resource", "Configured"], [
      ["Repository browsers", (catalog.repositories ?? []).length],
      ["Outbound webhooks", (catalog.webhooks ?? []).length],
      ["External storage and collaboration connectors", connectors.filter((connector) => ["nextcloud", "onedrive", "sharepoint", "xwiki", "opendesk"].includes(connector.type)).length]
    ])
  ]);
}

function providerResourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function providerItemFields(item) {
  const fields = item.metadata?.fieldValues ?? item.metadata?.fields;
  return Array.isArray(fields) ? fields : [];
}

function providerFieldValue(field) {
  return field.text ?? field.name ?? field.number ?? field.date ?? field.title ?? "Not set";
}

export function providerIntegrationPanel(client, {projects = [], workItems = [], connectors = [], admin = false, onSaved} = {}) {
  const operational = connectors.filter((connector) => connector.enabled !== false && connector.adapter?.operational);
  if (!operational.length) return emptyView("No provider adapter is operational. Add its HTTPS endpoint and external credential reference in Workspace capabilities.");
  const connector = selectInput("connectorId", integrationConnectorOptions(operational), operational[0]?.id ?? "");
  const project = selectInput("projectId", projectOptions(projects), projects[0]?.id ?? "");
  const task = selectInput("workItemId", taskOptions(workItems, project.value), "");
  project.addEventListener("change", () => replaceSelectOptions(task, taskOptions(workItems, project.value), ""));
  const results = el("div", {class: "integration-resource-results"}, emptyView("Browse an authenticated provider to select a resource."));
  const submit = el("button", {class: "button button--primary", type: "submit"}, "Browse provider");
  const form = el("form", {class: "editor-form"}, [
    field("Provider", connector),
    field("Project", project),
    field("Task", task),
    field("Folder or space", textInput("path", "Optional provider path")),
    field("Search", textInput("query", "Optional title or identifier")),
    submit
  ]);
  let resources = [];
  let projectDetails;
  let busy = false;
  const browse = async (values, cursor) => {
    if (busy) return;
    busy = true;
    submit.disabled = true;
    results.querySelector('[data-load-more]')?.setAttribute("disabled", "true");
    try {
      const page = await client.integrations.resources(values.connectorId, {path: values.path, query: values.query, ...(cursor ? {cursor} : {})});
      resources = cursor ? [...resources, ...(page.items ?? [])] : page.items ?? [];
      resources = [...new Map(resources.map((item) => [item.id, item])).values()];
      projectDetails = page.project ?? (cursor ? projectDetails : undefined);
      const content = [];
      if (projectDetails) {
        const href = providerResourceUrl(projectDetails.url);
        content.push(el("section", {class: "integration-provider-project", "aria-label": "GitHub project"}, [
          el("h3", {}, href ? el("a", {href, target: "_blank", rel: "noopener noreferrer"}, projectDetails.title) : projectDetails.title),
          el("p", {}, projectDetails.public === true ? "Public GitHub project" : projectDetails.public === false ? "Private GitHub project" : "Project visibility not supplied"),
          el("details", {}, [
            el("summary", {}, "Project fields"),
            dataTable(["Field", "Type", "Options"], (projectDetails.fields ?? []).map((item) => [item.name, item.dataType, (item.options ?? []).map((option) => option.name).join(", ")]))
          ]),
          page.fieldsPageInfo?.hasNextPage ? el("p", {role: "note"}, "Additional project fields were not returned in this response.") : ""
        ]));
      }
      const rows = resources.map((item) => {
        const link = el("button", {class: "button button--ghost", type: "button"}, "Link");
        link.addEventListener("click", async () => {
          if (link.disabled) return;
          link.disabled = true;
          try {
            await client.integrations.link({projectId: project.value, workItemId: task.value || undefined, connectorId: values.connectorId, externalId: item.id, externalUrl: item.externalUrl, title: item.title, linkType: item.linkType ?? "file", metadata: item.metadata ?? {}});
            link.textContent = "Linked";
            onSaved?.();
          } catch (error) {
            link.disabled = false;
            link.textContent = error.message;
          }
        });
        const fields = providerItemFields(item);
        const statusField = fields.find((field) => (field.fieldName ?? "").toLowerCase() === "status");
        const status = item.metadata?.status ?? (statusField ? providerFieldValue(statusField) : item.metadata?.state ?? "");
        const fieldDetails = el("div", {class: "integration-item-fields"}, [
          ...fields.map((field) => el("p", {}, [el("strong", {}, `${field.fieldName ?? "Field"}: `), String(providerFieldValue(field))])),
          item.metadata?.fieldValuesPageInfo?.hasNextPage ? el("small", {}, "Additional field values were not returned.") : ""
        ]);
        const href = providerResourceUrl(item.externalUrl);
        return [href ? el("a", {href, target: "_blank", rel: "noopener noreferrer"}, item.title) : item.title, badge(item.kind ?? item.linkType ?? "resource", "info"), status, item.path ?? item.metadata?.repository ?? item.id, fieldDetails, link];
      });
      const partial = page.filtered || page.redacted || page.truncated || page.itemsPageInfo?.hasNextPage || page.fieldsPageInfo?.hasNextPage;
      content.push(rows.length ? dataTable(["Provider resource", "Kind", "Status", "Path or repository", "Fields", ""], rows) : emptyView(partial ? "No matching resources were returned in this page." : "The provider returned no matching resources."));
      if (page.filtered) content.push(el("p", {role: "note"}, "Some board items are outside this connector's repository scope."));
      if (page.redacted) content.push(el("p", {role: "note"}, "Some board items are unavailable to this provider connection."));
      if (page.truncated) content.push(el("p", {role: "note"}, "This response is partial; additional items or fields were not returned."));
      if (page.nextCursor) {
        const more = el("button", {class: "button", type: "button", "data-load-more": "true"}, "Load more resources");
        more.addEventListener("click", () => browse(values, page.nextCursor));
        content.push(more);
      } else if (page.itemsPageInfo?.hasNextPage) {
        content.push(el("p", {role: "note"}, "Additional items exist but were not returned in this response."));
      }
      results.replaceChildren(...content);
    } catch (error) {
      results.replaceChildren(errorView(error));
    } finally {
      busy = false;
      submit.disabled = false;
    }
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    await browse(values);
  });
  const health = el("div", {class: "button-row"}, admin ? operational.map((item) => {
    const button = el("button", {class: "button", type: "button"}, `Check ${item.name ?? item.id}`);
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const result = await client.integrations.health(item.id);
        button.textContent = result.ok ? `${item.name ?? item.id} healthy` : `${item.name ?? item.id} unavailable`;
      } catch (error) {
        button.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }) : []);
  return el("section", {}, [health, form, results]);
}

export function providerPermissionSyncForm(client, {projects = [], connectors = [], onSaved} = {}) {
  const storages = connectors.filter((connector) => connector.adapter?.operational && connector.adapter.capabilities?.includes("managed-permissions"));
  const form = el("form", {class: "editor-form"}, [
    field("Project", selectInput("projectId", projectOptions(projects), projects[0]?.id ?? "")),
    field("Managed storage", selectInput("connectorId", integrationConnectorOptions(storages), storages[0]?.id ?? "")),
    field("Provider folder or item ID", textInput("resourceId", "Folder path or drive item ID")),
    el("button", {class: "button button--primary", type: "submit", disabled: storages.length ? undefined : "true"}, "Reconcile access")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      const result = await client.integrations.syncPermissions(values.connectorId, {projectId: values.projectId, resourceId: values.resourceId});
      saveStatus(form, `Reconciled ${result.desiredCount} members; added ${result.added.length}, removed ${result.removed.length}.`, "ok");
      onSaved?.(result);
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function xwikiPageForm(client, {projects = [], workItems = [], connectors = [], onSaved} = {}) {
  const providers = connectors.filter((connector) => connector.type === "xwiki" && connector.adapter?.operational);
  const project = selectInput("projectId", projectOptions(projects), projects[0]?.id ?? "");
  const task = selectInput("workItemId", taskOptions(workItems, project.value), "");
  project.addEventListener("change", () => replaceSelectOptions(task, taskOptions(workItems, project.value), ""));
  const form = el("form", {class: "editor-form"}, [
    field("XWiki provider", selectInput("connectorId", integrationConnectorOptions(providers), providers[0]?.id ?? "")),
    field("Project", project),
    field("Task", task),
    field("Page title", textInput("title", "Project decision record")),
    field("Space", textInput("space", "Optional XWiki space")),
    field("Content", textareaInput("content", "# Project decision\n")),
    el("button", {class: "button button--primary", type: "submit", disabled: providers.length ? undefined : "true"}, "Create and link page")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      const result = await client.integrations.createResource(values.connectorId, {...values, workItemId: values.workItemId || undefined, space: values.space || undefined});
      saveStatus(form, `Created and linked ${result.resource.title}.`, "ok");
      onSaved?.(result);
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function integrationLinksTable(links = [], client, {onSaved} = {}) {
  if (!links.length) return emptyView("No external records are linked yet.");
  return dataTable(["External record", "Connector", "Task", "Type", "Updated", ""], links.map((link) => {
    const remove = el("button", {class: "button button--ghost", type: "button"}, "Unlink");
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await client.integrations.unlink(link.id, {version: link.version});
        onSaved?.();
      } catch (error) {
        remove.disabled = false;
        remove.textContent = error.message;
      }
    });
    return [
      link.externalUrl ? el("a", {href: link.externalUrl, target: "_blank", rel: "noreferrer"}, link.title) : link.title,
      link.connectorId,
      link.workItemId ? el("a", {href: projectHref(link.projectId, link.workItemId)}, link.workItemId) : "Project level",
      badge(link.linkType ?? "development", "info"),
      formatDate(link.updatedAt),
      remove
    ];
  }));
}

export function repositoriesTable(repositories = []) {
  if (!repositories.length) return emptyView("No Git or SVN repositories are configured.");
  return dataTable(["Repository", "Type", "Project", "Revision", "Entries", "Synchronized"], repositories.map((repository) => [
    el("a", {href: `/app/integrations?repositoryId=${encodeURIComponent(repository.id)}`}, repository.name ?? repository.id),
    badge(repository.type ?? "git", "info"),
    repository.projectId ?? "Workspace",
    repository.revision ?? "Not synchronized",
    repository.entryCount ?? 0,
    formatDate(repository.syncedAt) || "Never"
  ]));
}

export function repositoryTreeView(tree = {}) {
  const parent = tree.path?.includes("/") ? tree.path.slice(0, tree.path.lastIndexOf("/")) : "";
  const rows = (tree.entries ?? []).map((entry) => {
    const name = entry.path.split("/").at(-1);
    const href = entry.type === "directory" ? `/app/integrations?repositoryId=${encodeURIComponent(tree.repository.id)}&repositoryPath=${encodeURIComponent(entry.path)}` : entry.externalUrl;
    return [href ? el("a", {href, ...(entry.externalUrl ? {target: "_blank", rel: "noreferrer"} : {})}, name) : name, badge(entry.type, entry.type === "directory" ? "info" : "neutral"), entry.sizeBytes ?? "", entry.revision ?? tree.revision ?? ""];
  });
  return el("section", {}, [
    el("div", {class: "section-heading"}, [el("strong", {}, `${tree.repository.name ?? tree.repository.id} / ${tree.path || "root"}`), tree.path ? el("a", {class: "button button--ghost", href: `/app/integrations?repositoryId=${encodeURIComponent(tree.repository.id)}&repositoryPath=${encodeURIComponent(parent)}`}, "Parent") : ""]),
    rows.length ? dataTable(["Path", "Type", "Bytes", "Revision"], rows) : emptyView("This path has no synchronized entries.")
  ]);
}

export function repositorySyncForm(client, repositories = [], {onSaved} = {}) {
  const form = el("form", {class: "editor-form"}, [
    field("Repository", selectInput("repositoryId", repositories.map((repository) => ({value: repository.id, label: repository.name ?? repository.id})), repositories[0]?.id ?? "")),
    field("Ref", textInput("ref", "main", "main")),
    field("Revision", textInput("revision", "commit or SVN revision")),
    field("Tree entries JSON", textareaInput("entries", '[{"path":"src","type":"directory"},{"path":"README.md","type":"file","sizeBytes":1024,"externalUrl":"https://git.example/repo/README.md"}]')),
    el("button", {class: "button button--primary", type: "submit", disabled: repositories.length ? undefined : "true"}, "Synchronize snapshot")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      const result = await client.repositories.sync(values.repositoryId, {ref: values.ref, revision: values.revision, entries: JSON.parse(String(values.entries))});
      saveStatus(form, `Synchronized ${result.entryCount} entries.`, "ok");
      onSaved?.(result);
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function integrationLinkForm(client, {projects = [], workItems = [], connectors = [], onSaved} = {}) {
  const project = selectInput("projectId", projectOptions(projects), projects[0]?.id ?? "");
  const task = selectInput("workItemId", taskOptions(workItems, project.value), "");
  project.addEventListener("change", () => replaceSelectOptions(task, taskOptions(workItems, project.value), ""));
  const form = el("form", {class: "editor-form"}, [
    field("Project", project),
    field("Task", task),
    field("Connector", selectInput("connectorId", integrationConnectorOptions(connectors), connectors[0]?.id ?? "")),
    field("External identifier", textInput("externalId", "Repository#42 or file ID")),
    field("Title", textInput("title", "External record title")),
    field("HTTPS URL", textInput("externalUrl", "https://...")),
    field("Link type", selectInput("linkType", ["development", "file", "folder", "repository", "issue", "wiki", "collaboration"], "development")),
    el("button", {class: "button button--primary", type: "submit"}, "Link record")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      const linked = await client.integrations.link({...values, workItemId: values.workItemId || undefined, externalUrl: values.externalUrl || undefined, metadata: {linkedFrom: "web"}});
      saveStatus(form, `Linked ${linked.title}.`, "ok");
      onSaved?.(linked);
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function jiraImportForm(client, {projects = [], connectors = [], onSaved} = {}) {
  const jiraConnectors = connectors.filter((connector) => connector.type === "jira" && connector.enabled !== false);
  const form = el("form", {class: "editor-form"}, [
    field("Project", selectInput("projectId", projectOptions(projects), projects[0]?.id ?? "")),
    field("Jira connector", selectInput("connectorId", integrationConnectorOptions(jiraConnectors), jiraConnectors[0]?.id ?? "")),
    field("Issues JSON", textareaInput("issues", '[{"key":"TEAM-1","summary":"Imported task","type":"task","status":"new","externalUrl":"https://jira.example/TEAM-1"}]')),
    el("button", {class: "button button--primary", type: "submit", disabled: jiraConnectors.length ? undefined : "true"}, "Import Jira issues")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      const issues = JSON.parse(String(values.issues));
      const result = await client.integrations.importJira({projectId: values.projectId, connectorId: values.connectorId, issues});
      saveStatus(form, `Imported ${result.importedCount} issue${result.importedCount === 1 ? "" : "s"}.`, "ok");
      onSaved?.(result);
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function externalSharesTable(shares = [], client, {onSaved} = {}) {
  if (!shares.length) return emptyView("No tasks are shared externally.");
  return dataTable(["Task", "Recipient", "Permissions", "Expires", "Share link", ""], shares.map((share) => {
    const revoke = el("button", {class: "button button--ghost", type: "button", disabled: share.revokedAt ? "true" : undefined}, share.revokedAt ? "Revoked" : "Revoke");
    revoke.addEventListener("click", async () => {
      revoke.disabled = true;
      try {
        await client.externalShares.revoke(share.token, {version: share.version});
        onSaved?.();
      } catch (error) {
        revoke.disabled = false;
        revoke.textContent = error.message;
      }
    });
    return [
      el("a", {href: projectHref(share.projectId, share.workItemId)}, share.workItemId),
      `${titleCase(share.targetType)} · ${share.target}`,
      share.permissions.join(", "),
      formatDate(share.expiresAt),
      el("a", {href: `/app/shared?token=${encodeURIComponent(share.token)}`}, "Open"),
      revoke
    ];
  }));
}

export function externalShareForm(client, {projects = [], workItems = [], onSaved} = {}) {
  const project = selectInput("projectId", projectOptions(projects), projects[0]?.id ?? "");
  const task = selectInput("workItemId", taskOptions(workItems, project.value), "");
  project.addEventListener("change", () => replaceSelectOptions(task, taskOptions(workItems, project.value), ""));
  const form = el("form", {class: "editor-form"}, [
    field("Project", project),
    field("Task", task),
    field("Recipient kind", selectInput("targetType", ["email", "user", "group"], "email")),
    field("Recipient", textInput("target", "partner@example.com")),
    field("Access", selectInput("access", [{value: "read", label: "Read only"}, {value: "comment", label: "Read and comment"}], "comment")),
    field("Expires", el("input", {name: "expiresAt", type: "date"})),
    el("button", {class: "button button--primary", type: "submit"}, "Share task")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      const share = await client.externalShares.create({projectId: values.projectId, workItemId: values.workItemId, targetType: values.targetType, target: values.target, permissions: values.access === "comment" ? ["read", "comment"] : ["read"], expiresAt: values.expiresAt ? `${values.expiresAt}T23:59:59.000Z` : undefined});
      saveStatus(form, `Share created. Open /app/shared?token=${share.token}`, "ok");
      onSaved?.(share);
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return form;
}

export function outboundLinkCheckForm(client) {
  const result = el("div", {class: "form-status", role: "status"});
  const form = el("form", {class: "inline-form"}, [
    field("HTTPS destination", textInput("url", "https://external.example/resource")),
    el("button", {class: "button button--primary", type: "submit"}, "Check destination"),
    result
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      let checked = await client.outboundLinks.check({url: new FormData(form).get("url"), sourceType: "integration-center"});
      if (checked.requiresConfirmation && confirm(`This link leaves Team Spaces for ${checked.host}. Continue?`)) checked = await client.outboundLinks.check({url: checked.url, sourceType: "integration-center", confirmed: true});
      result.textContent = checked.allowed ? `Allowed by ${checked.policy} policy.` : `Blocked by ${checked.policy} policy.`;
      result.dataset.state = checked.allowed ? "ok" : "error";
    } catch (error) {
      result.textContent = error.message;
      result.dataset.state = "error";
    }
  });
  return form;
}

export function directorySyncForm(client, {onSaved} = {}) {
  const queryDirectory = el("button", {class: "button button--primary", type: "button"}, "Query and synchronize LDAP");
  const queryStatus = el("p", {class: "form-status", role: "status", "aria-live": "polite"});
  queryDirectory.addEventListener("click", async () => {
    queryDirectory.disabled = true;
    try {
      const result = await client.directory.ldapSync();
      queryStatus.textContent = `Synchronized ${result.synchronizedCount} users and ${result.groups?.length ?? 0} groups; disabled ${result.disabledCount ?? 0} missing users.`;
      queryStatus.dataset.state = "ok";
      onSaved?.(result);
    } catch (error) {
      queryStatus.textContent = error.message;
      queryStatus.dataset.state = "error";
    } finally {
      queryDirectory.disabled = false;
    }
  });
  const form = el("form", {class: "editor-form"}, [
    field("Directory source", selectInput("source", ["ldap", "scim"], "ldap")),
    field("Users JSON", textareaInput("users", '[{"externalId":"directory-1","email":"person@example.com","name":"Person","role":"viewer","status":"active","groupIds":[]}]')),
    el("button", {class: "button button--primary", type: "submit"}, "Synchronize directory")
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      const result = await client.directory.sync({source: values.source, users: JSON.parse(String(values.users))});
      saveStatus(form, `Synchronized ${result.synchronizedCount} users.`, "ok");
      onSaved?.(result);
    } catch (error) {
      saveStatus(form, error.message, "error");
    }
  });
  return el("section", {}, [el("p", {}, "The managed sync connects over verified LDAPS using the external bind credential, maps users, departments and groups, and disables missing directory-managed accounts. The bounded JSON path remains available for SCIM bridges and controlled recovery."), queryDirectory, queryStatus, el("details", {}, [el("summary", {}, "Advanced normalized batch"), form])]);
}

export function webhookDeliveryPanel(client, webhooks = [], deliveries = [], {onSaved} = {}) {
  const controls = webhooks.map((webhook) => {
    const button = el("button", {class: "button", type: "button", disabled: webhook.enabled === false ? "true" : undefined}, `Deliver test to ${webhook.name ?? webhook.id}`);
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const delivery = await client.webhooks.deliver(webhook.id, {eventType: "integration.test", payload: {sentAt: new Date().toISOString()}});
        button.textContent = titleCase(delivery.status);
        onSaved?.(delivery);
      } catch (error) {
        button.textContent = error.message;
        button.disabled = false;
      }
    });
    return button;
  });
  return el("section", {}, [
    el("div", {class: "button-row"}, controls.length ? controls : [el("span", {}, "Configure an HTTPS webhook in Workspace capabilities first.")]),
    deliveries.length ? dataTable(["Webhook", "Event", "Status", "HTTP", "Completed"], deliveries.map((delivery) => [delivery.webhookId, delivery.eventType, badge(delivery.status, delivery.status === "delivered" ? "good" : "danger"), delivery.responseStatus ?? "—", formatDate(delivery.completedAt)])) : emptyView("No webhook deliveries yet.")
  ]);
}

export function sharedWorkView(shared, client, {onSaved} = {}) {
  const {share, project, workItem, activity = []} = shared;
  const conversation = activityList(activity);
  const canComment = share.permissions.includes("comment");
  const comment = el("form", {class: "editor-form"}, [
    field("Comment", textareaInput("summary", "Add a comment visible to the project team")),
    el("button", {class: "button button--primary", type: "submit", disabled: canComment ? undefined : "true"}, canComment ? "Post comment" : "Read-only share")
  ]);
  comment.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await client.externalShares.comment(share.token, {summary: new FormData(comment).get("summary")});
      saveStatus(comment, "Comment posted.", "ok");
      onSaved?.();
    } catch (error) {
      saveStatus(comment, error.message, "error");
    }
  });
  return el("section", {class: "shared-work"}, [
    dataTable(["Shared item", "Details"], [["Project", project.name], ["Task", workItem.title], ["Status", titleCase(workItem.status)], ["Priority", titleCase(workItem.priority)], ["Due", formatDate(workItem.dueDate) || "Not set"], ["Access", share.permissions.join(", ")], ["Expires", formatDate(share.expiresAt)]]),
    workItem.description ? el("article", {class: "prose-card"}, [el("h2", {}, "Description"), el("p", {}, workItem.description)]) : "",
    actionPanel("External-safe activity", conversation, {open: true, meta: `${activity.length} records`}),
    actionPanel("Comment", comment, {open: canComment})
  ]);
}

export function planningReportTablesView(summary) {
  return el("section", {class: "reports"}, [
    dataTable(["Time period", "Goal", "Done", "Remaining"], (summary.byPeriod ?? []).map((period) => [
      period.name,
      period.goal || "",
      `${period.pointsDone} / ${period.pointsTotal}`,
      period.pointsRemaining
    ])),
    dataTable(["Milestone", "Done", "Active work"], (summary.byMilestone ?? []).map((milestone) => [
      milestone.name,
      `${milestone.pointsDone} / ${milestone.pointsTotal}`,
      milestone.activeCount
    ])),
    dataTable(["Signal", "Count"], [
      ["Linked tasks", summary.relationshipCount ?? 0],
      ["Acceptance criteria", summary.acceptanceCriteriaCount ?? 0],
      ["Watched items", summary.watchedCount ?? 0]
    ])
  ]);
}

export const planningDashboard = planningDashboardView;
export const planningWorkbench = planningWorkbenchView;
export const planningWorkItemForm = planningWorkItemFormView;
export const planningReportTables = planningReportTablesView;

export function adminPanel(data) {
  return dataTable(["Field", "Value"], [
    ["Account", data.workspace.name],
    ["User", data.user.email],
    ["Role", data.membership.role],
    ["Authentication", "Cognito hosted UI with PKCE in production"]
  ]);
}
