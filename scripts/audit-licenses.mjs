// @ts-nocheck

import {createHash} from "node:crypto";
import {readdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const modules = path.join(root, "node_modules");
const projectLicensePath = path.join(root, "LICENSE");
const projectNoticePath = path.join(root, "NOTICE");
const reportPath = path.join(root, "docs/dependency-licenses.generated.json");
const webLicensePath = path.join(root, "apps/web/src/LICENSE.txt");
const webNoticePath = path.join(root, "apps/web/src/THIRD_PARTY_NOTICES.txt");
const writeGeneratedFiles = process.argv.includes("--write");
const copyleft = /\b(GPL|AGPL|LGPL)\b/i;
const permissive = /\b(MIT|Apache|BSD|ISC)\b/i;
const licenseFileName = /^(?:licen[cs]e|copying|copyright|notice|unlicense)(?:[._-].*)?$/i;

/** @param {string} value */
function normalizeText(value) {
  const normalizedLines = value
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trimEnd());
  return `${normalizedLines.join("\n").trim()}\n`;
}

// These npm archives omit license files that exist in their upstream source
// distributions. Keep fallbacks pinned to exact package versions so upgrades
// fail closed until their license provenance is reviewed again.
const pinnedLicenseDocuments = new Map([
  ["eastasianwidth@0.2.0", {
    name: "MIT-LICENSE.txt (pinned upstream fallback)",
    // https://github.com/komagata/eastasianwidth/blob/master/MIT-LICENSE.txt
    text: normalizeText(`Copyright komagata

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`)
  }],
  ["saxes@6.0.0", {
    name: "LICENSE (pinned upstream fallback)",
    // https://github.com/lddubeau/saxes/blob/v6.0.0/LICENSE
    text: normalizeText(`The ISC License

Copyright (c) Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.
THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

====
The following license is the one that governed sax, from which saxes
was forked. Isaac Schlueter is not *directly* involved with saxes so
don't go bugging him for saxes issues.

The ISC License

Copyright (c) Isaac Z. Schlueter and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.
THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

====
\`String.fromCodePoint\` by Mathias Bynens is no longer used, but it can
still be found in old commits. It was once used according to terms of
MIT License, as follows:

    Copyright Mathias Bynens <https://mathiasbynens.be/>
    Permission is hereby granted, free of charge, to any person obtaining
    a copy of this software and associated documentation files (the
    "Software"), to deal in the Software without restriction, including
    without limitation the rights to use, copy, modify, merge, publish,
    distribute, sublicense, and/or sell copies of the Software, and to
    permit persons to whom the Software is furnished to do so, subject to
    the following conditions:
    The above copyright notice and this permission notice shall be
    included in all copies or substantial portions of the Software.
    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
    EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
    MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
    NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
    LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
    OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
    WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`)
  }]
]);

/** @param {unknown} value */
function authorText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return [value.name, value.url].filter(Boolean).join(" — ");
}

/** @param {Record<string, any>} data */
function repositoryUrl(data) {
  return typeof data.repository === "string" ? data.repository : data.repository?.url;
}

/** @param {Record<string, any>} data */
function repositoryIdentity(data) {
  return (repositoryUrl(data) ?? "")
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

/** @param {Record<string, any>} data */
function sourceUrl(data) {
  return repositoryUrl(data) ?? data.homepage ?? `https://www.npmjs.com/package/${encodeURIComponent(data.name)}/v/${encodeURIComponent(data.version)}`;
}

/** @param {string} packageDir */
async function packageLicenseDocuments(packageDir) {
  const entries = await readdir(packageDir, {withFileTypes: true});
  const documents = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if ((!entry.isFile() && !entry.isSymbolicLink()) || !licenseFileName.test(entry.name)) continue;
    const text = normalizeText(await readFile(path.join(packageDir, entry.name), "utf8"));
    if (text.trim()) documents.push({name: entry.name, text});
  }
  return documents;
}

