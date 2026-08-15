// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {JSDOM} from "jsdom";

const callbackPromiseKey = Symbol.for("teamspaces.auth.callback-promise");
let importSequence = 0;

async function withAuthBrowser(callback, search = "?code=callback-code&state=oauth-state&view=mine#public-demo-entry") {
  const globalKeys = ["window", "location", "history", "sessionStorage", "__TEAMSPACES_LOCAL_CONFIG__", "fetch"];
  const previousDescriptors = new Map(globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: `http://127.0.0.1:3000/app${search}`
  });
  dom.window.history.replaceState({preserve: "history-state"}, "", dom.window.location.href);
  Object.assign(globalThis, {
    window: dom.window,
    location: dom.window.location,
    history: dom.window.history,
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
    }
  });
  sessionStorage.setItem("teamspaces.pkce.verifier", "pkce-verifier");
  sessionStorage.setItem("teamspaces.oauth.state", "oauth-state");
  delete globalThis[callbackPromiseKey];

  try {
    const auth = await import(`../src/lib/auth.js?auth-test=${++importSequence}`);
    await callback(auth, dom);
  } finally {
    delete globalThis[callbackPromiseKey];
    dom.window.close();
    for (const [key, descriptor] of previousDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

function tokenResponse() {
  return new Response(JSON.stringify({
    access_token: "access-token",
    id_token: "id-token",
    refresh_token: "refresh-token",
    expires_in: 900
  }), {status: 200, headers: {"content-type": "application/json"}});
}

test("Cognito callback exchange is single-flight across concurrent consumers", async () => {
  await withAuthBrowser(async ({currentSession, handleAuthCallback}, dom) => {
    const secondAuthModule = await import(`../src/lib/auth.js?auth-test=${++importSequence}`);
    let releaseTokenResponse;
    const responseGate = new Promise((resolve) => {
      releaseTokenResponse = resolve;
    });
    const tokenCalls = [];
    globalThis.fetch = async (url, options) => {
      tokenCalls.push({url, options});
      await responseGate;
      return tokenResponse();
    };
    const startedAt = Date.now();
    sessionStorage.setItem("teamspaces.public-demo", "active");

    const headerCallback = handleAuthCallback();
    const apiCallback = secondAuthModule.handleAuthCallback();
    assert.equal(headerCallback, apiCallback, "even separate module instances share one promise");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tokenCalls.length, 1, "the one-use code is posted once");
    releaseTokenResponse();
    await Promise.all([headerCallback, apiCallback]);

    assert.equal(tokenCalls[0].url, "https://auth.example.test/oauth2/token");
    assert.equal(tokenCalls[0].options.method, "POST");
    assert.equal(tokenCalls[0].options.body.get("code"), "callback-code");
    assert.equal(tokenCalls[0].options.body.get("code_verifier"), "pkce-verifier");
    const stored = JSON.parse(sessionStorage.getItem("teamspaces.session"));
    assert.equal(stored.accessToken, "access-token");
    assert.equal(stored.idToken, "id-token");
    assert.equal(stored.refreshToken, "refresh-token");
    assert.ok(stored.expiresAt >= startedAt + 899_000);
    assert.equal(sessionStorage.getItem("teamspaces.pkce.verifier"), null, "used verifier is removed");
    assert.equal(sessionStorage.getItem("teamspaces.oauth.state"), null, "used OAuth state is removed");
    assert.equal(sessionStorage.getItem("teamspaces.public-demo"), null, "a Cognito callback leaves public demo mode");
    assert.equal(dom.window.location.pathname + dom.window.location.search + dom.window.location.hash, "/app?view=mine");
    assert.deepEqual(dom.window.history.state, {preserve: "history-state"});
    assert.equal((await currentSession()).authenticated, true, "the first render sees the saved session");
    await secondAuthModule.handleAuthCallback();
    assert.equal(tokenCalls.length, 1, "a later consumer cannot redeem the code again");
  });
});

test("a public demo entry is session-scoped and preserves a usable Cognito session", async () => {
  await withAuthBrowser(async ({currentSession}, dom) => {
    const cognitoSession = {
      accessToken: "existing-access-token",
      idToken: "existing-id-token",
      refreshToken: "existing-refresh-token",
      expiresAt: Date.now() + 15 * 60_000
    };
    sessionStorage.setItem("teamspaces.session", JSON.stringify(cognitoSession));

    const session = await currentSession();

    assert.equal(session.authenticated, true);
    assert.equal(session.mode, "public-demo");
    assert.equal(session.accessToken, undefined);
    assert.equal(session.publicDemo.resetsAt, "05:00 UTC");
    assert.equal(sessionStorage.getItem("teamspaces.public-demo"), "active");
    assert.deepEqual(JSON.parse(sessionStorage.getItem("teamspaces.session")), cognitoSession);
    assert.equal(dom.window.location.pathname + dom.window.location.search + dom.window.location.hash, "/app?view=mine");
  }, "?view=mine#public-demo-entry");
});

test("the landing demo action enters public demo without discarding Cognito tokens", async () => {
  await withAuthBrowser(async ({enterPublicDemo}) => {
    const rawSession = JSON.stringify({
      accessToken: "existing-access-token",
      idToken: "existing-id-token",
      expiresAt: Date.now() + 15 * 60_000
    });
    sessionStorage.setItem("teamspaces.session", rawSession);
    globalThis.location = {
      hostname: "127.0.0.1",
      origin: "http://127.0.0.1:3000",
      href: "http://127.0.0.1:3000/"
    };

    await enterPublicDemo();

    assert.equal(sessionStorage.getItem("teamspaces.public-demo"), "active");
    assert.equal(sessionStorage.getItem("teamspaces.session"), rawSession);
    assert.equal(location.href, "/app#public-demo-entry");
  }, "");
});

test("leaving public demo does not sign out an existing Cognito session", async () => {
  await withAuthBrowser(async ({signOut}) => {
    const rawSession = JSON.stringify({
      accessToken: "existing-access-token",
      idToken: "existing-id-token",
      expiresAt: Date.now() + 15 * 60_000
    });
    sessionStorage.setItem("teamspaces.session", rawSession);
    sessionStorage.setItem("teamspaces.public-demo", "active");
    globalThis.location = {
      hostname: "127.0.0.1",
      origin: "http://127.0.0.1:3000",
      href: "http://127.0.0.1:3000/app"
    };

    await signOut();

    assert.equal(sessionStorage.getItem("teamspaces.public-demo"), null);
    assert.equal(sessionStorage.getItem("teamspaces.session"), rawSession);
    assert.equal(location.href, "/");
  }, "");
});

test("a failed callback stays retryable without saving a partial session", async () => {
  await withAuthBrowser(async ({handleAuthCallback}) => {
    let tokenCalls = 0;
    globalThis.fetch = async () => {
      tokenCalls += 1;
      return tokenCalls === 1 ? new Response("Unavailable", {status: 503}) : tokenResponse();
    };

    const first = handleAuthCallback();
    const concurrent = handleAuthCallback();
    const failures = await Promise.allSettled([first, concurrent]);
    assert.equal(tokenCalls, 1);
    assert.ok(failures.every((result) => result.status === "rejected"));
    assert.equal(sessionStorage.getItem("teamspaces.session"), null);
    assert.equal(sessionStorage.getItem("teamspaces.pkce.verifier"), "pkce-verifier");
    assert.equal(sessionStorage.getItem("teamspaces.oauth.state"), "oauth-state");
    assert.equal(location.search.includes("code=callback-code"), true);
    assert.equal(location.hash, "", "a failed Cognito callback cannot re-enter public demo mode");

    await handleAuthCallback();
    assert.equal(tokenCalls, 2, "a later explicit attempt can recover from a transient failure");
    assert.ok(sessionStorage.getItem("teamspaces.session"));
  });
});

test("an OAuth state mismatch is rejected before the one-use code is posted", async () => {
  await withAuthBrowser(async ({handleAuthCallback}) => {
    let tokenCalls = 0;
    globalThis.fetch = async () => {
      tokenCalls += 1;
      return tokenResponse();
    };
    sessionStorage.setItem("teamspaces.oauth.state", "different-state");

    await handleAuthCallback();
    assert.equal(tokenCalls, 0);
    assert.equal(sessionStorage.getItem("teamspaces.session"), null);
    assert.equal(sessionStorage.getItem("teamspaces.pkce.verifier"), null);
    assert.equal(sessionStorage.getItem("teamspaces.oauth.state"), null);
    assert.equal(location.pathname + location.search + location.hash, "/app?view=mine");
  });
});

test("a callback without its PKCE verifier is discarded without a token request", async () => {
  await withAuthBrowser(async ({handleAuthCallback}) => {
    let tokenCalls = 0;
    globalThis.fetch = async () => {
      tokenCalls += 1;
      return tokenResponse();
    };
    sessionStorage.removeItem("teamspaces.pkce.verifier");

    await handleAuthCallback();
    assert.equal(tokenCalls, 0);
    assert.equal(sessionStorage.getItem("teamspaces.session"), null);
    assert.equal(sessionStorage.getItem("teamspaces.oauth.state"), null);
    assert.equal(location.pathname + location.search + location.hash, "/app?view=mine");
  });
});

test("sign-in binds the PKCE request to a high-entropy OAuth state", async () => {
  await withAuthBrowser(async ({beginSignIn}) => {
    sessionStorage.setItem("teamspaces.public-demo", "active");
    globalThis.location = {
      hostname: "127.0.0.1",
      origin: "http://127.0.0.1:3000",
      href: "http://127.0.0.1:3000/app"
    };

    await beginSignIn();
    const authorizeUrl = new URL(location.href);
    const storedState = sessionStorage.getItem("teamspaces.oauth.state");
    assert.equal(authorizeUrl.origin, "https://auth.example.test");
    assert.equal(authorizeUrl.pathname, "/oauth2/authorize");
    assert.equal(authorizeUrl.searchParams.get("state"), storedState);
    assert.ok(storedState.length >= 64);
    assert.ok(sessionStorage.getItem("teamspaces.pkce.verifier").length >= 64);
    assert.equal(sessionStorage.getItem("teamspaces.public-demo"), null, "real sign-in exits public demo first");
  }, "");
});

test("a malformed Cognito token response never creates an authenticated session", async () => {
  await withAuthBrowser(async ({handleAuthCallback}) => {
    globalThis.fetch = async () => new Response(JSON.stringify({expires_in: 900}), {
      status: 200,
      headers: {"content-type": "application/json"}
    });

    await assert.rejects(handleAuthCallback(), /Invalid Cognito token response/);
    assert.equal(sessionStorage.getItem("teamspaces.session"), null);
    assert.equal(sessionStorage.getItem("teamspaces.pkce.verifier"), "pkce-verifier");
  });
});

test("browser history cleanup cannot turn a saved session into an auth failure", async () => {
  await withAuthBrowser(async ({handleAuthCallback}, dom) => {
    let tokenCalls = 0;
    globalThis.fetch = async () => {
      tokenCalls += 1;
      return tokenResponse();
    };
    dom.window.history.replaceState = () => {
      throw new Error("History unavailable");
    };

    await handleAuthCallback();
    assert.ok(sessionStorage.getItem("teamspaces.session"));
    assert.equal(tokenCalls, 1);

    delete globalThis[callbackPromiseKey];
    const reloadedAuthModule = await import(`../src/lib/auth.js?auth-test=${++importSequence}`);
    await reloadedAuthModule.handleAuthCallback();
    assert.equal(tokenCalls, 1, "a saved session makes a leftover callback URL idempotent after reload");
  });
});
