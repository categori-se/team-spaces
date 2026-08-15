// @ts-nocheck

const tokenStorageKey = "teamspaces.session";
const verifierStorageKey = "teamspaces.pkce.verifier";
const stateStorageKey = "teamspaces.oauth.state";
const publicDemoStorageKey = "teamspaces.public-demo";
const publicDemoEntryHash = "#public-demo-entry";
const callbackPromiseKey = Symbol.for("teamspaces.auth.callback-promise");
let configPromise;

/**
 * @returns {Promise<any>}
 */
export async function runtimeConfig() {
  if (!configPromise) {
    const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
    const localConfig = isLocal ? globalThis.__TEAMSPACES_LOCAL_CONFIG__ : undefined;
    configPromise = (localConfig
      ? Promise.resolve(localConfig)
      : fetch("/runtime-config.json", {cache: "no-store"})
        .then((response) => response.ok ? response.json() : {})
        .catch(() => ({})))
      .then((config) => {
        return {
          apiBaseUrl: config.apiBaseUrl ?? (isLocal ? "http://localhost:8787/api/v1" : "/api/v1"),
          authMode: config.authMode ?? (isLocal ? "demo" : "cognito"),
          appOrigin: config.appOrigin ?? location.origin,
          cognito: config.cognito ?? {},
          publicDemo: {
            enabled: config.publicDemo?.enabled === true,
            apiBaseUrl: config.publicDemo?.apiBaseUrl ?? "/api/v1/demo",
            resetsAt: config.publicDemo?.resetsAt ?? ""
          }
        };
      });
  }
  return configPromise;
}

/**
 * @param {ArrayBuffer} buffer
 */
function base64Url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(value) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

function randomVerifier() {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function clearPublicDemoMode() {
  try {
    sessionStorage.removeItem(publicDemoStorageKey);
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }
}

export function isPublicDemoActive() {
  try {
    return sessionStorage.getItem(publicDemoStorageKey) === "active";
  } catch {
    return false;
  }
}

function consumePublicDemoEntry(config) {
  try {
    const entryUrl = new URL(location.href);
    const legacyQueryEntry = entryUrl.searchParams.get("demo") === "1";
    const hashEntry = entryUrl.hash === publicDemoEntryHash;
    if (!legacyQueryEntry && !hashEntry) return;
    if (config.publicDemo?.enabled) sessionStorage.setItem(publicDemoStorageKey, "active");
    else clearPublicDemoMode();
    if (legacyQueryEntry) entryUrl.searchParams.delete("demo");
    if (hashEntry) entryUrl.hash = "";
    history.replaceState(history.state, "", `${entryUrl.pathname}${entryUrl.search}${entryUrl.hash}`);
  } catch {
    // A blocked storage or history API should not break the landing-to-app transition.
  }
}

function clearPublicDemoEntryMarker() {
  try {
    const callbackUrl = new URL(location.href);
    const legacyQueryEntry = callbackUrl.searchParams.has("demo");
    const hashEntry = callbackUrl.hash === publicDemoEntryHash;
    if (!legacyQueryEntry && !hashEntry) return;
    if (legacyQueryEntry) callbackUrl.searchParams.delete("demo");
    if (hashEntry) callbackUrl.hash = "";
    history.replaceState(history.state, "", `${callbackUrl.pathname}${callbackUrl.search}${callbackUrl.hash}`);
  } catch {
    // The callback still clears stored demo state when browser history is unavailable.
  }
}

export async function enterPublicDemo() {
  const config = await runtimeConfig();
  if (!config.publicDemo?.enabled) throw new Error("The public demo is not available");
  sessionStorage.setItem(publicDemoStorageKey, "active");
  location.href = `/app${publicDemoEntryHash}`;
}

export function exitPublicDemo() {
  clearPublicDemoMode();
  location.href = "/";
}

export async function currentSession() {
  const config = await runtimeConfig();
  consumePublicDemoEntry(config);
  if (config.authMode === "demo") {
    return {authenticated: true, mode: "demo", accessToken: undefined};
  }
  if (config.publicDemo?.enabled && isPublicDemoActive()) {
    return {
      authenticated: true,
      mode: "public-demo",
      accessToken: undefined,
      publicDemo: config.publicDemo
    };
  }
  if (isPublicDemoActive()) clearPublicDemoMode();
  const raw = sessionStorage.getItem(tokenStorageKey);
  if (!raw) return {authenticated: false, mode: "cognito"};
  const session = JSON.parse(raw);
  if (session.expiresAt && Date.now() < session.expiresAt - 60_000) {
    return {authenticated: true, mode: "cognito", ...session};
  }
  if (session.refreshToken) {
    return refreshSession(session.refreshToken);
  }
  return {authenticated: false, mode: "cognito"};
}

export async function getAccessToken() {
  const session = await currentSession();
  return session.accessToken;
}

export async function beginSignIn() {
  clearPublicDemoMode();
  const config = await runtimeConfig();
  if (config.authMode === "demo") {
    location.href = "/app";
    return;
  }
  const verifier = randomVerifier();
  const state = randomVerifier();
  sessionStorage.setItem(verifierStorageKey, verifier);
  sessionStorage.setItem(stateStorageKey, state);
  const challenge = base64Url(await sha256(verifier));
  const params = new URLSearchParams({
    client_id: config.cognito.clientId,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: config.cognito.redirectUri ?? location.origin,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state
  });
  location.href = `${config.cognito.domain}/oauth2/authorize?${params}`;
}

export function handleAuthCallback() {
  const activeCallback = globalThis[callbackPromiseKey];
  if (activeCallback) return activeCallback;

  const callback = exchangeAuthCallback();
  const sharedCallback = callback.catch((error) => {
    if (globalThis[callbackPromiseKey] === sharedCallback) delete globalThis[callbackPromiseKey];
    throw error;
  });
  globalThis[callbackPromiseKey] = sharedCallback;
  return sharedCallback;
}

async function exchangeAuthCallback() {
  const config = await runtimeConfig();
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const isAuthCallback = Boolean(code || params.get("error"));
  if (isAuthCallback) {
    clearPublicDemoMode();
    clearPublicDemoEntryMarker();
  }
  if (params.get("error")) {
    clearAuthCallbackUrl();
    return;
  }
  if (!code || config.authMode === "demo") return;
  if (hasUsableStoredSession()) {
    clearAuthCallbackUrl();
    return;
  }
  const expectedState = sessionStorage.getItem(stateStorageKey);
  if (!expectedState || params.get("state") !== expectedState) {
    sessionStorage.removeItem(verifierStorageKey);
    sessionStorage.removeItem(stateStorageKey);
    clearAuthCallbackUrl();
    return;
  }
  const verifier = sessionStorage.getItem(verifierStorageKey);
  if (!verifier) {
    sessionStorage.removeItem(stateStorageKey);
    clearAuthCallbackUrl();
    return;
  }
  const tokenResponse = await fetch(`${config.cognito.domain}/oauth2/token`, {
    method: "POST",
    headers: {"content-type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.cognito.clientId,
      redirect_uri: config.cognito.redirectUri ?? location.origin,
      code,
      code_verifier: verifier
    })
  });
  if (!tokenResponse.ok) throw new Error("Unable to exchange Cognito authorization code");
  const token = await tokenResponse.json();
  saveToken(token);
  sessionStorage.removeItem(verifierStorageKey);
  sessionStorage.removeItem(stateStorageKey);
  clearAuthCallbackUrl();
}

