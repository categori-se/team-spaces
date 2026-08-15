// @ts-nocheck

import {spawnSync} from "node:child_process";
import {readdir, readFile} from "node:fs/promises";
import path from "node:path";

const patterns = [
  /AKIA[0-9A-Z]{16}/,
  /aws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{30,}/i,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bsk_live_[A-Za-z0-9]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{36,}\b/,
  /authorization\s*[:=]\s*["']?bearer\s+[A-Za-z0-9._~+/=-]{24,}/i
];

const ignoredDirs = new Set([".git", "node_modules", "dist", "cdk.out", ".observablehq"]);
const textExtensions = new Set([".conf", ".css", ".html", ".ini", ".js", ".json", ".key", ".md", ".mjs", ".pem", ".sh", ".toml", ".txt", ".yaml", ".yml"]);

/** @param {string} value */
function containsSecret(value) {
  return patterns.some((pattern) => pattern.test(value));
}

async function walk(dir) {
  const entries = await readdir(dir, {withFileTypes: true});
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) files.push(...await walk(path.join(dir, entry.name)));
    } else if (
      (textExtensions.has(path.extname(entry.name)) || entry.name.startsWith(".env") || entry.name === ".npmrc")
      && entry.name !== "package-lock.json"
    ) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

const files = await walk(".");

const findings = [];
for (const file of files) {
  const text = await readFile(file, "utf8");
  if (containsSecret(text)) findings.push(file);
}

if (findings.length) {
  console.error(`Potential secrets found:\n${[...new Set(findings)].join("\n")}`);
  process.exit(1);
}

if (process.argv.includes("--history")) {
  const history = spawnSync("git", ["log", "--all", "-p", "--no-ext-diff", "--no-textconv"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024
  });
  if (history.status !== 0) {
    console.error("Unable to scan repository history");
    process.exit(history.status ?? 1);
  }
  if (containsSecret(history.stdout)) {
    console.error("Potential secret material was found in repository history; inspect it with an approved secret-scanning tool before publication.");
    process.exit(1);
  }
}
