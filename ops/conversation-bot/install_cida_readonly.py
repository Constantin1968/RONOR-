"""Run on Hetzner as root. Issue a read-only CIDA key into the relay only.

Never prints the key. On any verification failure: disables only the new key,
restores the previous relay configuration and recreates only the relay.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path("/opt/ronor-bot-isolated")
RELAY = ROOT / "private/relay.json"
BEFORE = ROOT / "preserved/relay.before-cida-readonly-20260924.json"
LABEL = "ronor-bot-readonly-20260924"
COMPOSE = ["docker", "compose", "-f", str(ROOT / "compose.yaml")]
os.umask(0o077)


def cida(code, stdin=None):
    out = subprocess.run(["docker", "exec", "-i", "cida-api", "python", "-c", code],
                         input=stdin, capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise RuntimeError("cida exec failed")
    return json.loads(out.stdout.strip().splitlines()[-1])


def status(url, key):
    req = urllib.request.Request(url, headers={"X-API-Key": key})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, None


def recreate_relay():
    subprocess.run(COMPOSE + ["up", "-d", "--no-deps", "--force-recreate", "--pull", "never", "egress"],
                   check=True, capture_output=True, timeout=120)
    for _ in range(40):
        h = subprocess.check_output(["docker", "inspect", "ronor-bot-egress", "--format",
                                     "{{.State.Health.Status}}"], text=True).strip()
        if h == "healthy":
            return
        time.sleep(2)
    raise RuntimeError("relay not healthy")


def write_relay(config):
    tmp = RELAY.with_suffix(".tmp")
    tmp.write_text(json.dumps(config))
    os.chown(tmp, 10002, 10001)
    os.chmod(tmp, 0o400)
    os.replace(tmp, RELAY)


existing = cida("import json;from cida import db;print(json.dumps(db.q("
                "'SELECT id FROM api_keys WHERE label=%s',(" + repr(LABEL) + ",))))")
assert existing == [], "label already exists; refusing duplicate issuance"
assert not BEFORE.exists(), "previous run evidence exists; manual review required"
shutil.copy2(RELAY, BEFORE)
os.chmod(BEFORE, 0o600)
config = json.loads(RELAY.read_text())
assert config.get("cida_key") == ""

issued = cida(
    "import json;from cida import db;from cida.governance.auth import create_key\n"
    "r=create_key(" + repr(LABEL) + ",['read'],rate_limit=60)\n"
    "db.execute(\"UPDATE api_keys SET expires_at=now()+interval '90 days' WHERE id=%s\",(r['id'],))\n"
    "x=db.q1('SELECT scopes,rate_limit,enabled,expires_at FROM api_keys WHERE id=%s',(r['id'],))\n"
    "print(json.dumps({'k':r['api_key'],'id':r['id'],'scopes':x['scopes'],'rate':x['rate_limit'],"
    "'enabled':x['enabled'],'expires':str(x['expires_at'])}))")
key, key_id = issued.pop("k"), issued["id"]
summary = {"key_id": key_id, "label": LABEL, "record": issued, "key_printed": False}
try:
    assert issued["scopes"] == ["read"] and issued["rate"] == 60 and issued["enabled"]
    code, body = status("http://127.0.0.1:8300/search?q=RONOR&limit=1&mode=lexical", key)
    summary["direct_search"] = code
    assert code == 200
    for path in ("/keys", "/audit", "/retention"):
        c, _ = status("http://127.0.0.1:8300" + path, key)
        summary["direct" + path.replace("/", "_")] = c
        assert c == 403, path
    write_relay(config | {"cida_key": key})
    recreate_relay()
    probe = subprocess.run(
        ["docker", "exec", "-i", "ronor-orchestrator", "python", "-"], input=(
            "import asyncio,json,sys\nsys.path.insert(0,'/app')\n"
            "from relay_transport import http_client\n"
            "async def m():\n"
            " async with http_client(timeout=20) as c:\n"
            "  r=await c.get('http://cida-api:8300/search',params={'q':'RONOR','limit':2,'mode':'lexical'})\n"
            "  d=r.json() if r.status_code==200 else {}\n"
            "  a=await c.get('http://cida-api:8300/keys')\n"
            "  s=await c.get('http://cida-api:8300/search',params={'q':'RONOR','limit':2,'mode':'semantic'})\n"
            "  print(json.dumps({'relay_search':r.status_code,'keys':sorted(d),"
            "'results':len(d.get('results',[])),"
            "'item_keys':sorted(d['results'][0]) if d.get('results') else [],"
            "'relay_keys_admin':a.status_code,'relay_semantic':s.status_code}))\n"
            "asyncio.run(m())\n"), capture_output=True, text=True, timeout=60)
    result = json.loads(probe.stdout.strip().splitlines()[-1])
    summary.update(result)
    assert result["relay_search"] == 200 and result["relay_keys_admin"] == 403
    assert result["relay_semantic"] == 403
    summary["installed"] = True
except Exception as exc:
    summary["installed"] = False
    summary["failure"] = type(exc).__name__ + ":" + str(exc).replace(key, "[redacted]")[:200]
    cida("import json;from cida import db\n"
         "db.execute('UPDATE api_keys SET enabled=FALSE WHERE id=%s',(" + str(int(key_id)) + ",))\n"
         "print(json.dumps({'ok':True}))")
    shutil.copy2(BEFORE, RELAY)
    os.chown(RELAY, 10002, 10001)
    os.chmod(RELAY, 0o400)
    recreate_relay()
    summary["rolled_back"] = "new key disabled; relay restored with search blocked"
print(json.dumps(summary, default=str))
