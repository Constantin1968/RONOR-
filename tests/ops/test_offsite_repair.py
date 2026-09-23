"""Offline tests only: no SSH, provider API or production writes."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ops/hetzner"))
from offsite_verify import inventory


class ReplicaTests(unittest.TestCase):
    def fixture(self, tmp):
        base = Path(tmp)
        root = base / "hetzner-local/20260923-023001"
        root.mkdir(parents=True)
        (root / "data").write_bytes(b"fixture")
        secret = base / "hetzner-local/secrets"
        secret.mkdir()
        (secret / "env-20260923-023001.tar.gz").write_bytes(b"test-only")
        (base / "hetzner-local/latest").symlink_to(root)
        return base, root

    def test_inventory_includes_separate_secret_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            base, root = self.fixture(tmp)
            got = inventory(base, root.name)
            self.assertEqual(len(got), 2)
            self.assertTrue(any("/secrets/" in p for p in got))

    def test_missing_secret_and_symlink_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            base, root = self.fixture(tmp)
            (root / "link").symlink_to(root / "data")
            with self.assertRaises(ValueError): inventory(base, root.name)
            (root / "link").unlink()
            (base / "hetzner-local/secrets/env-20260923-023001.tar.gz").unlink()
            with self.assertRaises(ValueError): inventory(base, root.name)

    def test_changed_bytes_change_inventory(self):
        with tempfile.TemporaryDirectory() as tmp:
            base, root = self.fixture(tmp)
            before = inventory(base, root.name)
            (root / "data").write_bytes(b"corrupt")
            self.assertNotEqual(before, inventory(base, root.name))

    def test_invalid_snapshot_identifier_refused(self):
        with self.assertRaises(ValueError):
            inventory("/not-read", "../escape")

    def test_remote_public_permissions_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            base, root = self.fixture(tmp)
            (root / "data").chmod(0o644)
            with self.assertRaises(ValueError):
                inventory(base, root.name, require_private=True)

    def run_script(self, rsync_code=0, verify_code=0):
        with tempfile.TemporaryDirectory() as tmp:
            base, root = self.fixture(tmp)
            binpath = base / "bin"
            binpath.mkdir()
            for name, body in {
                "ssh": '#!/bin/sh\nprintf "%s\\n" "$*" >>"$TRACE"\nexit 0\n',
                "rsync": f'#!/bin/sh\nprintf "%s\\n" "$*" >>"$TRACE"\nexit {rsync_code}\n',
            }.items():
                p = binpath / name
                p.write_text(body)
                p.chmod(0o700)
            verifier = base / "verify.py"
            verifier.write_text(f"raise SystemExit({verify_code})\n")
            known = base / "known_hosts"
            known.write_text("fixture\n")
            env = {**os.environ, "PATH": str(binpath) + ":" + os.environ["PATH"],
                   "LOCAL_BASE": str(base), "REMOTE_BASE": "/fixture",
                   "KNOWN_HOSTS": str(known), "VERIFY_SCRIPT": str(verifier),
                   "LOCK_FILE": str(base / "lock"), "LOG_FILE": str(base / "log"),
                   "TRACE": str(base / "trace")}
            result = subprocess.run(["bash", str(ROOT / "ops/hetzner/offsite_sync.sh")], env=env)
            return result.returncode, (base / "log").read_text(), (base / "trace").read_text()

    def test_rsync_failure_is_not_masked(self):
        rc, log, trace = self.run_script(rsync_code=23)
        self.assertEqual(rc, 23)
        self.assertNotIn("offsite_replica_verified", log)
        self.assertNotIn("ln -sfnT", trace)

    def test_integrity_failure_does_not_promote_latest(self):
        rc, log, trace = self.run_script(verify_code=1)
        self.assertEqual(rc, 1)
        self.assertNotIn("ln -sfnT", trace)
        self.assertNotIn("offsite_replica_verified", log)

    def test_success_uses_strict_host_identity_and_relative_pointer(self):
        rc, log, trace = self.run_script()
        self.assertEqual(rc, 0)
        self.assertIn("offsite_replica_verified", log)
        self.assertIn("StrictHostKeyChecking=yes", trace)
        self.assertNotIn("--delete", trace)
        self.assertIn("ln -sfnT -- '20260923-023001' latest", trace)
        self.assertIn("--chown=root:root", trace)
        self.assertIn("--exclude=/hetzner-local/latest", trace)


if __name__ == "__main__":
    unittest.main()
