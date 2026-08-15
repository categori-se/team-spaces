const baseUrl = process.env.SMOKE_URL;

if (!baseUrl) {
  console.error("Set SMOKE_URL before running production smoke tests.");
  process.exit(1);
}

const root = await fetch(baseUrl, {redirect: "manual"});
if (root.status >= 400) {
  console.error(`Root smoke failed: ${root.status}`);
  process.exit(1);
}

const health = await fetch(new URL("/api/v1/health", baseUrl));
if (!health.ok) {
  console.error(`Health smoke failed: ${health.status}`);
  process.exit(1);
}

console.log(JSON.stringify({ok: true, root: root.status, health: health.status}));
