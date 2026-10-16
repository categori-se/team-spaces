// @ts-nocheck

import {defaultNotificationPreferences} from "@teamspaces/contracts";
import {hasPermission, permissions} from "../authorization/rbac.js";

const defaultParticipationRules = ["assigned", "accountable", "watching"];

function hasProjectAccess(projectId, allowedProjectIds = []) {
  return !projectId || !Array.isArray(allowedProjectIds) || allowedProjectIds.length === 0 || allowedProjectIds.includes(projectId);
}

/**
 * Capture recipients when a work-item event is written. This preserves why a
 * person was notified even when the task is reassigned later.
 */
export function workNotificationRecipients(item = {}) {
  const recipients = [];
  if (item.assigneeId) recipients.push({userId: item.assigneeId, reason: "assigned"});
  if (item.accountableId) recipients.push({userId: item.accountableId, reason: "accountable"});
  for (const userId of item.watcherIds ?? []) recipients.push({userId, reason: "watching"});
  return recipients.filter((recipient, index) => recipient.userId
    && recipients.findIndex((candidate) => candidate.userId === recipient.userId && candidate.reason === recipient.reason) === index);
}

/**
 * Select the activity events that are actionable notifications for a user.
 */
export function notificationEvents(activity = [], context = {}, capabilities = {}) {
  const preferences = context.notificationPreferences ?? {};
  const configuredRules = preferences.participationRules ?? capabilities.notifications?.participationRules ?? [];
  const participationRules = new Set(Array.isArray(preferences.participationRules)
    ? preferences.participationRules
    : configuredRules.length ? configuredRules : defaultParticipationRules);
  const projectRules = new Map((preferences.projectOverrides ?? []).map((override) => [override.projectId, new Set(override.participationRules ?? [])]));
  const canViewInternal = Boolean(context.canViewInternal);
  const now = new Date().toISOString();

  return activity.filter((item) => hasProjectAccess(item.projectId, context.allowedProjectIds)
    && (item.visibility !== "internal" || canViewInternal))
    .flatMap((item) => {
      const reasons = [];
      if (item.actorId === context.actorId && item.reminderAt) reasons.push("reminder");
      if (item.actorId !== context.actorId && item.mentions?.includes(context.actorId)) reasons.push("mention");
      if (item.actorId !== context.actorId) {
        const rules = projectRules.get(item.projectId) ?? participationRules;
        for (const recipient of item.notificationRecipients ?? []) {
          if (recipient.userId === context.actorId && rules.has(recipient.reason)) reasons.push(recipient.reason);
        }
      }
      const uniqueReasons = [...new Set(reasons)];
      if (!uniqueReasons.length) return [];
      const reminder = uniqueReasons.includes("reminder");
      const mention = uniqueReasons.includes("mention");
      return [{
        ...item,
        ...(item.actorId === context.actorId ? {} : {reminderAt: undefined}),
        notificationType: reminder ? "reminder" : mention ? "mention" : "participation",
        reasons: uniqueReasons,
        due: Boolean(reminder && item.reminderAt && item.reminderAt <= now)
      }];
    });
}

/**
 * Attach persisted read state and group events by the record they describe.
 */
export function groupNotificationEvents(events = [], readStates = {}, filter = "all") {
  const withState = events.map((event) => ({
    ...event,
    readAt: readStates[event.id],
    unread: !readStates[event.id]
  }));
  const filtered = withState.filter((event) => filter === "all"
    || (filter === "unread" && event.unread)
    || (filter === "read" && !event.unread));
  const groupsByEntity = new Map();
  for (const event of filtered) {
    const key = `${event.projectId ?? "workspace"}:${event.entityType}:${event.entityId}`;
    const group = groupsByEntity.get(key) ?? {
      id: key,
      projectId: event.projectId,
      entityType: event.entityType,
      entityId: event.entityId,
      events: [],
      reasons: []
    };
    group.events.push(event);
    group.reasons.push(...event.reasons);
    groupsByEntity.set(key, group);
  }
  const groups = [...groupsByEntity.values()].map((group) => ({
    ...group,
    reasons: [...new Set(group.reasons)],
    eventIds: group.events.map((event) => event.id),
    totalCount: group.events.length,
    unreadCount: group.events.filter((event) => event.unread).length,
    latestAt: group.events[0]?.timestamp,
    latestSummary: group.events[0]?.summary
  }));
  const unreadCount = withState.filter((event) => event.unread).length;
  return {
    filter,
    items: filtered,
    groups,
    summary: {
      totalCount: withState.length,
      unreadCount,
      readCount: withState.length - unreadCount,
      displayedCount: filtered.length
    }
  };
}

