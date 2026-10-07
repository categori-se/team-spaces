// @ts-nocheck
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const receipt = JSON.parse(await readFile(path.join(root, "vendor/aws-cdk-lib-2.270.0-teamspaces.1.receipt.json"), "utf8"));
const artifact = await readFile(path.join(root, "vendor", receipt.artifact));
const integrity = "sha512-" + createHash("sha512").update(artifact).digest("base64");
assert.equal(integrity, receipt.artifact_integrity, "Patched CDK archive differs from its reviewed receipt");
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const cdk = lock.packages["node_modules/aws-cdk-lib"];
assert.equal(cdk.integrity, integrity, "npm lock must pin the actual patched artifact");
const directory = path.join(root, "node_modules/aws-cdk-lib");
const original = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
assert.equal(original.version, receipt.upstream_cdk_version);
const brace = path.join(directory, "node_modules/brace-expansion");
const installed = JSON.parse(await readFile(path.join(brace, "package.json"), "utf8"));
assert.equal(installed.version, receipt.patched_bundled_brace_version, "Installed bundle remains vulnerable");
assert.equal(lock.packages["node_modules/aws-cdk-lib/node_modules/brace-expansion"].version, installed.version);
for (const [name, digest] of Object.entries(receipt.replacement_files)) {
  const bytes = await readFile(path.join(brace, name));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), digest, `Patched upstream file differs: ${name}`);
}
const minimatch = createRequire(path.join(directory, "package.json")).resolve("minimatch");
const actualBrace = createRequire(minimatch).resolve("brace-expansion");
assert.ok(actualBrace.startsWith(brace + path.sep), "CDK's real minimatch resolver does not use the verified patched bundle");
console.log(JSON.stringify({status: "verified", cdk: original.version, brace: installed.version, patchedFiles: Object.keys(receipt.replacement_files).length}));