function hasUsableStoredSession() {
  try {
    const session = JSON.parse(sessionStorage.getItem(tokenStorageKey) ?? "null");
    return Boolean(session?.accessToken && session?.idToken && session.expiresAt && Date.now() < session.expiresAt - 60_000);
  } catch {
    return false;
  }
}

function clearAuthCallbackUrl() {
  try {
    const callbackUrl = new URL(location.href);
    for (const parameter of ["code", "state", "error", "error_description", "demo"]) callbackUrl.searchParams.delete(parameter);
    if (callbackUrl.hash === publicDemoEntryHash) callbackUrl.hash = "";
    history.replaceState(history.state, "", `${callbackUrl.pathname}${callbackUrl.search}${callbackUrl.hash}`);
  } catch {
    // The authenticated session is authoritative even if browser history cleanup is unavailable.
  }
}

async function refreshSession(refreshToken) {
  const config = await runtimeConfig();
  const tokenResponse = await fetch(`${config.cognito.domain}/oauth2/token`, {
    method: "POST",
    headers: {"content-type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.cognito.clientId,
      refresh_token: refreshToken
    })
  });
  if (!tokenResponse.ok) {
    sessionStorage.removeItem(tokenStorageKey);
    return {authenticated: false, mode: "cognito"};
  }
  const token = await tokenResponse.json();
  token.refresh_token ??= refreshToken;
  saveToken(token);
  return currentSession();
}

function saveToken(token) {
  if (!token?.access_token || !token?.id_token) throw new Error("Invalid Cognito token response");
  sessionStorage.setItem(tokenStorageKey, JSON.stringify({
    accessToken: token.access_token,
    idToken: token.id_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + Number(token.expires_in ?? 3600) * 1000
  }));
}

export async function signOut() {
  const config = await runtimeConfig();
  if (isPublicDemoActive()) {
    exitPublicDemo();
    return;
  }
  sessionStorage.removeItem(tokenStorageKey);
  sessionStorage.removeItem(verifierStorageKey);
  sessionStorage.removeItem(stateStorageKey);
  if (config.authMode === "demo" || !config.cognito.domain) {
    location.href = "/";
    return;
  }
  const params = new URLSearchParams({
    client_id: config.cognito.clientId,
    logout_uri: config.cognito.logoutUri ?? location.origin
  });
  location.href = `${config.cognito.domain}/logout?${params}`;
}