/** @param {string} packageDir */
async function packageReadmeLicenseDocument(packageDir) {
  const entries = await readdir(packageDir, {withFileTypes: true});
  const readmes = entries
    .filter((entry) => entry.isFile() && /^readme(?:[._-].*)?$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const readme of readmes) {
    const text = (await readFile(path.join(packageDir, readme.name), "utf8")).replaceAll("\r\n", "\n");
    const lines = text.split("\n");
    const start = lines.findIndex((line) => /^(#{1,6})[ \t]+licen[cs]e[ \t]*#*[ \t]*$/i.test(line));
    if (start < 0) continue;
    const level = lines[start].match(/^#+/)[0].length;
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      const nextHeading = lines[index].match(/^(#{1,6})[ \t]+/);
      if (nextHeading && nextHeading[1].length <= level) {
        end = index;
        break;
      }
    }
    const section = normalizeText(lines.slice(start, end).join("\n"));
    if (section.split("\n").slice(1).some((line) => line.trim())) {
      return {name: `${readme.name}#License`, text: section};
    }
  }
  return undefined;
}

/** @param {Record<string, any>} target @param {Record<string, any>} candidate */
function isSameLicenseDistribution(target, candidate) {
  if (!target.repository || target.repository !== candidate.repository || target.license !== candidate.license) return false;
  if (target.name.startsWith("@aws-sdk/")) return candidate.name.startsWith("@aws-sdk/");
  if (target.name.startsWith("@esbuild/")) return candidate.name === "esbuild" && candidate.version === target.version;
  if (target.name.startsWith("@rollup/rollup-")) return candidate.name === "rollup" && candidate.version === target.version;
  if (target.name.startsWith("@rollup/plugin-")) return candidate.name.startsWith("@rollup/plugin-");
  return false;
}

/** @param {Array<Record<string, any>>} packages */
async function resolveMissingLicenseDocuments(packages) {
  for (const item of packages) {
    if (item.documents.length) continue;
    const sibling = packages.find((candidate) => candidate.documents.length && isSameLicenseDistribution(item, candidate));
    if (sibling) {
      item.documents = sibling.documents.map((document) => ({
        name: `${document.name} (inherited from ${sibling.name}@${sibling.version})`,
        text: document.text
      }));
      continue;
    }
    const readmeDocument = await packageReadmeLicenseDocument(item.packageDir);
    if (readmeDocument) {
      item.documents = [readmeDocument];
      continue;
    }
    const pinnedDocument = pinnedLicenseDocuments.get(`${item.name}@${item.version}`);
    if (pinnedDocument) item.documents = [pinnedDocument];
  }
}

/**
 * npm can install packages both at the root and inside another package's
 * node_modules directory. Audit every installed copy so a nested dependency
 * cannot bypass the license gate.
 *
 * @param {string} nodeModulesDir
 */
async function collectPackageDirs(nodeModulesDir) {
  const entries = await readdir(nodeModulesDir, {withFileTypes: true}).catch(() => []);
  const packageDirs = [];
  const candidates = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const entryPath = path.join(nodeModulesDir, entry.name);
    if (entry.name.startsWith("@")) {
      const scopedEntries = await readdir(entryPath, {withFileTypes: true});
      for (const scopedEntry of scopedEntries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (scopedEntry.isDirectory()) candidates.push(path.join(entryPath, scopedEntry.name));
      }
    } else {
      candidates.push(entryPath);
    }
  }
  for (const packageDir of candidates) {
    const packageJson = path.join(packageDir, "package.json");
    const data = JSON.parse(await readFile(packageJson, "utf8").catch(() => "{}"));
    if (!data.name) continue;
    packageDirs.push({packageDir, data});
    packageDirs.push(...await collectPackageDirs(path.join(packageDir, "node_modules")));
  }
  return packageDirs;
}

/** @param {string} projectNotice @param {Array<Record<string, any>>} packages */
function renderWebNotices(projectNotice, packages) {
  const lines = [
    "TEAM SPACES THIRD-PARTY SOFTWARE NOTICES",
    "=========================================",
    "",
    "This generated file inventories the third-party packages installed from",
    "the repository lockfile and reproduces every license or notice document",
    "included at the root of those installed packages. When an npm archive",
    "omits its license file, the text is resolved from an installed sibling",
    "distribution, an explicit README section, or a version-pinned fallback.",
    "",
    "Do not edit this file directly. Run `npm run licenses:update`, review the",
    "result, and commit it with the dependency change.",
    "",
    "PACKAGE INVENTORY",
    "-----------------",
    ""
  ];
  for (const item of packages) {
    lines.push(`${item.name}@${item.version}`);
    lines.push(`  Declared license: ${item.license}`);
    lines.push(`  Source: ${item.source}`);
    if (item.author) lines.push(`  Author metadata: ${item.author}`);
    lines.push(`  Resolved license documents: ${item.documents.map((document) => document.name).join(", ")}`);
    lines.push("");
  }

  /** @type {Map<string, {text: string, uses: string[]}>} */
  const documents = new Map();
  for (const item of packages) {
    for (const document of item.documents) {
      const digest = createHash("sha256").update(document.text).digest("hex");
      const grouped = documents.get(digest) ?? {text: document.text, uses: []};
      grouped.uses.push(`${item.name}@${item.version} (${document.name})`);
      documents.set(digest, grouped);
    }
  }

  lines.push("LICENSE AND NOTICE DOCUMENTS");
  lines.push("----------------------------");
  lines.push("");
  for (const [digest, document] of [...documents].sort((left, right) => left[1].uses[0].localeCompare(right[1].uses[0]))) {
    lines.push("================================================================================");
    lines.push(`Document SHA-256: ${digest}`);
    lines.push("Applies to:");
    for (const use of document.uses.sort()) lines.push(`  - ${use}`);
    lines.push("--------------------------------------------------------------------------------");
    lines.push(document.text.trimEnd());
    lines.push("");
  }
  const dependencyNotices = `${lines.join("\n").trimEnd()}\n`;
  const separator = projectNotice.endsWith("\n") ? "\n" : "\n\n";
  return `${projectNotice}${separator}${dependencyNotices}`;
}

/** @param {string} outputPath @param {string} expected */
async function checkGeneratedFile(outputPath, expected) {
  const current = await readFile(outputPath, "utf8").catch(() => undefined);
  if (current === expected) return;
  console.error(`${path.relative(root, outputPath)} is missing or stale; run npm run licenses:update`);
  process.exitCode = 1;
}

const installed = await collectPackageDirs(modules);
if (!installed.length) throw new Error("No installed dependencies found; run npm ci before auditing licenses");

const packagesByVersion = new Map();
for (const {packageDir, data} of installed) {
  const license = Array.isArray(data.licenses)
    ? data.licenses.map((item) => item.type ?? item).join(", ")
    : data.license ?? "UNKNOWN";
  const key = `${data.name}\u0000${data.version}\u0000${license}`;
  if (packagesByVersion.has(key)) continue;
  packagesByVersion.set(key, {
    name: data.name,
    version: data.version,
    license,
    source: sourceUrl(data),
    repository: repositoryIdentity(data),
    author: authorText(data.author),
    packageDir,
    documents: await packageLicenseDocuments(packageDir)
  });
}

const packages = [...packagesByVersion.values()]
  .sort((left, right) => left.name.localeCompare(right.name) || String(left.version).localeCompare(String(right.version)));
await resolveMissingLicenseDocuments(packages);
const report = packages.map(({name, version, license}) => ({name, version, license}));
const forbiddenPackages = report.filter((item) => {
  const license = String(item.license);
  if (!copyleft.test(license)) return false;
  if (license.includes(" OR ") && permissive.test(license)) return false;
  return true;
});
const unknownPackages = report.filter((item) => !String(item.license).trim() || item.license === "UNKNOWN");
const unresolvedPackages = packages
  .filter((item) => !item.documents.length)
  .map(({name, version, license}) => ({name, version, license}));

if (forbiddenPackages.length) {
  console.error("Forbidden copyleft dependencies found:");
  console.error(JSON.stringify(forbiddenPackages, null, 2));
  process.exit(1);
}
if (unknownPackages.length) {
  console.error("Dependencies without declared licenses found:");
  console.error(JSON.stringify(unknownPackages, null, 2));
  process.exit(1);
}
if (unresolvedPackages.length) {
  console.error("Dependencies without resolvable license text found:");
  console.error(JSON.stringify(unresolvedPackages, null, 2));
  process.exit(1);
}

const reportBody = `${JSON.stringify(report, null, 2)}\n`;
const projectLicense = await readFile(projectLicensePath, "utf8");
const projectNotice = await readFile(projectNoticePath, "utf8");
const webNoticeBody = renderWebNotices(projectNotice, packages);
if (writeGeneratedFiles) {
  await writeFile(reportPath, reportBody);
  await writeFile(webLicensePath, projectLicense);
  await writeFile(webNoticePath, webNoticeBody);
  console.log(JSON.stringify({
    event: "license_artifacts.updated",
    packages: report.length,
    files: [path.relative(root, reportPath), path.relative(root, webLicensePath), path.relative(root, webNoticePath)]
  }));
} else {
  await checkGeneratedFile(reportPath, reportBody);
  await checkGeneratedFile(webLicensePath, projectLicense);
  await checkGeneratedFile(webNoticePath, webNoticeBody);
  if (!process.exitCode) console.log(JSON.stringify({event: "license_artifacts.verified", packages: report.length}));
}
