#!/usr/bin/env python3
"""Rebuild the pinned public CDK distribution with one patched bundled package.

No install hook or audit exemption is needed: ordinary npm ci consumes the
committed, integrity-locked archive. Upstream CDK files and licenses are retained.
"""
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
INPUTS = {
    "cdk": {"url": "https://registry.npmjs.org/aws-cdk-lib/-/aws-cdk-lib-2.270.0.tgz",
            "integrity": "sha512-xoO9FEqcVTTK39N6n+LxvAAsS5WZSGX/p+uv3l2W+LXDEIWctq6VECdluuFwdXnbyf4v4eIxo2btrkUepnEy0Q=="},
    "brace": {"url": "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.12.tgz",
              "integrity": "sha512-YovQ3rzhaLMIrDjNDMkNS01tea93qhEhG5xy8f6+R0l+dw3Ki+5sCoIoI942iuLZTHWogWktgwVDhU09iNEimQ=="},
}
TARGET = "package/node_modules/brace-expansion/"
NOTICE = b"""Team Spaces dependency repair, 2026-10-07

This is a locally rebuilt aws-cdk-lib 2.270.0 distribution, not an AWS release.
Only the bundled brace-expansion distribution is replaced: 5.0.9 -> 5.0.12.
All other upstream package files and their license/NOTICE files are unchanged.
The replacement is the integrity-verified official npm brace-expansion archive.
See vendor/aws-cdk-lib-2.270.0-teamspaces.1.receipt.json and
scripts/rebuild-cdk-bundle.py in categori-se/team-spaces for provenance.
"""


def sri(data):
    return "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()


def fetch(source):
    with urllib.request.urlopen(source["url"], timeout=60) as response:
        data = response.read(40 * 1024 * 1024 + 1)
    if len(data) > 40 * 1024 * 1024 or sri(data) != source["integrity"]:
        raise ValueError("Upstream package integrity differs from the pinned input")
    return data


def files(data):
    result = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or not str(name).startswith("package/"):
                raise ValueError("Unexpected upstream archive path")
            if member.isdir():
                continue
            if not member.isfile() or member.name in result:
                raise ValueError("Unexpected upstream link or duplicate")
            result[member.name] = (member.mode, archive.extractfile(member).read())
    return result


def tree_digest(entries):
    inventory = [[name, mode, hashlib.sha256(data).hexdigest()] for name, (mode, data) in sorted(entries.items())]
    return hashlib.sha256(json.dumps(inventory, separators=(",", ":")).encode()).hexdigest()


def build():
    upstream, replacement = files(fetch(INPUTS["cdk"])), files(fetch(INPUTS["brace"]))
    if json.loads(upstream["package/package.json"][1])["version"] != "2.270.0":
        raise ValueError("Unexpected CDK version")
    if json.loads(upstream[TARGET + "package.json"][1])["version"] != "5.0.9":
        raise ValueError("Upstream bundle changed; review before rebuilding")
    if json.loads(replacement["package/package.json"][1])["version"] != "5.0.12":
        raise ValueError("Unexpected replacement version")
    untouched = {name: value for name, value in upstream.items() if not name.startswith(TARGET)}
    updated = dict(untouched)
    for name, value in replacement.items():
        updated[TARGET + name.removeprefix("package/")] = value
    updated["package/TEAMSPACES_PATCH_NOTICE.md"] = (0o644, NOTICE)
    assert all(updated[name] == value for name, value in untouched.items())
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0, compresslevel=9) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for name, (mode, data) in sorted(updated.items()):
                item = tarfile.TarInfo(name)
                item.mode, item.size, item.mtime = mode, len(data), 0
                archive.addfile(item, io.BytesIO(data))
    data = output.getvalue()
    # Verify the artifact itself, rather than relying on its package metadata.
    assert files(data) == updated
    destination = ROOT / "vendor/aws-cdk-lib-2.270.0-teamspaces.1.tgz"
    receipt = {"schema": "teamspaces-vendored-cdk-v1", "inputs": INPUTS,
               "upstream_cdk_version": "2.270.0", "upstream_bundled_brace_version": "5.0.9",
               "patched_bundled_brace_version": "5.0.12", "unchanged_cdk_files": len(untouched),
               "unchanged_cdk_tree_sha256": tree_digest(untouched),
               "replacement_tree_sha256": tree_digest(replacement),
               "replacement_files": {name.removeprefix("package/"): hashlib.sha256(value[1]).hexdigest()
                                     for name, value in sorted(replacement.items())},
               "artifact": destination.name,
               "artifact_bytes": len(data), "artifact_sha256": hashlib.sha256(data).hexdigest(),
               "artifact_integrity": sri(data), "artifact_tree_sha256": tree_digest(updated),
               "licenses_retained": ["package/LICENSE", "package/NOTICE", TARGET + "LICENSE"],
               "additional_notice": "package/TEAMSPACES_PATCH_NOTICE.md", "audit_exemptions": []}
    for name in receipt["licenses_retained"]:
        assert name in updated
    destination.parent.mkdir(exist_ok=True)
    destination.write_bytes(data)
    destination.with_suffix(".receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"status": "rebuilt-and-verified", "bytes": len(data), "unchanged_cdk_files": len(untouched), "brace": "5.0.12"}))


if __name__ == "__main__":
    build()
