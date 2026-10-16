// @ts-nocheck

import assert from "node:assert/strict";
import test from "node:test";
import {JSDOM} from "jsdom";
import {providerIntegrationPanel} from "../src/components/ui.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {url: "http://127.0.0.1:3000/app/integrations"});
Object.assign(globalThis, {window: dom.window, document: dom.window.document, Node: dom.window.Node, FormData: dom.window.FormData});
const settle = () => new Promise((resolve) => setImmediate(resolve));
const connectors = [{id: "github", name: "GitHub", type: "github", adapter: {operational: true}}, {id: "other", name: "Other provider", adapter: {operational: true}}];
const projects = [{id: "community", name: "OpenGeo Studio [community edition]"}];

test("provider browse renders actual project fields, item status and bounded paging without automatic work", async () => {
  const reads = [];
  const links = [];
  const first = {
    project: {id: "board", title: "Community development", url: "https://github.com/orgs/example/projects/1", public: true, fields: [{id: "status", name: "Status", dataType: "SINGLE_SELECT", options: [{id: "ready", name: "Ready"}, {id: "doing", name: "In progress"}]}]},
    items: [{id: "item-1", title: "Save and reopen", kind: "project-item", externalUrl: "https://github.com/example/repository/issues/1", metadata: {repository: "example/repository", state: "OPEN", fieldValues: [{fieldId: "status", fieldName: "Status", optionId: "doing", name: "In progress"}, {fieldId: "parity", fieldName: "Parity", text: "GEOLIBRE-001"}], fieldValuesPageInfo: {hasNextPage: true}}}],
    nextCursor: "next-page", itemsPageInfo: {hasNextPage: true}, fieldsPageInfo: {hasNextPage: true}, truncated: true, filtered: true, redacted: true
  };
  const panel = providerIntegrationPanel({integrations: {
    resources: async (...args) => {reads.push(args); return reads.length === 1 ? first : {items: [{id: "draft-2", title: "Review native publication", kind: "project-item", metadata: {contentType: "DraftIssue", fieldValues: [{fieldName: "Status", name: "Backlog"}]}}], itemsPageInfo: {hasNextPage: false}};},
    link: async (body) => {links.push(body);}
  }}, {projects, connectors});
  document.body.replaceChildren(panel);
  assert.equal(reads.length, 0);
  assert.equal(links.length, 0);
  panel.querySelector("form").dispatchEvent(new window.Event("submit", {cancelable: true}));
  await settle();
  assert.equal(reads.length, 1);
  assert.equal(links.length, 0);
  assert.match(panel.textContent, /Community development/);
  assert.match(panel.textContent, /Public GitHub project/);
  assert.match(panel.textContent, /Ready, In progress/);
  assert.match(panel.textContent, /Status: In progress/);
  assert.match(panel.textContent, /Parity: GEOLIBRE-001/);
  assert.match(panel.textContent, /Additional field values were not returned/);
  assert.match(panel.textContent, /Additional project fields were not returned/);
  assert.match(panel.textContent, /outside this connector's repository scope/);
  assert.match(panel.textContent, /unavailable to this provider connection/);
  assert.match(panel.textContent, /This response is partial/);
  assert.equal(panel.querySelector('.integration-provider-project a').rel, "noopener noreferrer");
  panel.querySelector("[data-load-more]").click();
  await settle();
  assert.equal(reads.length, 2);
  assert.equal(reads[1][1].cursor, "next-page");
  assert.match(panel.textContent, /Save and reopen/);
  assert.match(panel.textContent, /Review native publication/);
  assert.equal(panel.querySelector("[data-load-more]"), null);
  panel.querySelector('[name="connectorId"]').value = "other";
  [...panel.querySelectorAll("button")].find((button) => button.textContent === "Link").click();
  await settle();
  assert.equal(links.length, 1);
  assert.equal(links[0].connectorId, "github", "links retain the provider that returned the resource");
  assert.equal(links[0].externalId, "item-1");
  assert.deepEqual(links[0].metadata.fieldValues, first.items[0].metadata.fieldValues);
});

test("a filtered or redacted result never claims that the board has no resources", async () => {
  const panel = providerIntegrationPanel({integrations: {resources: async () => ({project: {title: "Private delivery", public: false, url: "javascript:alert(1)", fields: []}, items: [], filtered: true, redacted: true})}}, {projects, connectors});
  document.body.replaceChildren(panel);
  panel.querySelector("form").dispatchEvent(new window.Event("submit", {cancelable: true}));
  await settle();
  assert.match(panel.textContent, /No matching resources were returned in this page/);
  assert.match(panel.textContent, /Private GitHub project/);
  assert.doesNotMatch(panel.textContent, /The provider returned no matching resources/);
  assert.equal(panel.querySelector('a[href^="javascript:"]'), null);
});
