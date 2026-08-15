// @ts-nocheck

import {readdir, readFile} from "node:fs/promises";
import path from "node:path";

const textExtensions = new Set([".js", ".mjs", ".json", ".md", ".yaml", ".yml", ".css"]);
const ignoredDirs = new Set([".git", "node_modules", "dist", "cdk.out", ".observablehq"]);

async function walk(dir) {
  const entries = await readdir(dir, {withFileTypes: true});
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) files.push(...await walk(path.join(dir, entry.name)));
    } else if (textExtensions.has(path.extname(entry.name)) && entry.name !== "package-lock.json") {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

const files = await walk(".");

const failures = [];
for (const file of files) {
  const text = await readFile(file, "utf8");
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (/\s+$/.test(line)) failures.push(`${file}:${index + 1} trailing whitespace`);
  });
  if (!text.endsWith("\n")) failures.push(`${file}: missing final newline`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
