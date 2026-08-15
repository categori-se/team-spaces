// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {JSDOM} from "jsdom";
import {putUpload} from "../src/lib/api.js";

test("document PUT forwards the signed headers and rejects an S3 error", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({url, options});
    return new Response("Forbidden", {status: 403});
  };
  const headers = {
    "content-type": "text/plain",
    "if-none-match": "*",
    "x-amz-server-side-encryption": "AES256"
  };
  try {
    await assert.rejects(
      putUpload("https://uploads.example.test/signed", new Blob(["payload"]), headers),
      /Document upload failed \(403\)/
    );
    assert.deepEqual(calls[0].options.headers, headers);
    assert.equal(calls[0].options.method, "PUT");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public demo requests use the isolated API without identity, account, or Cognito headers", async () => {
  const globalKeys = ["window", "location", "history", "localStorage", "sessionStorage", "__TEAMSPACES_LOCAL_CONFIG__", "fetch"];
  const previousDescriptors = new Map(globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://127.0.0.1:3000/app?demo=1"
  });
  const calls = [];
  Object.assign(globalThis, {
    window: dom.window,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage,
    __TEAMSPACES_LOCAL_CONFIG__: {
      apiBaseUrl: "http://127.0.0.1:8787/api/v1",
      authMode: "cognito",
      appOrigin: "http://127.0.0.1:3000",
      cognito: {
        domain: "https://auth.example.test",
        clientId: "client-id",
        redirectUri: "http://127.0.0.1:3000/app"
      },
      publicDemo: {
        enabled: true,
        apiBaseUrl: "/api/v1/demo",
        resetsAt: "05:00 UTC"
      }
    },
    fetch: async (url, options) => {
      calls.push({url, options});
      return new Response(JSON.stringify({data: {ok: true}}), {
        status: 200,
        headers: {"content-type": "application/json"}
      });
    }
  });
  localStorage.setItem("teamspaces.accountId", "workspace-private");
  sessionStorage.setItem("teamspaces.session", JSON.stringify({
    accessToken: "private-access-token",
    idToken: "private-id-token",
    expiresAt: Date.now() + 15 * 60_000
  }));

  try {
    const {ApiError, apiClient} = await import(`../src/lib/api.js?public-demo=${Date.now()}`);
    const client = await apiClient();
    assert.equal(client.mode, "public-demo");
    assert.equal(client.isPublicDemo, true);
    assert.equal(client.publicDemo.resetsAt, "05:00 UTC");

    await client.me();
    assert.equal(calls[0].url, "/api/v1/demo/me");
    assert.equal(calls[0].options.headers.authorization, undefined);
    assert.equal(calls[0].options.headers["x-teamspaces-account-id"], undefined);
    assert.equal(calls[0].options.headers["x-demo-user-id"], undefined);
    assert.equal(calls[0].options.headers["x-demo-user-email"], undefined);
    assert.equal(calls[0].options.headers["x-demo-user-name"], undefined);

    globalThis.fetch = async () => new Response(JSON.stringify({
      status: 401,
      title: "Unauthorized",
      detail: "Demo session unavailable"
    }), {status: 401, headers: {"content-type": "application/json"}});
    await assert.rejects(client.me(), (error) => error instanceof ApiError && error.status === 401);
    assert.equal(sessionStorage.getItem("teamspaces.pkce.verifier"), null, "demo 401 does not start Cognito PKCE");
    assert.equal(sessionStorage.getItem("teamspaces.oauth.state"), null, "demo 401 does not start Cognito OAuth state");
    assert.equal(sessionStorage.getItem("teamspaces.public-demo"), "active");

    globalThis.fetch = async () => new Response(JSON.stringify({message: "Service Unavailable"}), {
      status: 503,
      headers: {"content-type": "application/json"}
    });
    await assert.rejects(
      client.documents.list(),
      (error) => error instanceof ApiError && error.status === 503 && error.message === "Service Unavailable"
    );

    globalThis.fetch = async () => new Response(null, {status: 502});
    await assert.rejects(
      client.documents.list(),
      (error) => error instanceof ApiError && error.status === 502 && error.message === "Request failed"
    );
  } finally {
    delete globalThis[Symbol.for("teamspaces.auth.callback-promise")];
    dom.window.close();
    for (const [key, descriptor] of previousDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
