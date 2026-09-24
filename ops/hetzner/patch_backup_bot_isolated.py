"""Insert isolated-bot coverage into the INSTALLED backup_hetzner.sh.

Refuses unless the installed bytes match the audited hash. Preserves the
original next to the repair evidence. Inserts two blocks at exact anchors:
  3c: consistent SQLite copy + non-secret config into the main snapshot;
  4:  relay credentials and preserved legacy container data into the
      separate 600 secrets archive only.
Usage: patch_backup_bot_isolated.py <script> <expected_sha256> [preserve_path]
"""
import hashlib
import os
from pathlib import Path
import sys

BLOCK_3C = r'''
# ------------------------------- 3c. Bot conversational izolat (fara secrete)
log "--- 3c. Bot conversational izolat ---"
BI="${RONOR_BOT_ISOLATED:-/opt/ronor-bot-isolated}"
if [ -d "$BI" ]; then
  mkdir -p "$D/ronor_bot"
  if python3 - "$BI/state/inbox.sqlite" "$D/ronor_bot/inbox.sqlite" >>"$LOG" 2>&1 <<'PYBOT'
import sqlite3, sys
src = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
assert dst.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
print("  inbox randuri:", dst.execute("SELECT count(*) FROM tasks").fetchone()[0])
PYBOT
  then log "  [ok] ronor_bot/inbox.sqlite (copie consistenta, integritate ok)"
  else log "  [ESEC] ronor_bot/inbox.sqlite"
  fi
  if tar czf "$D/ronor_bot/config.tar.gz" -C "$BI" compose.yaml releases 2>>"$LOG"; then
    log "  [ok] ronor_bot/config.tar.gz (compose si cod; fara private/ si preserved/)"
  else
    log "  [ESEC] ronor_bot/config.tar.gz"
  fi
  chmod -R go= "$D/ronor_bot"
else
  log "  [sarit] $BI inexistent"
fi
'''

BLOCK_SECRETS = r'''# Bot izolat: acreditarile releului si copiile conservate ale vechiului
# container merg exclusiv in arhiva separata de secrete.
for f in "${RONOR_BOT_ISOLATED:-/opt/ronor-bot-isolated}"/private/relay.json \
         "${RONOR_BOT_ISOLATED:-/opt/ronor-bot-isolated}"/preserved/*; do
  [ -f "$f" ] && echo "$f" >> "$SECL"
done
sort -u -o "$SECL" "$SECL"
'''

ANCHOR_3B = "# ------------------------------------------- 3b. Volume de stare (patru)\n"
ANCHOR_SECL = "SECN=$(grep -c . \"$SECL\" || true)\n"


def patch(text):
    assert text.count(ANCHOR_3B) == 1 and text.count(ANCHOR_SECL) == 1, "anchors changed"
    assert "3c. Bot conversational izolat" not in text, "already patched"
    text = text.replace(ANCHOR_3B, BLOCK_3C.lstrip("\n") + "\n" + ANCHOR_3B)
    return text.replace(ANCHOR_SECL, BLOCK_SECRETS + ANCHOR_SECL)


if __name__ == "__main__":
    path, expected = Path(sys.argv[1]), sys.argv[2]
    raw = path.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == expected, "installed script changed"
    if len(sys.argv) > 3:
        keep = Path(sys.argv[3])
        keep.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with keep.open("xb") as f:
            f.write(raw)
        os.chmod(keep, 0o600)
    new = patch(raw.decode()).encode()
    tmp = path.with_suffix(".tmp-bot-isolated")
    tmp.write_bytes(new)
    os.chmod(tmp, os.stat(path).st_mode & 0o7777)
    os.replace(tmp, path)
    print(hashlib.sha256(new).hexdigest())
