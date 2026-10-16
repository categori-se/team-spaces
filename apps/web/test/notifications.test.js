// @ts-nocheck

import assert from "node:assert/strict";
import test from "node:test";
import {JSDOM} from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {url: "http://127.0.0.1:3000/app/notifications"});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  Element: dom.window.Element,
  FormData: dom.window.FormData,
  location: dom.window.location
});

const {notificationPreferencesForm} = await import("../src/components/ui.js");

test("notification preferences expose schedules and preserve per-project participation rules", async () => {
  const saved = [];
  const form = notificationPreferencesForm({
    version: 3,
    participationRules: ["assigned", "watching"],
    projectOverrides: [{projectId: "project-one", participationRules: ["accountable"]}],
    dateAlertsEnabled: true,
    emailDigest: "weekly",
    deliveryWebhookId: "mail",
    digestHourUtc: 14,
    weeklyDay: 5,
    scheduledDeliveryAvailable: false
  }, {notifications: {savePreferences: async (body) => saved.push(body)}}, [
    {id: "mail", name: "Mail", enabled: true, eventTypes: ["notification.digest"]},
    {id: "unrelated", name: "Unrelated", enabled: true, eventTypes: ["work.updated"]}
  ], [{id: "project-one", name: "Project one"}], {onSaved: () => {}});
  document.body.replaceChildren(form);

  assert.equal(form.querySelector("select[name='emailDigest']")?.value, "weekly");
  assert.equal(form.querySelector("select[name='deliveryWebhookId']")?.value, "mail");
  assert.equal(form.querySelector("select[name='deliveryWebhookId']")?.querySelector("option[value='unrelated']"), null);
  assert.equal(form.querySelector("input[name='overrideProjectIds']")?.checked, true);
  assert.match(form.textContent ?? "", /Scheduled delivery is disabled/);

  form.dispatchEvent(new window.Event("submit", {bubbles: true, cancelable: true}));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], {
    version: 3,
    participationRules: ["assigned", "watching"],
    projectOverrides: [{projectId: "project-one", participationRules: ["accountable"]}],
    dateAlertsEnabled: true,
    emailDigest: "weekly",
    deliveryWebhookId: "mail",
    digestHourUtc: 14,
    weeklyDay: 5
  });
});