export function notificationReadIds(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.ids)) return [];
  return [...new Set(body.ids.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))].slice(0, 100);
}

export function effectiveNotificationPreferences(capabilities = {}, stored = {}) {
  const defaults = {
    ...structuredClone(defaultNotificationPreferences),
    participationRules: capabilities.notifications?.participationRules?.length
      ? [...capabilities.notifications.participationRules]
      : [...defaultParticipationRules],
    emailDigest: capabilities.notifications?.emailDigest ?? "none",
    deliveryWebhookId: capabilities.notifications?.deliveryWebhookId ?? "",
    digestHourUtc: Number(capabilities.notifications?.digestHourUtc ?? defaultNotificationPreferences.digestHourUtc),
    weeklyDay: Number(capabilities.notifications?.weeklyDay ?? defaultNotificationPreferences.weeklyDay)
  };
  return {...defaults, ...structuredClone(stored), participationRules: [...(stored.participationRules ?? defaults.participationRules)], projectOverrides: structuredClone(stored.projectOverrides ?? [])};
}

/** Build the current user's bounded scheduled/manual summary. */
export async function buildNotificationDigest(context, repository, {now = new Date(), preferences} = {}) {
  const [capabilities, workItems, activity] = await Promise.all([
    repository.getWorkspaceCapabilities(context),
    repository.listPlanningWorkItems({workspaceId: context.workspaceId, allowedProjectIds: context.membership?.projectIds, limit: 100}),
    repository.listActivity(undefined, context.workspaceId, 100)
  ]);
  const selectedPreferences = preferences ?? await repository.getNotificationPreferences(context, capabilities);
  const today = now.toISOString().slice(0, 10);
  const day = 86400000;
  const dayDistance = (date) => Math.round((new Date(`${date}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / day);
  const rules = selectedPreferences.dateAlertsEnabled === false
    ? []
    : (capabilities.notifications?.dateAlerts ?? []).filter((rule) => rule.enabled !== false);
  const dateAlerts = rules.flatMap((rule) => workItems.filter((item) => {
    if (!item.dueDate) return false;
    if (rule.projectId && item.projectId !== rule.projectId) return false;
    if (rule.projectIds?.length && !rule.projectIds.includes(item.projectId)) return false;
    if (rule.assignedOnly && item.assigneeId !== context.actorId) return false;
    const distance = dayDistance(item.dueDate);
    return distance <= Number(rule.daysBefore ?? 7) && distance >= -Number(rule.daysAfter ?? 0);
  }).map((item) => ({ruleId: rule.id, ruleName: rule.name ?? rule.id, daysUntilDue: dayDistance(item.dueDate), workItem: item})));
  const projectRules = new Map((selectedPreferences.projectOverrides ?? []).map((override) => [override.projectId, new Set(override.participationRules ?? [])]));
  const defaultRules = new Set(selectedPreferences.participationRules ?? defaultParticipationRules);
  const participated = workItems.filter((item) => {
    const participationRules = projectRules.get(item.projectId) ?? defaultRules;
    return (participationRules.has("assigned") && item.assigneeId === context.actorId)
      || (participationRules.has("accountable") && item.accountableId === context.actorId)
      || (participationRules.has("watching") && item.watcherIds?.includes(context.actorId));
  });
  const digestActivity = selectedPreferences.lastDeliveredAt
    ? activity.filter((item) => String(item.timestamp) > String(selectedPreferences.lastDeliveredAt))
    : activity;
  const notifications = notificationEvents(digestActivity, {
    actorId: context.actorId,
    allowedProjectIds: context.membership?.projectIds,
    canViewInternal: hasPermission(context.membership, permissions.projectManage),
    notificationPreferences: selectedPreferences
  }, capabilities);
  return {
    generatedAt: now.toISOString(),
    recipient: {userId: context.actorId, email: context.user?.email, name: context.user?.name},
    frequency: selectedPreferences.emailDigest,
    preferences: selectedPreferences,
    dateAlerts,
    participated,
    notifications,
    summary: {dateAlertCount: dateAlerts.length, participatedCount: participated.length, notificationCount: notifications.length}
  };
}

export function notificationScheduleHour(hour) {
  return `NOTIFICATION_SCHEDULE#HOUR#${String(hour).padStart(2, "0")}`;
}

export function notificationDigestPeriod(preferences, now = new Date()) {
  if (!preferences || preferences.emailDigest === "none" || now.getUTCHours() !== Number(preferences.digestHourUtc)) return undefined;
  const date = now.toISOString().slice(0, 10);
  if (preferences.emailDigest === "daily") return `daily#${date}`;
  if (preferences.emailDigest === "weekly" && now.getUTCDay() === Number(preferences.weeklyDay)) return `weekly#${date}`;
  return undefined;
}

/** Process an indexed due-hour batch. Repositories provide atomic claims. */
export async function processScheduledNotificationDigests(repository, now = new Date()) {
  const preferences = await repository.listScheduledNotificationPreferences(now);
  const results = [];
  for (let offset = 0; offset < preferences.length; offset += 5) {
    const batch = preferences.slice(offset, offset + 5);
    results.push(...await Promise.all(batch.map(async (item) => {
      const periodKey = notificationDigestPeriod(item, now);
      if (!periodKey) return {workspaceId: item.workspaceId, userId: item.userId, status: "not-due"};
      const claimed = await repository.claimScheduledNotificationDigest(item, periodKey);
      if (!claimed) return {workspaceId: item.workspaceId, userId: item.userId, status: "already-processed", periodKey};
      try {
        const context = await repository.getNotificationDeliveryContext(item);
        if (!context) {
          await repository.completeScheduledNotificationDigest(item, periodKey, {status: "inactive", completedAt: now.toISOString()});
          return {workspaceId: item.workspaceId, userId: item.userId, status: "inactive", periodKey};
        }
        const digest = await buildNotificationDigest(context, repository, {now, preferences: item});
        const signalCount = digest.summary.dateAlertCount + digest.summary.notificationCount;
        if (!signalCount) {
          await repository.completeScheduledNotificationDigest(item, periodKey, {status: "empty", completedAt: now.toISOString()});
          return {workspaceId: item.workspaceId, userId: item.userId, status: "empty", periodKey};
        }
        const delivery = await repository.deliverWebhook(context, item.deliveryWebhookId, {eventType: "notification.digest", payload: digest});
        if (delivery.status !== "delivered") throw new Error(`Notification gateway delivery ${delivery.status}`);
        await repository.completeScheduledNotificationDigest(item, periodKey, {status: "delivered", deliveryId: delivery.id, completedAt: now.toISOString()});
        return {workspaceId: item.workspaceId, userId: item.userId, status: "delivered", periodKey, deliveryId: delivery.id};
      } catch (error) {
        await repository.releaseScheduledNotificationDigest(item, periodKey);
        return {workspaceId: item.workspaceId, userId: item.userId, status: "failed", periodKey, error: error instanceof Error ? error.message : "Delivery failed"};
      }
    })));
  }
  const failed = results.filter((result) => result.status === "failed");
  if (failed.length) {
    const error = new Error(`${failed.length} scheduled notification digest delivery attempt(s) failed`);
    error.results = results;
    throw error;
  }
  return {checked: preferences.length, results};
}
