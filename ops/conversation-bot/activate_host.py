"""Bounded, non-replaying cutover. Failure leaves the privileged bot stopped."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path("/opt/ronor-bot-isolated")
OLD_COMPOSE = Path("/opt/ronor-servicii-restante-declarativ/orchestrator/docker-compose.yml")
SOURCE = Path("/opt/ronor/orch_fix/main.py")
PRESERVED_NAME = "ronor-orchestrator-pre-isolation-20260924"
os.umask(0o077)
assert hashlib.sha256(SOURCE.read_bytes()).hexdigest() == "3e1b7f921b56e5a5f07af150d1fe0de95fd2d639d307fb7b9273e85c3f046902"
assert hashlib.sha256(OLD_COMPOSE.read_bytes()).hexdigest() == "c4721bdb3b53f58e69196e796446576a7e132edefba6ddffe47834e5b601680a"
old = json.loads(subprocess.check_output(["docker", "inspect", "ronor-orchestrator"]))[0]
before = json.loads((ROOT / "preserved/container.before.json").read_text())
assert old["Id"] == before["Id"] and old["State"]["Running"]
assert subprocess.run(["docker", "inspect", PRESERVED_NAME], capture_output=True).returncode != 0
image = subprocess.check_output(["docker", "image", "inspect",
                                "ronor/conversation-isolated:6b34266",
                                "--format", "{{.Id}}"], text=True).strip()
assert image.startswith("sha256:")
compose = (ROOT / "compose.yaml").read_text().replace(
    "${RONOR_BOT_IMAGE:?immutable local image required}", image)
assert "network_mode: none" in compose and image in compose
(ROOT / "compose.yaml").write_text(compose)
os.chmod(ROOT / "compose.yaml", 0o600)
cmd = ["docker", "compose", "-f", str(ROOT / "compose.yaml")]
subprocess.run(cmd + ["config", "--quiet"], check=True)
subprocess.run(["docker", "update", "--restart=no", "ronor-orchestrator"], check=True)
subprocess.run(["docker", "stop", "-t", "20", "ronor-orchestrator"], check=True)
subprocess.run(["docker", "rename", "ronor-orchestrator", PRESERVED_NAME], check=True)
# Replace the original declarative entrypoint too, after preserving its exact bytes.
# A later compose invocation must not recreate the old privileged service.
OLD_COMPOSE.write_text(compose)
os.chmod(OLD_COMPOSE, 0o600)
with (ROOT / "migrate_inbox.py").open("rb") as src:
    subprocess.run(cmd + ["run", "--rm", "--no-deps", "-T", "--entrypoint", "python",
                          "bot", "-"], stdin=src, check=True)
subprocess.run(cmd + ["up", "-d", "--no-deps", "--pull", "never", "bot"], check=True)
print(json.dumps({"cutover_started": True, "preserved_container": PRESERVED_NAME,
                  "image": image, "rollback_to_privileged_bot": "never automatic"}))
