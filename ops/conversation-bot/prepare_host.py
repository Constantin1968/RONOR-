"""Run on Hetzner only. Extract existing credentials locally; never print values."""
import ast
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path("/opt/ronor-bot-isolated")
SOURCE = Path("/opt/ronor/orch_fix/main.py")
EXPECTED = "3e1b7f921b56e5a5f07af150d1fe0de95fd2d639d307fb7b9273e85c3f046902"
COMPOSE = Path("/opt/ronor-servicii-restante-declarativ/orchestrator/docker-compose.yml")
os.umask(0o077)
assert hashlib.sha256(SOURCE.read_bytes()).hexdigest() == EXPECTED, "Original source changed"
old = json.loads(subprocess.check_output(["docker", "inspect", "ronor-orchestrator"]))[0]
assert old["State"]["Running"] and old["HostConfig"]["NetworkMode"] == "host"
env = dict(x.split("=", 1) for x in old["Config"]["Env"] if "=" in x)
tree = ast.parse(SOURCE.read_text())
assignments = {t.id: n.value for n in tree.body if isinstance(n, ast.Assign)
               for t in n.targets if isinstance(t, ast.Name)}


def value(node):
    if isinstance(node, ast.Constant):
        return node.value
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name) and node.func.value.id == "os"
            and node.func.attr == "getenv"):
        name = ast.literal_eval(node.args[0])
        return env.get(name, ast.literal_eval(node.args[1]) if len(node.args) > 1 else "")
    raise ValueError("Unsupported credential expression")


models = assignments["MODELS"]
qwen = next(v for k, v in zip(models.keys, models.values) if ast.literal_eval(k) == "qwen-max")
qwen_key = next(value(v) for k, v in zip(qwen.keys, qwen.values) if ast.literal_eval(k) == "api_key")
config = {
    "telegram_token": value(assignments["TELEGRAM_BOT_TOKEN"]),
    "chat_id": str(value(assignments["TELEGRAM_CHAT_ID"])),
    "memory_key": value(assignments["RMEMORY_API_KEY"]),
    "qwen_key": qwen_key,
    # The configured CIDA root credential is disabled. Never reactivate it.
    "cida_key": "",
}
assert all(config[k] for k in ("telegram_token", "chat_id", "memory_key", "qwen_key"))
assert config["chat_id"].lstrip("-").isdigit()
private, preserved = ROOT / "private", ROOT / "preserved"
private.mkdir(mode=0o700, exist_ok=True)
preserved.mkdir(mode=0o700, exist_ok=True)
for path, content in [
    (private / "relay.json", json.dumps(config)),
    (private / "bot.env", "TELEGRAM_BOT_TOKEN=proxy-managed\nRMEMORY_API_KEY=proxy-managed\n"
     "DASHSCOPE_API_KEY=proxy-managed\nTELEGRAM_CHAT_ID=" + config["chat_id"] + "\n"),
    (preserved / "container.before.json", json.dumps(old)),
    (preserved / "compose.before.yaml", COMPOSE.read_text()),
    (preserved / "main.before.py", SOURCE.read_text()),
]:
    with path.open("x") as f:
        f.write(content)
    os.chmod(path, 0o600)
os.chown(private / "relay.json", 10002, 10001)
os.chmod(private / "relay.json", 0o400)
for name, uid, mode in [("state", 10001, 0o700), ("socket", 10002, 0o710)]:
    path = ROOT / name
    path.mkdir(mode=mode)
    os.chown(path, uid, 10001)
    os.chmod(path, mode)
print(json.dumps({"prepared": True, "credential_values_printed": False,
                  "cida_search": "blocked_no_authorised_read_key",
                  "old_container_still_running": True}))
