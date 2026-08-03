#!/usr/bin/env python3
"""RONOR — CycloneDX 1.5 SBOM generator.

Builds SBOM.json from package.json (declared ranges) and package-lock.json
(resolved versions, integrity hashes and licences where available).

Usage: python3 scripts/generate-sbom.py [version] [commit_sha]
Prepared by AMB.
"""
import hashlib
import json
import re
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION = sys.argv[1] if len(sys.argv) > 1 else "0.4.0-core-active"
COMMIT = sys.argv[2] if len(sys.argv) > 2 else subprocess.check_output(
    ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()

pkg = json.loads((ROOT / "package.json").read_text())
lock = json.loads((ROOT / "package-lock.json").read_text())
lock_pkgs = lock.get("packages", {})

DIRECT_PROD = pkg.get("dependencies", {})
DIRECT_DEV = pkg.get("devDependencies", {})


def purl(name: str, version: str) -> str:
    if name.startswith("@"):
        scope, bare = name.split("/", 1)
        return f"pkg:npm/{scope}%2F{bare}@{version}"
    return f"pkg:npm/{name}@{version}"


def lookup(name: str):
    """Return (version, integrity, license, resolved) from the lockfile."""
    entry = lock_pkgs.get(f"node_modules/{name}")
    if entry is None:
        for key, val in lock_pkgs.items():
            if key.endswith(f"node_modules/{name}"):
                entry = val
                break
    if entry is None:
        return None, None, None, None
    return (entry.get("version"), entry.get("integrity"),
            entry.get("license"), entry.get("resolved"))


def hashes_from_integrity(integrity):
    if not integrity or "-" not in integrity:
        return []
    alg, b64 = integrity.split("-", 1)
    alg_map = {"sha512": "SHA-512", "sha256": "SHA-256", "sha1": "SHA-1"}
    if alg not in alg_map:
        return []
    import base64
    try:
        digest = base64.b64decode(b64).hex()
    except Exception:
        return []
    return [{"alg": alg_map[alg], "content": digest}]


def make_component(name, declared_range, scope):
    version, integrity, lic, resolved = lookup(name)
    comp = {
        "type": "library",
        "bom-ref": purl(name, version or declared_range.lstrip("^~")),
        "name": name,
        "version": version or declared_range.lstrip("^~"),
        "purl": purl(name, version or declared_range.lstrip("^~")),
        "scope": "required" if scope == "prod" else "optional",
        "properties": [
            {"name": "ronor:declaredRange", "value": declared_range},
            {"name": "ronor:dependencyScope",
             "value": "production" if scope == "prod" else "development"},
        ],
    }
    if lic:
        if isinstance(lic, str):
            comp["licenses"] = [{"license": {"id": lic}}]
        elif isinstance(lic, list):
            comp["licenses"] = [{"license": {"id": l}} for l in lic if isinstance(l, str)]
    h = hashes_from_integrity(integrity)
    if h:
        comp["hashes"] = h
    if resolved:
        comp["externalReferences"] = [{"type": "distribution", "url": resolved}]
    return comp


components = []
for name, rng in sorted(DIRECT_PROD.items()):
    components.append(make_component(name, rng, "prod"))
for name, rng in sorted(DIRECT_DEV.items()):
    components.append(make_component(name, rng, "dev"))

# Transitive closure count for informational metadata.
transitive = sorted({
    k[len("node_modules/"):] for k in lock_pkgs
    if k.startswith("node_modules/")
} - set(DIRECT_PROD) - set(DIRECT_DEV))

sbom = {
    "bomFormat": "CycloneDX",
    "specVersion": "1.5",
    "serialNumber": "urn:uuid:" + str(uuid.uuid5(
        uuid.NAMESPACE_URL, f"ronor:{VERSION}:{COMMIT}")),
    "version": 1,
    "metadata": {
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tools": [{
            "vendor": "Mayleven / RONOR Engineering",
            "name": "ronor-sbom-generator",
            "version": "1.0.0",
        }],
        "authors": [{"name": "AMB (Archeon Master the Best)"}],
        "component": {
            "type": "application",
            "bom-ref": f"pkg:npm/{pkg['name']}@{VERSION}",
            "name": pkg["name"],
            "version": VERSION,
            "description": pkg.get("description", ""),
            "purl": purl(pkg["name"], VERSION),
            "licenses": [{"license": {"id": pkg.get("license", "MIT")}}],
            "author": pkg.get("author", ""),
            "externalReferences": [
                {"type": "vcs", "url": "https://github.com/Constantin1968/RONOR-"},
            ],
            "properties": [
                {"name": "ronor:gitCommit", "value": COMMIT},
                {"name": "ronor:releaseTag", "value": f"v{VERSION}"},
                {"name": "ronor:nodeEngine",
                 "value": pkg.get("engines", {}).get("node", "")},
            ],
        },
        "properties": [
            {"name": "ronor:directProductionDependencies",
             "value": str(len(DIRECT_PROD))},
            {"name": "ronor:directDevelopmentDependencies",
             "value": str(len(DIRECT_DEV))},
            {"name": "ronor:transitivePackagesInLockfile",
             "value": str(len(transitive))},
            {"name": "ronor:lockfileVersion",
             "value": str(lock.get("lockfileVersion"))},
        ],
    },
    "components": components,
    "dependencies": [
        {
            "ref": purl(pkg["name"], VERSION),
            "dependsOn": [c["bom-ref"] for c in components],
        }
    ],
}

out = ROOT / "SBOM.json"
out.write_text(json.dumps(sbom, indent=2, ensure_ascii=False) + "\n")
print(f"wrote {out.relative_to(ROOT)}")
print(f"  spec: CycloneDX 1.5")
print(f"  direct components: {len(components)} "
      f"({len(DIRECT_PROD)} production, {len(DIRECT_DEV)} development)")
print(f"  transitive packages in lockfile: {len(transitive)}")
print(f"  serial: {sbom['serialNumber']}")
