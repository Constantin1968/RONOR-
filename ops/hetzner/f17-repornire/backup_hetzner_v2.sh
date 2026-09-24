#!/bin/bash
# Backup pentru nodul HETZNER — golul descoperit in audit.
#
# Constatare critica: backupul existent copiaza /opt/ronor DE PE nodul DO.
# NU acopera nimic de pe Hetzner, unde se afla de fapt tot ce am construit:
#   - Qdrant: 4850 vectori (231 canon + 383 corpus + 4236 arhiva AMB)
#   - Postgres CIDA: 765 documente, 4645 entitati, 14019 evenimente audit
#   - /opt/ronor: scripturi, rapoarte, lanț de audit al portii
#
# Strategie: instantanee Qdrant prin API (metoda oficiala, consistenta),
# pg_dump pentru Postgres, tar pentru cod si configuratie.
# Secretele NU se includ in arhiva principala — separat, cu permisiuni stricte.

set -uo pipefail

TS=$(date +%Y%m%d-%H%M%S)
DEST=${RONOR_BACKUP_DEST:-/opt/ronor-backups/hetzner-local}
D="$DEST/$TS"
mkdir -p "$D"
LOG="$D/backup.log"

log() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$LOG"; }

# F17 (24.09.2026): fiecare esec se inregistreaza, iar la final scriptul iese
# cu cod 1 daca exista macar unul. O copie partiala nu devine `latest` si nu
# declanseaza retentia, ca esecuri repetate sa nu stearga ultimele copii bune.
ESECURI=()
esec() { log "  [EȘEC] $*"; ESECURI+=("$*"); }

log "=== BACKUP HETZNER $TS ==="

# ---------------------------------------------------------------- 1. Qdrant
log "--- 1. Qdrant (memoria RONOR) ---"
# Cheia se afla in containerul `ronor-qdrant` (nu `ronor-qdrant-tls`), sub
# numele QDRANT__SERVICE__API_KEY. Valoarea poate contine `=`, deci `cut -f2-`.
QK=$(docker inspect ronor-qdrant --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep '^QDRANT__SERVICE__API_KEY=' | cut -d= -f2-)
if [ -z "$QK" ]; then
  QK=$(docker inspect ronor-r-memory --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep '^RMEMORY_QDRANT_API_KEY=' | cut -d= -f2-)
fi
[ -n "$QK" ] && log "cheie Qdrant: prezentă" || esec "cheie Qdrant absentă (instantaneele vor eșua)"

COLS=$(curl -s -m 20 -H "api-key: $QK" http://127.0.0.1:6333/collections 2>/dev/null \
  | python3 -c "import json,sys; print(' '.join(c['name'] for c in json.load(sys.stdin)['result']['collections']))" 2>/dev/null)
log "colecții: $COLS"
[ -n "$COLS" ] || esec "Qdrant: nicio colecție listată (API indisponibil sau cheie greșită)"

mkdir -p "$D/qdrant"
for c in $COLS; do
  R=$(curl -s -m 180 -X POST -H "api-key: $QK" "http://127.0.0.1:6333/collections/$c/snapshots" 2>/dev/null)
  N=$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['name'])" 2>/dev/null)
  if [ -n "$N" ]; then
    if curl -sf -m 300 -H "api-key: $QK" -o "$D/qdrant/${c}__${N}" \
      "http://127.0.0.1:6333/collections/$c/snapshots/$N" 2>/dev/null \
      && [ -s "$D/qdrant/${c}__${N}" ]; then
      SZ=$(du -h "$D/qdrant/${c}__${N}" 2>/dev/null | cut -f1)
      log "  [ok] $c -> $SZ"
    else
      esec "Qdrant $c: descărcarea instantaneului $N a eșuat sau fișierul e gol"
    fi
    # curatam instantaneul din Qdrant, ca sa nu umple discul
    curl -s -m 30 -X DELETE -H "api-key: $QK" "http://127.0.0.1:6333/collections/$c/snapshots/$N" >/dev/null 2>&1
  else
    esec "Qdrant $c: instantaneul nu s-a creat"
  fi
done

# ------------------------------------------------------------- 2. Postgres
log "--- 2. Postgres CIDA ---"
mkdir -p "$D/postgres"
if docker exec cida-postgres pg_dump -U cida -d cida -Fc > "$D/postgres/cida.dump" 2>>"$LOG"; then
  log "  [ok] cida.dump $(du -h "$D/postgres/cida.dump" | cut -f1)"
else
  esec "pg_dump cida"
fi

