import assert from "node:assert/strict";
import test from "node:test";

test("Observable config embeds an explicit local API and web port pair", async () => {
  const previousApiPort = process.env.PORT;
  const previousWebPort = process.env.WEB_PORT;
  process.env.PORT = "49731";
  process.env.WEB_PORT = "43719";

  try {
    const configUrl = new URL(`../observablehq.config.js?ports=${Date.now()}`, import.meta.url);
    const {default: config} = await import(configUrl.href);
    assert.match(config.head, /http:\/\/localhost:49731\/api\/v1/);
    assert.match(config.head, /http:\/\/localhost:43719\/app/);
  } finally {
    if (previousApiPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousApiPort;
    if (previousWebPort === undefined) delete process.env.WEB_PORT;
    else process.env.WEB_PORT = previousWebPort;
  }
});
