import assert from "node:assert/strict";
import {createRequire} from "node:module";
import test from "node:test";

const cdkRequire = createRequire(new URL("../../node_modules/aws-cdk-lib/package.json", import.meta.url));
const minimatch = cdkRequire("minimatch");

test("CDK's actual glob dependency preserves ordinary expansion and bounds both nested recursion paths", {timeout: 10000}, () => {
  assert.deepEqual(minimatch.braceExpand("assets/{a,b}.{js,ts}"), ["assets/a.js", "assets/a.ts", "assets/b.js", "assets/b.ts"]);
  // The two formerly stack-exhausting inputs from GHSA-qhr7-859c-m2p7.
  const single = "{".repeat(4000) + "a,b" + "}".repeat(4000);
  const members = "{a,".repeat(4000) + "z" + "}".repeat(4000);
  const first = minimatch.braceExpand(single), second = minimatch.braceExpand(members);
  assert.deepEqual(first, [single], "Beyond the depth bound, preserve the literal pattern");
  assert.equal(second.length, 1002, "Depth 0 through 1000 expand; deeper groups stay literal");
  assert.ok(second.slice(0, -1).every((value) => value === "a"));
  assert.equal(second.at(-1), "{a,".repeat(2999) + "z" + "}".repeat(2999), "Preserve the unexpanded remainder at the depth bound");
});
