# Validation Loop

Run from the repository root:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:infra
npm run build
npm run audit:licenses
npm run audit:vulns
npm run scan:secrets
```

For local UI changes with the dev server running at `http://127.0.0.1:3004` and the API at `http://localhost:8787`, run a browser route scan:

```bash
node --input-type=module <<'EOF'
import {spawnSync} from "node:child_process";
const routes = ["/app", "/app/portfolio", "/app/projects", "/app/planning", "/app/documents", "/app/project?id=project-pilot", "/app/work", "/app/time", "/app/reports", "/app/admin"];
const badPattern = /SyntaxError|ReferenceError|RuntimeError|Failed to fetch|Not Found|state--error|Unexpected token|refreshVersion|observablehq--error/;
const contentPattern = /data-table|state--empty|metric-grid|filter-form|planning-controls|planning-workbench|planning-dashboard|context-links|work-card/;
let failed = false;
function check(route) {
  const result = spawnSync("chromium-browser", ["--headless=new", "--disable-gpu", "--virtual-time-budget=15000", "--dump-dom", `http://127.0.0.1:3004${route}`], {encoding: "utf8", maxBuffer: 20 * 1024 * 1024});
  const combined = `${result.stdout}\n${result.stderr}`;
  const match = combined.match(badPattern);
  const hasContent = contentPattern.test(result.stdout);
  return {ok: result.status === 0 && !match && hasContent, match, hasContent};
}
for (const route of routes) {
  let result = check(route);
  if (!result.ok) result = check(route);
  console.log(`${result.ok ? "ok" : "fail"} ${route}${result.match ? ` :: ${result.match[0]}` : result.hasContent ? "" : " :: no content marker"}`);
  if (!result.ok) failed = true;
}
process.exit(failed ? 1 : 0);
EOF
```

For generic community AWS changes, use placeholder values that cannot be mistaken for a live installation:

```bash
TEAMSPACES_DOMAIN_NAME=team-spaces.example.com \
ACM_CERTIFICATE_ARN=arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000 \
npm run infra:synth:aws
```

Also synthesize the hosted-pilot profile when changing shared infrastructure:

```bash
TEAMSPACES_DOMAIN_NAME=<hosted-domain> \
ACM_CERTIFICATE_ARN=<us-east-1-certificate-arn> \
TEAMSPACES_WEB_BUCKET_NAME=<hosted-web-bucket> \
EXISTING_USER_POOL_ID=<hosted-user-pool-id> \
AUTH_DOMAIN_NAME=<hosted-auth-domain> \
COGNITO_MANAGED_LOGIN_DOMAIN_PREFIX=<hosted-prefix> \
npm run infra:synth:hosted
```

For deployed production:

```bash
SMOKE_URL=<app-origin> npm run smoke
APP_URL=<app-origin> npm run check:hosted-auth
```

If DNS is not connected yet, use the CloudFront URL emitted by CDK.
