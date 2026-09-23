"""Compare one dated backup and its separate secret archive. Never restores data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def inventory(base, stamp, require_private=False):
    if not re.fullmatch(r"[0-9]{8}-[0-9]{6}", stamp):
        raise ValueError("Invalid snapshot identifier")
    base = Path(base)
    if base.is_symlink():
        raise ValueError("Base must not be a symlink")
    root = base / "hetzner-local" / stamp
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Snapshot missing or symlink")
    result = {}
    paths = sorted(root.rglob("*"))
    if require_private:
        for directory in [base, base / "hetzner-local", root, base / "hetzner-local/secrets"]:
            st = directory.lstat()
            if directory.is_symlink() or st.st_uid != 0 or st.st_mode & 0o077:
                raise ValueError("Remote backup directory is not private root-owned storage")
    secret = base / "hetzner-local" / "secrets" / ("env-" + stamp + ".tar.gz")
    if not secret.is_file() or secret.is_symlink():
        raise ValueError("Separate secret archive missing or symlink")
    paths.append(secret)
    for path in paths:
        if path.is_symlink():
            raise ValueError("Symlink inside snapshot")
        if require_private:
            st = path.stat()
            if st.st_uid != 0 or st.st_mode & 0o077:
                raise ValueError("Remote backup object is not private root-owned storage")
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError("Unsupported filesystem object")
        before = path.stat()
        h = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                h.update(block)
        after = path.stat()
        if (before.st_ino, before.st_size, before.st_mtime_ns) != (
                after.st_ino, after.st_size, after.st_mtime_ns):
            raise ValueError("Backup changed during verification")
        result[path.relative_to(base).as_posix()] = {
            "bytes": after.st_size, "sha256": h.hexdigest()}
    if len(result) < 2:
        raise ValueError("Empty snapshot")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("destination")
    parser.add_argument("stamp")
    parser.add_argument("--host", default="root@100.87.14.42")
    parser.add_argument("--known-hosts", default="/root/.ssh/known_hosts")
    args = parser.parse_args()
    # These values become part of the remote command; never accept shell syntax.
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+", args.destination):
        raise ValueError("Invalid remote path")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+", args.host):
        raise ValueError("Invalid remote host")
    local = inventory(args.source, args.stamp)
    # Send only the inventory implementation, not any credential or backup data.
    import inspect
    script = ("import hashlib,json,os,re,sys\nfrom pathlib import Path\n" +
              inspect.getsource(inventory) +
              "\nprint(json.dumps(inventory(sys.argv[1],sys.argv[2],require_private=True),sort_keys=True))\n")
    command = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
               "-o", "UserKnownHostsFile=" + args.known_hosts,
               "-o", "ConnectTimeout=20", args.host,
               "python3", "-", args.destination, args.stamp]
    remote = subprocess.run(command, input=script, text=True, capture_output=True, timeout=600)
    if remote.returncode:
        raise RuntimeError("Remote inventory failed; exit=" + str(remote.returncode))
    if local != json.loads(remote.stdout):
        raise ValueError("Source and destination differ")
    print(json.dumps({"replica_bytes_verified": True, "snapshot": args.stamp,
                      "files_including_secret_archive": len(local), "restore_tested": False,
                      "destination_permissions_private": True,
                      "independent_immutable_retention": False}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
        # No remote stderr or backup contents, which might carry sensitive data.
        raise SystemExit(type(exc).__name__ + ": replication not accepted")