# Selectia dupa nume prinde si containere care nu sunt servere Postgres
# (ronor-gov-postgrest e PostgREST). Decide capabilitatea, nu numele: fara
# pg_dumpall in container nu exista o baza de descarcat, deci e sarit explicit.
for c in $(docker ps --format '{{.Names}}' | grep -iE 'postgres' | grep -v cida-postgres); do
  if ! docker exec "$c" sh -c 'command -v pg_dumpall' >/dev/null 2>&1; then
    log "  [sarit] $c (fara pg_dumpall: nu este server Postgres)"
    continue
  fi
  docker exec "$c" sh -c 'pg_dumpall -U ${POSTGRES_USER:-postgres}' > "$D/postgres/${c}.sql" 2>>"$LOG" \
    && log "  [ok] ${c}.sql $(du -h "$D/postgres/${c}.sql" | cut -f1)" \
    || esec "pg_dumpall $c"
done

# ------------------------------------------------------------------ 3. cod
log "--- 3. Cod și configurație ---"
# Codul 1 de la tar inseamna doar "un fisier s-a schimbat pe durata citirii" —
# normal pe un arbore viu. Doar codul 2 e o eroare adevarata. Fara aceasta
# distinctie, eticheta [partial] aparea in fiecare zi si ascundea eroarea reala.
tar czf "$D/opt_ronor.tar.gz" \
  --warning=no-file-changed --warning=no-file-removed \
  --exclude='*.tar.gz' --exclude='amb_text*' --exclude='__pycache__' \
  --exclude='*.env' --exclude='.report_env' --exclude='venv' \
  -C /opt ronor 2>/dev/null
RC=$?
NF=$(tar tzf "$D/opt_ronor.tar.gz" 2>/dev/null | grep -vc '/$')
if [ "$RC" -le 1 ] && [ "${NF:-0}" -ge 2000 ]; then
  log "  [ok] opt_ronor.tar.gz $(du -h "$D/opt_ronor.tar.gz" | cut -f1), $NF fisiere"
else
  esec "opt_ronor.tar.gz cod=$RC fisiere=$NF"
fi

tar czf "$D/caddy_config.tar.gz" -C /etc caddy 2>/dev/null \
  && log "  [ok] caddy_config.tar.gz" || esec "caddy_config.tar.gz"

# lanțul de audit al porții — element critic de guvernanță
if [ -f /opt/ronor/operators/audit.db ]; then
  cp -a /opt/ronor/operators/audit.db "$D/audit_gate.db" 2>/dev/null \
    && log "  [ok] audit_gate.db $(du -h "$D/audit_gate.db" | cut -f1)" \
    || esec "audit_gate.db: copierea a eșuat"
else
  log "  [sarit] /opt/ronor/operators/audit.db inexistent"
fi

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
  else esec "ronor_bot/inbox.sqlite"
  fi
  if tar czf "$D/ronor_bot/config.tar.gz" -C "$BI" compose.yaml releases 2>>"$LOG"; then
    log "  [ok] ronor_bot/config.tar.gz (compose si cod; fara private/ si preserved/)"
  else
    esec "ronor_bot/config.tar.gz"
  fi
  chmod -R go= "$D/ronor_bot"
else
  log "  [sarit] $BI inexistent"
fi

# ------------------------------------------- 3b. Volume de stare (patru)
log "--- 3b. Volume de stare ---"
mkdir -p "$D/volume"

# Dify: baza Postgres proprie. Bucla de la sectiunea 2 o rateaza, pentru ca
# numele containerului (ronor-dify-db) nu contine sirul "postgres".
if docker exec ronor-dify-db sh -c 'pg_dumpall -U ${POSTGRES_USER:-postgres}' > "$D/volume/dify.sql" 2>>"$LOG"; then
  SZ=$(du -h "$D/volume/dify.sql" | cut -f1)
  LN=$(wc -l < "$D/volume/dify.sql")
  if [ "${LN:-0}" -ge 20 ]; then
    log "  [ok] dify.sql $SZ, $LN linii"
  else
    esec "dify.sql are doar $LN linii"
  fi
else
  esec "pg_dumpall ronor-dify-db"
fi

# Restul: arhive ale directoarelor de volum.
for v in cida_cida_lake n8n_n8n_data prefect_prefect_data; do
  MP=$(docker volume inspect "$v" --format '{{.Mountpoint}}' 2>/dev/null)
  if [ -z "$MP" ] || [ ! -d "$MP" ]; then log "  [sarit] $v (inexistent)"; continue; fi
  tar czf "$D/volume/${v}.tar.gz" \
    --warning=no-file-changed --warning=no-file-removed \
    -C "$MP" . 2>/dev/null
  RCV=$?
  NFV=$(tar tzf "$D/volume/${v}.tar.gz" 2>/dev/null | grep -vc '/$')
  if [ "$RCV" -le 1 ] && [ "${NFV:-0}" -ge 1 ]; then
    log "  [ok] ${v}.tar.gz $(du -h "$D/volume/${v}.tar.gz" | cut -f1), $NFV fisiere"
  else
    esec "$v cod=$RCV fisiere=$NFV"
  fi
