// @ts-nocheck

import {spawn} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiPort = process.env.PORT ?? "8787";

async function teamSpacesApiIsRunning() {
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/v1/health`, {signal: AbortSignal.timeout(750)});
    const payload = await response.json();
    return response.ok && payload?.data?.service === "teamspaces-api";
  } catch {
    return false;
  }
}

const reuseApi = await teamSpacesApiIsRunning();
if (reuseApi) console.log(JSON.stringify({event: "dev.api.reuse", port: Number(apiPort)}));
const commands = [
  ...(!reuseApi ? [["npm", ["run", "dev:api"]]] : []),
  ["npm", ["run", "dev:web"]]
];

const children = commands.map(([command, args]) => {
  const child = spawn(command, args, {cwd: repoRoot, stdio: "inherit", shell: false});
  child.on("exit", (code) => {
    if (code) process.exitCode = code;
  });
  return child;
});

process.on("SIGINT", () => {
  for (const child of children) child.kill("SIGINT");
});
