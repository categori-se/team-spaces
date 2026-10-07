# Team Spaces dependency repair

October 7, 2026. The dependency integration includes the six original update PRs
13, 18, 19, 21, 22 and 23. Their heads remain in the integration history.

The high-severity blocker was CDK's bundled `brace-expansion@5.0.9`. The newest
published CDK 2.272.0 still includes that version. Ordinary npm overrides do not
replace its published bundle. The application therefore pins a locally rebuilt
CDK 2.270.0 artifact that replaces only the bundled package with the official
`brace-expansion@5.0.12` distribution. This is a Team Spaces dependency repair,
not a new AWS release or a separately published npm package.

The patched version addresses the
[nested-recursion advisory](https://github.com/advisories/GHSA-qhr7-859c-m2p7)
and the [rewrite-cost advisory](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr).
The ordinary high-severity npm audit remains required. No exception, severity
reduction or fabricated package-version substitution is used.

## Installation and verification

A normal `npm ci` installs the committed integrity-locked artifact. No patch
install hook, extra AWS credentials or cloud action is required. The existing
`npm run audit:vulns` now first verifies the archive/lock integrity, the installed
package version, all thirteen patched upstream files and CDK's actual minimatch
resolver. It then runs the unchanged `npm audit --audit-level=high` command.

`vendor/aws-cdk-lib-2.270.0-teamspaces.1.receipt.json` pins both public npm input
URLs and SHA-512 integrity, the final artifact integrity and the complete-tree
digests. All 7,500 CDK files outside the replaced bundle are byte-identical to
upstream. Existing Apache-2.0/MIT licenses and notices remain; the rebuilt archive
adds an explicit modification notice. The ordinary license inventory is generated
from the installed tree and retains all existing license policy checks.

To reproduce the artifact from its integrity-pinned public inputs, run:

```bash
python3 scripts/rebuild-cdk-bundle.py
npm ci
npm run licenses:update
npm run audit:vulns
```

The regression test uses CDK's real minimatch dependency with both previously
stack-exhausting nested inputs and verifies unchanged ordinary glob expansion.
Local validation passes 205 application cases, 84 API integration cases and 37
infrastructure cases (suite counts overlap), the production build with eight
validated links, formatting, lint, type checking, 354-package license verification
and secret scanning. Rebuilding from the two pinned public inputs produces a
byte-identical archive. Normal GitHub CI remains required before merge. A source
merge does not deploy infrastructure.

## Removing the temporary distribution

When an official CDK release actually includes a patched bundled version, restore
ordinary registry dependencies in both root and infra manifests, regenerate the
lock and license artifacts, and pass the same checks. Then remove the temporary
archive, receipt and rebuild/verification tools. Preserve the behavioral
regression while updating its import to the installed upstream CDK dependency.

The October 7 audit has no high or critical findings after the bundle repair.
Five moderate and one low finding remain in Observable's build-tool dependency
chain. Its suggested forced downgrade is not part of this repair; it must not be
used to bypass the existing compatibility checks or misreported as a clean audit.
