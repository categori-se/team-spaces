// @ts-nocheck

import {readdir, readFile} from "node:fs/promises";
import path from "node:path";

const ignoredDirs = new Set([".git", "node_modules", "dist", "cdk.out", ".observablehq"]);

async function walk(dir) {
  const entries = await readdir(dir, {withFileTypes: true});
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) files.push(...await walk(path.join(dir, entry.name)));
    } else if ([".js", ".mjs"].includes(path.extname(entry.name))) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

const files = await walk(".");

const failures = [];
for (const file of files) {
  const text = await readFile(file, "utf8");
  if (!file.startsWith("docs/") && text.includes("Open" + "Project")) failures.push(`${file}: restricted product reference must stay in docs only`);
  if (/console\.log\((?!JSON\.stringify|`Team Spaces local API)/.test(text)) failures.push(`${file}: use structured logs`);
  if (/fetch\([^)]*,\s*\{[^}]*method:\s*["'`](POST|PUT|PATCH|DELETE)/s.test(text) && !file.endsWith("api.js") && !file.endsWith("auth.js")) {
    failures.push(`${file}: frontend mutations must go through lib/api.js`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
