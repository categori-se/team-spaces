// @ts-nocheck

import assert from "node:assert/strict";
import test from "node:test";
import {JSDOM} from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {url: "http://127.0.0.1:3000/app/content"});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  Element: dom.window.Element,
  Event: dom.window.Event,
  FormData: dom.window.FormData,
  location: dom.window.location
});

const {collaborativeContentEditor, contentEditOperations} = await import("../src/components/ui.js");

test("web collaboration emits a minimal change and stable merge identity", async () => {
  assert.deepEqual(contentEditOperations("alpha beta gamma", "alpha BETA gamma"), [
    {type: "delete", index: 6, count: 4},
    {type: "insert", index: 6, text: "BETA"}
  ]);
  const requests = [];
  const client = {projectContent: {
    operations: async (_projectId, _contentId, body) => {
      requests.push(body);
      return {id: "content-one", projectId: "project-one", body: "alpha BETA gamma", version: 4, collaboration: {merged: true}};
    },
    updatePresence: async () => ({}),
    get: async () => ({id: "content-one", body: "alpha beta gamma", version: 3}),
    presence: async () => ({items: []})
  }};
  let saved;
  const form = collaborativeContentEditor(client, {id: "project-one", name: "Project one"}, {id: "content-one", projectId: "project-one", body: "alpha beta gamma", version: 3}, [], {onSaved: (value) => { saved = value; }});
  document.body.replaceChildren(form);
  const editor = form.querySelector("textarea[name='body']");
  editor.value = "alpha BETA gamma";
  editor.dispatchEvent(new window.Event("input", {bubbles: true}));
  form.dispatchEvent(new window.Event("submit", {bubbles: true, cancelable: true}));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].version, 3);
  assert.equal(typeof requests[0].changeId, "string");
  assert.deepEqual(requests[0].operations, contentEditOperations("alpha beta gamma", "alpha BETA gamma"));
  assert.equal(editor.value, "alpha BETA gamma");
  assert.match(form.querySelector(".form-status").textContent, /Merged concurrent edits/);
  assert.equal(saved.version, 4);
  window.dispatchEvent(new window.Event("pagehide"));
});
