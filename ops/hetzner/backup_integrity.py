"""Seal/verify a completed backup. Does NOT claim successful database restoration."""
import argparse
import hashlib
import json
import os
from pathlib import Path

MANIFEST = "MANIFEST.sha256.json"


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def files(root):
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("Symlink not allowed in backup snapshot: " + str(path.relative_to(root)))
        if path.is_file() and path.name not in (MANIFEST, "backup.log"):
            yield path


def seal(root):
    root = Path(root)
    if not root.is_dir() or root.is_symlink():
        raise ValueError("Existing real backup directory required")
    target = root / MANIFEST
    if target.exists():
        raise ValueError("Refusing to overwrite an existing integrity manifest")
    os.chmod(root, 0o700)
    entries = {}
    for path in files(root):
        os.chmod(path, 0o600)
        for parent in path.parents:
            if parent == root:
                break
            os.chmod(parent, 0o700)
        entries[path.relative_to(root).as_posix()] = {
            "sha256": digest(path), "bytes": path.stat().st_size}
    if not entries:
        raise ValueError("Empty backup cannot be sealed")
    payload = {"schema": "ronor.backup-integrity/1", "files": entries,
               "excluded_mutable_files": ["backup.log"],
               "restore_tested": False}
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as out:
        json.dump(payload, out, ensure_ascii=False, indent=2)
        out.flush()
        os.fsync(out.fileno())
    return verify(root)


def verify(root):
    root = Path(root)
    data = json.loads((root / MANIFEST).read_text())
    if data.get("schema") != "ronor.backup-integrity/1" or not data.get("files"):
        raise ValueError("Invalid or empty integrity manifest")
    actual = {p.relative_to(root).as_posix(): p for p in files(root)}
    if set(actual) != set(data["files"]):
        raise ValueError("Backup contents differ from the manifest")
    for name, expected in data["files"].items():
        path = actual[name]
        if path.stat().st_size != expected["bytes"] or digest(path) != expected["sha256"]:
            raise ValueError("Integrity mismatch: " + name)
    return {"integrity_verified": True, "files": len(actual), "restore_tested": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["seal", "verify"])
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps((seal if args.operation == "seal" else verify)(args.directory)))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise SystemExit(type(exc).__name__ + ": " + str(exc))