done

# ------------------------------------------------------ 4. secrete, separat
log "--- 4. Secrete (arhivă separată, 600) ---"
mkdir -p "$DEST/secrets"
# Toate fisierele de mediu vii, descoperite la fiecare rulare - nu o lista fixa.
# Copiile vechi (.bak/.backup) sunt excluse: contin acreditari deja retrase.
SECL=$(mktemp)
find /opt /srv -maxdepth 4 \
  \( -name '.env' -o -name '.env.*' -o -name '*.env' -o -name '.report_env' \) \
  -type f 2>/dev/null | grep -vE '\.bak|\.backup' | sort -u > "$SECL"
# Bot izolat: acreditarile releului si copiile conservate ale vechiului
# container merg exclusiv in arhiva separata de secrete.
for f in "${RONOR_BOT_ISOLATED:-/opt/ronor-bot-isolated}"/private/relay.json \
         "${RONOR_BOT_ISOLATED:-/opt/ronor-bot-isolated}"/preserved/*; do
  [ -f "$f" ] && echo "$f" >> "$SECL"
done
sort -u -o "$SECL" "$SECL"
SECN=$(grep -c . "$SECL" || true)
cp "$SECL" "$D/INVENTAR-mediu.txt" 2>/dev/null
if [ "${SECN:-0}" -lt 20 ]; then
  esec "doar ${SECN:-0} fisiere de mediu gasite (minim asteptat 20)"
  log "         arhiva de secrete NU s-a scris - o arhiva incompleta ar induce in eroare"
  STATUS_SECRETE=esec
else
  tar czf "$DEST/secrets/env-$TS.tar.gz" -T "$SECL" 2>/dev/null \
    || esec "env-$TS.tar.gz: tar a raportat eroare"
  chmod 600 "$DEST/secrets/env-$TS.tar.gz" 2>/dev/null
  AN=$(tar tzf "$DEST/secrets/env-$TS.tar.gz" 2>/dev/null | grep -vc '/$')
  log "  [ok] env-$TS.tar.gz: $AN fisiere de mediu (chmod 600, in afara arhivei principale)"
  if [ "${AN:-0}" -lt "${SECN:-0}" ]; then
    esec "arhiva de secrete are $AN din $SECN fisiere asteptate"
  fi
  STATUS_SECRETE=ok
fi
rm -f "$SECL"

# ------------------------------------------------------------ 5. inventar
log "--- 5. Inventar pentru restaurare ---"
{
  echo "# Inventar backup Hetzner $TS"
  echo "## Containere active"
  docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}'
  echo "## Volume"
  docker volume ls --format '{{.Name}}'
  echo "## Servicii systemd RONOR"
  systemctl list-units --type=service --state=running --no-legend 2>/dev/null | grep -iE 'ronor|caddy' | awk '{print $1}'
  echo "## Cron"
  crontab -l 2>/dev/null
} > "$D/INVENTAR.txt" 2>/dev/null
[ -s "$D/INVENTAR.txt" ] && log "  [ok] INVENTAR.txt" || esec "INVENTAR.txt gol"

# ---------------------------------------------------------------- 6. bilanț
TOTAL=$(du -sh "$D" 2>/dev/null | cut -f1)
log "=== TOTAL: $TOTAL în $D ==="

NE=${#ESECURI[@]}
if [ "$NE" -eq 0 ]; then
  echo "complet" > "$D/STARE.txt"
  # retenție: păstrăm 14 zile, dar numai după o copie completă
  find "$DEST" -maxdepth 1 -type d -name '20*' -mtime +14 -exec rm -rf {} + 2>/dev/null || true
  find "$DEST/secrets" -name 'env-*.tar.gz' -mtime +14 -delete 2>/dev/null || true
  ln -sfn "$D" "$DEST/latest"
  log "verificare: $(ls -1 "$D" | wc -l) elemente"
  ls -la "$D" | tail -12 | tee -a "$LOG"
  log "=== STARE: complet; latest -> $D ==="
  echo "#SUMAR# Copie Hetzner completă: $TOTAL în $D"
  exit 0
fi
{ echo "partial"; printf '%s\n' "${ESECURI[@]}"; } > "$D/STARE.txt"
ls -la "$D" | tail -12 | tee -a "$LOG"
log "=== STARE: PARȚIAL, $NE eșecuri; latest rămâne $(readlink "$DEST/latest" 2>/dev/null || echo nedefinit); retenția nu a rulat ==="
echo "#SUMAR# Copie Hetzner PARȚIALĂ: $NE eșecuri în $D"
for e in "${ESECURI[@]}"; do echo "#SUMAR#   - $e"; done
echo "#SUMAR# latest a rămas la ultima copie completă; retenția nu a rulat"
exit 1
