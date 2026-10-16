---
title: Notifications
---

```js
import {apiClient} from "../lib/api.js";
import {actionPanel, errorView, notificationCenter, notificationDigestView, notificationPreferencesForm, pageHeader, workspaceTopNav} from "../components/ui.js";
```

```js
display(workspaceTopNav());
const client = await apiClient();
const filter = new URL(location.href).searchParams.get("filter") ?? "all";
const result = await Promise.all([client.notifications.list({filter, signal: invalidation}), client.notifications.digest({signal: invalidation}), client.notifications.preferences({signal: invalidation}), client.integrations.catalog({signal: invalidation}), client.projects.list({limit: 100, signal: invalidation})]).catch((error) => error);
```

```js
display(pageHeader({
  eyebrow: "Awareness",
  title: "Notifications",
  description: "Review assignments, watched task activity, mentions, and personal reminders."
}));
if (result instanceof Error) display(errorView(result, () => location.reload()));
else {
  const [notifications, digest, preferences, integrations, projects] = result;
  display(actionPanel("Notification center", notificationCenter(notifications, client, {filter}), {open: true, meta: `${notifications.summary.unreadCount} unread of ${notifications.summary.totalCount}`}));
  display(actionPanel("Notification preferences", notificationPreferencesForm(preferences, client, integrations.webhooks, projects.items), {open: true, meta: `${preferences.emailDigest} email summary`}));
  display(actionPanel("Email summary and date alerts", notificationDigestView(digest, client, integrations.webhooks, preferences), {open: true, meta: `${digest.summary.dateAlertCount} date alerts`}));
}
```
