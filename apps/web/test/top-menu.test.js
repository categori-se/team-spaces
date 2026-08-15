// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {JSDOM} from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://127.0.0.1:3000/app"
});

Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  Element: dom.window.Element,
  location: dom.window.location,
  history: dom.window.history,
  localStorage: dom.window.localStorage,
  sessionStorage: dom.window.sessionStorage,
  __TEAMSPACES_LOCAL_CONFIG__: {
    apiBaseUrl: "http://127.0.0.1:8787/api/v1",
    authMode: "demo",
    appOrigin: "http://127.0.0.1:3000"
  }
});

const {errorView, loadingView, projectTemplateGallery, workspaceTopNav} = await import("../src/components/ui.js");

function settleToggle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function keydown(target, key) {
  target.dispatchEvent(new dom.window.KeyboardEvent("keydown", {bubbles: true, cancelable: true, key}));
}

test("top menus expose accessible state and behave as one keyboard-operable menu group", async () => {
  const bar = workspaceTopNav();
  document.body.append(bar);

  const create = bar.querySelector("[data-header-menu='create']");
  const manage = bar.querySelector("[data-header-menu='manage']");
  const createSummary = create.querySelector(":scope > summary");
  const manageSummary = manage.querySelector(":scope > summary");
  const createPanel = create.querySelector(".header-menu__panel");

  assert.equal(createSummary.getAttribute("aria-haspopup"), "menu");
  assert.equal(createSummary.getAttribute("aria-expanded"), "false");
  assert.equal(createSummary.getAttribute("aria-controls"), createPanel.id);
  assert.equal(createPanel.getAttribute("aria-labelledby"), createSummary.id);
  assert.equal(createPanel.getAttribute("role"), "menu");
  assert.ok(createSummary.querySelector(".header-menu__chevron"));
  assert.ok(createSummary.querySelectorAll(".ui-icon").length >= 2);
  const manageIcon = manageSummary.querySelector(".ui-icon:not(.header-menu__chevron)");
  assert.equal(manageIcon.querySelectorAll("circle").length, 3, "Manage uses the horizontal-sliders icon");
  assert.equal(manageIcon.querySelectorAll("path").length, 3);
  assert.ok(createPanel.querySelectorAll("[role='menuitem']").length > 1);

  createSummary.click();
  await settleToggle();
  assert.equal(create.open, true);
  assert.equal(createSummary.getAttribute("aria-expanded"), "true");

  manageSummary.click();
  await settleToggle();
  assert.equal(create.open, false, "opening Manage closes Create");
  assert.equal(createSummary.getAttribute("aria-expanded"), "false");
  assert.equal(manage.open, true);
  assert.equal(manageSummary.getAttribute("aria-expanded"), "true");

  document.body.dispatchEvent(new dom.window.Event("pointerdown", {bubbles: true}));
  assert.equal(manage.open, false, "an outside pointer press closes the open menu");

  createSummary.focus();
  keydown(createSummary, "ArrowDown");
  const createItems = [...createPanel.querySelectorAll("[role='menuitem']")];
  assert.equal(create.open, true);
  assert.equal(document.activeElement, createItems[0]);

  keydown(createItems[0], "ArrowDown");
  assert.equal(document.activeElement, createItems[1]);
  keydown(createItems[1], "End");
  assert.equal(document.activeElement, createItems.at(-1));
  keydown(createItems.at(-1), "Escape");
  assert.equal(create.open, false);
  assert.equal(document.activeElement, createSummary, "Escape returns focus to the menu trigger");

  keydown(createSummary, "ArrowRight");
  assert.equal(document.activeElement, manageSummary, "horizontal arrows move between top-menu triggers");

  manageSummary.click();
  await settleToggle();
  const manageLink = manage.querySelector(".header-menu__item");
  manageLink.addEventListener("click", (event) => event.preventDefault(), {once: true});
  manageLink.click();
  assert.equal(manage.open, false, "choosing an item dismisses its menu");
});

test("async and form feedback exposes live semantics without an implicit retry submit", () => {
  const loading = loadingView("Loading projects");
  assert.equal(loading.getAttribute("role"), "status");
  assert.equal(loading.getAttribute("aria-live"), "polite");
  assert.equal(loading.getAttribute("aria-busy"), "true");

  const error = errorView(new Error("Unable to load"), () => undefined);
  assert.equal(error.getAttribute("role"), "alert");
  assert.equal(error.querySelector("button").type, "button");

  const templates = projectTemplateGallery({}, {portfolios: [], memberships: []});
  const status = templates.querySelector(".form-status");
  assert.equal(status.getAttribute("role"), "status");
  assert.equal(status.getAttribute("aria-live"), "polite");
});
