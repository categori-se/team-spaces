// @ts-nocheck

const applicationUrl = process.env.APP_URL ?? process.env.SMOKE_URL;
if (!applicationUrl) throw new Error("APP_URL or SMOKE_URL is required");
const expectedAuthDomain = process.env.AUTH_DOMAIN;
const expectedAuthMode = process.env.EXPECTED_AUTH_MODE ?? "cognito";
const baseUrl = new URL(applicationUrl);

async function fetchText(url, options = {}) {
  const response = await fetch(url, {redirect: "manual", ...options});
  const text = await response.text();
  return {response, text};
}

function fail(message, detail = {}) {
  console.error(JSON.stringify({ok: false, message, ...detail}, null, 2));
  process.exit(1);
}

function sameOrigin(value) {
  try {
    return new URL(value).origin === baseUrl.origin;
  } catch {
    return false;
  }
}

const root = await fetchText(baseUrl);
if (root.response.status >= 400) {
  fail("Application root did not return a successful page.", {
    url: baseUrl.href,
    status: root.response.status
  });
}

if (!root.text.includes("Team Spaces")) {
  const title = root.text.match(/<title>(.*?)<\/title>/i)?.[1] ?? "";
  fail("Application root is not serving Team Spaces.", {
    url: baseUrl.href,
    status: root.response.status,
    observedTitle: title
  });
}

const configUrl = new URL("/runtime-config.json", baseUrl);
const configResult = await fetchText(configUrl, {cache: "no-store"});
if (!configResult.response.ok) {
  fail("Application runtime-config.json is not reachable.", {
    url: configUrl.href,
    status: configResult.response.status,
    bodyStart: configResult.text.slice(0, 160)
  });
}

let config;
try {
  config = JSON.parse(configResult.text);
} catch {
  fail("Application runtime-config.json is not valid JSON.", {
    url: configUrl.href,
    bodyStart: configResult.text.slice(0, 160)
  });
}

const problems = [];
if (config.authMode !== expectedAuthMode) problems.push(`authMode is ${config.authMode}, expected ${expectedAuthMode}`);
if (config.apiBaseUrl !== "/api/v1") problems.push(`apiBaseUrl is ${config.apiBaseUrl}, expected /api/v1`);
if (config.appOrigin !== baseUrl.origin) problems.push(`appOrigin is ${config.appOrigin}, expected ${baseUrl.origin}`);
if (expectedAuthDomain && config.cognito?.domain !== expectedAuthDomain) {
  problems.push(`cognito.domain is ${config.cognito?.domain}, expected ${expectedAuthDomain}`);
}
let configuredAuthDomain;
try {
  configuredAuthDomain = new URL(config.cognito?.domain);
  if (configuredAuthDomain.protocol !== "https:") problems.push("cognito.domain must use HTTPS");
} catch {
  problems.push(`cognito.domain is not a valid URL: ${config.cognito?.domain}`);
}
if (!config.cognito?.clientId) problems.push("cognito.clientId is missing");
if (!sameOrigin(config.cognito?.redirectUri)) {
  problems.push(`cognito.redirectUri is ${config.cognito?.redirectUri}, expected ${baseUrl.origin}`);
}
if (!sameOrigin(config.cognito?.logoutUri)) {
  problems.push(`cognito.logoutUri is ${config.cognito?.logoutUri}, expected ${baseUrl.origin}`);
}
if (config.publicDemo?.enabled !== true) problems.push("publicDemo.enabled is not true");
if (config.publicDemo?.apiBaseUrl !== "/api/v1/demo") {
  problems.push(`publicDemo.apiBaseUrl is ${config.publicDemo?.apiBaseUrl}, expected /api/v1/demo`);
}
if (!config.publicDemo?.resetsAt) problems.push("publicDemo.resetsAt is missing");

if (problems.length) {
  fail("Application auth runtime configuration is not ready.", {
    url: configUrl.href,
    problems
  });
}

const authorizeUrl = new URL("/oauth2/authorize", configuredAuthDomain);
authorizeUrl.search = new URLSearchParams({
  client_id: config.cognito.clientId,
  response_type: "code",
  scope: "openid email profile",
  redirect_uri: config.cognito.redirectUri,
  code_challenge_method: "S256",
  code_challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
}).toString();

const authProbe = await fetch(authorizeUrl, {redirect: "manual"});
if (![200, 302, 303].includes(authProbe.status)) {
  fail("Cognito hosted auth endpoint did not accept the configured client.", {
    url: configuredAuthDomain.origin,
    status: authProbe.status,
    location: authProbe.headers.get("location")
  });
}

const publicDemoUrl = new URL(`${config.publicDemo.apiBaseUrl.replace(/\/$/, "")}/bootstrap`, baseUrl);
const publicDemoProbe = await fetchText(publicDemoUrl, {cache: "no-store"});
if (!publicDemoProbe.response.ok) {
  fail("Public demo bootstrap is not reachable without a Cognito session.", {
    url: publicDemoUrl.href,
    status: publicDemoProbe.response.status,
    bodyStart: publicDemoProbe.text.slice(0, 240)
  });
}

let publicDemoPayload;
try {
  publicDemoPayload = JSON.parse(publicDemoProbe.text);
} catch {
  fail("Public demo bootstrap is not valid JSON.", {
    url: publicDemoUrl.href,
    bodyStart: publicDemoProbe.text.slice(0, 240)
  });
}

const publicDemo = publicDemoPayload?.data?.publicDemo;
if (publicDemo?.shared !== true || publicDemo?.editable !== true || !publicDemo?.seedVersion || !publicDemo?.nextResetAt) {
  fail("Public demo bootstrap is missing its verified seed or reset metadata.", {
    url: publicDemoUrl.href,
    publicDemo
  });
}

// Exercise the same concurrent reads used by the Documents page. This catches
// a demo Lambda concurrency cap that is lower than a normal page fan-out.
const publicDemoPagePaths = ["/documents", "/projects", "/planning"];
const publicDemoPageProbes = await Promise.all(publicDemoPagePaths.map((path) => (
  fetchText(new URL(`${config.publicDemo.apiBaseUrl.replace(/\/$/, "")}${path}`, baseUrl), {cache: "no-store"})
)));
const failedPublicDemoPageProbes = publicDemoPageProbes
  .map(({response, text}, index) => ({
    path: publicDemoPagePaths[index],
    status: response.status,
    ok: response.ok,
    bodyStart: text.slice(0, 160)
  }))
  .filter(({ok}) => !ok);
if (failedPublicDemoPageProbes.length) {
  fail("Public demo page requests do not have enough concurrent capacity.", {
    failures: failedPublicDemoPageProbes
  });
}

console.log(JSON.stringify({
  ok: true,
  applicationUrl: baseUrl.origin,
  authDomain: configuredAuthDomain.origin,
  clientId: config.cognito.clientId,
  authProbeStatus: authProbe.status,
  publicDemoStatus: publicDemoProbe.response.status,
  publicDemoPageStatuses: publicDemoPageProbes.map(({response}) => response.status),
  publicDemoSeedVersion: publicDemo.seedVersion,
  publicDemoNextResetAt: publicDemo.nextResetAt
}, null, 2));
