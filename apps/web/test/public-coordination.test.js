// @ts-nocheck

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {JSDOM} from "jsdom";

const page = readFileSync(new URL("../src/community/opengeo.md", import.meta.url), "utf8");
const login = readFileSync(new URL("../src/local-login.md", import.meta.url), "utf8");

test("public roadmap is a standalone read-only page with exact project naming", () => {
  assert.match(page, /title: OpenGeo Studio \[community edition\]/);
  assert.match(page, /publicCoordinationClient/);
  assert.match(page, /coordinationDashboard/);
  assert.doesNotMatch(page, /workspaceTopNav|\bapiClient\b|bootstrap|canEdit|canManage|public-demo-entry|sample/);
  assert.match(login, /name="key" type="password"/);
  assert.match(login, /<form[^>]*method="post"[^>]*data-local-login/);
  assert.match(login, /<button[^>]*type="submit" disabled/);
  assert.match(login, /form.addEventListener\("submit"/);
  assert.match(login, /await localSignIn\(form.elements.key.value\)/);
  assert.doesNotMatch(login, /console\.|localStorage|sessionStorage|\.click\(\)/);
});

test("local login enables submission only after configuration and the submit listener are ready", async () => {
  const dom = new JSDOM(login.split("```js")[0], {url: "http://127.0.0.1:3000/local-login"});
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  globalThis.document = dom.window.document;
  const form = document.querySelector("[data-local-login]");
  const button = form.querySelector("button");
  let releaseConfig;
  const config = new Promise((resolve) => {releaseConfig = resolve;});
  const calls = [];
  const script = login.split("```js\n")[1].split("```")[0].replace(/^import .*;\n/m, "");
  try {
    assert.equal(form.method, "post", "native fallback cannot place the key in a URL query");
    assert.equal(button.disabled, true);
    const initialize = new Function("runtimeConfig", "localSignIn", `return (async () => {${script}})();`);
    const initialized = initialize(() => config, async (key) => {calls.push(key);});
    assert.equal(button.disabled, true, "asynchronous configuration cannot leave an active native submit button");
    assert.equal(calls.length, 0);
    releaseConfig({localAuth: {enabled: true}});
    await initialized;
    assert.equal(button.disabled, false);
    form.elements.key.value = "submitted-access-key";
    const submission = new dom.window.Event("submit", {cancelable: true});
    form.dispatchEvent(submission);
    assert.equal(submission.defaultPrevented, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["submitted-access-key"]);
    assert.equal(form.elements.key.value, "");
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
    dom.window.close();
  }
});

test("anonymous community requests omit credentials and never read the private session", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {url: "http://127.0.0.1:3000/community/opengeo"});
  const keys = ["location", "sessionStorage", "localStorage", "__TEAMSPACES_LOCAL_CONFIG__", "fetch"];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const calls = [];
  const noPrivateStorage = {getItem() {throw new Error("Public access read private storage");}, setItem() {throw new Error("Public access wrote private storage");}};
  Object.assign(globalThis, {
    location: dom.window.location,
    sessionStorage: noPrivateStorage,
    localStorage: noPrivateStorage,
    __TEAMSPACES_LOCAL_CONFIG__: {apiBaseUrl: "http://localhost:8787/api/v1", authMode: "local", publicDemo: {enabled: false}},
    fetch: async (url, options) => {
      calls.push({url, options});
      return new Response(JSON.stringify({data: {audience: "public", sample: false, readOnly: true, title: "OpenGeo Studio [community edition]", tasks: [], projects: []}}), {status: 200});
    }
  });
  try {
    const {publicCoordinationClient} = await import("../src/lib/api.js");
    const client = await publicCoordinationClient();
    assert.deepEqual(Object.keys(client), ["isPublicCoordination", "projects", "coordination"]);
    assert.deepEqual(Object.keys(client.coordination), ["get"]);
    const controller = new AbortController();
    const result = await client.coordination.get({initiativeId: "opengeo", signal: controller.signal});
    assert.equal(result.sample, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://localhost:8787/api/v1/public/coordination/opengeo");
    assert.equal(calls[0].options.method, "GET");
    assert.equal(calls[0].options.credentials, "omit");
    assert.equal(calls[0].options.headers, undefined);
    assert.equal(calls[0].options.body, undefined);
    assert.equal(calls[0].options.signal, controller.signal);
    await client.coordination.get({initiativeId: "teamspaces"});
    assert.equal(calls[1].url, "http://localhost:8787/api/v1/public/coordination/teamspaces");
    await client.projects.list();
    assert.equal(calls[2].url, "http://localhost:8787/api/v1/public/projects");
    assert.equal(calls[2].options.credentials, "omit");
    assert.equal(calls[2].options.headers, undefined);
    await assert.rejects(client.coordination.get({initiativeId: "../private"}), /Choose a public project/);
    assert.equal(calls.length, 3);
    globalThis.fetch = async () => new Response(JSON.stringify({data: {audience: "private", sample: true}}), {status: 200});
    await assert.rejects(client.coordination.get({initiativeId: "opengeo"}), /public project roadmap response is unavailable/);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});

test("public project navigation uses actual records and keeps project names out of platform pages", async () => {
  const directoryPage = readFileSync(new URL("../src/projects.md", import.meta.url), "utf8");
  const projectPage = readFileSync(new URL("../src/projects/project.md", import.meta.url), "utf8");
  assert.match(directoryPage, /client.projects.list/);
  assert.match(projectPage, /data.projects.find/);
  assert.doesNotMatch(directoryPage + projectPage, /OpenGeo|opengeo|\bapiClient\b|workspaceTopNav|bootstrap/);
  assert.doesNotMatch(login, /OpenGeo|opengeo/);
  const dom = new JSDOM("<body></body>");
  const previous = ["document", "Node"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.assign(globalThis, {document: dom.window.document, Node: dom.window.Node});
  try {
    const {publicProjectDirectory} = await import("../src/components/public-projects.js");
    const list = publicProjectDirectory({projects: [{id: "one", initiativeId: "first", name: "First project"}, {id: "two", initiativeId: "second", name: "Second <project>"}], truncated: false});
    assert.equal(list.querySelectorAll("article").length, 2);
    assert.equal(list.querySelectorAll("a")[1].getAttribute("href"), "/projects/project?initiativeId=second&projectId=two");
    assert.match(list.textContent, /Second <project>/);
    assert.equal(list.querySelector("project"), null);
    assert.equal(list.querySelector("form,button,input"), null);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});
