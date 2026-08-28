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
DEST=/opt/ronor-backups/hetzner-local
D="$DEST/$TS"
mkdir -p "$D"
LOG="$D/backup.log"

log() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$LOG"; }

log "=== BACKUP HETZNER $TS ==="

# ---------------------------------------------------------------- 1. Qdrant
log "--- 1. Qdrant (memoria RONOR) ---"
# Cheia se afla in containerul `ronor-qdrant` (nu `ronor-qdrant-tls`), sub
# numele QDRANT__SERVICE__API_KEY. Valoarea poate contine `=`, deci `cut -f2-`.
QK=$(docker inspect ronor-qdrant --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep '^QDRANT__SERVICE__API_KEY=' | cut -d= -f2-)
if [ -z "$QK" ]; then
  QK=$(docker inspect ronor-r-memory --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep '^RMEMORY_QDRANT_API_KEY=' | cut -d= -f2-)
fi
[ -n "$QK" ] && log "cheie Qdrant: prezentă" || log "cheie Qdrant: ABSENTĂ (instantaneele vor eșua)"

COLS=$(curl -s -m 20 -H "api-key: $QK" http://127.0.0.1:6333/collections 2>/dev/null \
  | python3 -c "import json,sys; print(' '.join(c['name'] for c in json.load(sys.stdin)['result']['collections']))" 2>/dev/null)
log "colecții: $COLS"

mkdir -p "$D/qdrant"
for c in $COLS; do
  R=$(curl -s -m 180 -X POST -H "api-key: $QK" "http://127.0.0.1:6333/collections/$c/snapshots" 2>/dev/null)
  N=$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['name'])" 2>/dev/null)
  if [ -n "$N" ]; then
    curl -s -m 300 -H "api-key: $QK" -o "$D/qdrant/${c}__${N}" \
      "http://127.0.0.1:6333/collections/$c/snapshots/$N" 2>/dev/null
    SZ=$(du -h "$D/qdrant/${c}__${N}" 2>/dev/null | cut -f1)
    log "  [ok] $c -> $SZ"
    # curatam instantaneul din Qdrant, ca sa nu umple discul
    curl -s -m 30 -X DELETE -H "api-key: $QK" "http://127.0.0.1:6333/collections/$c/snapshots/$N" >/dev/null 2>&1
  else
    log "  [EȘEC] $c"
  fi
done

# ------------------------------------------------------------- 2. Postgres
log "--- 2. Postgres CIDA ---"
mkdir -p "$D/postgres"
if docker exec cida-postgres pg_dump -U cida -d cida -Fc > "$D/postgres/cida.dump" 2>>"$LOG"; then
  log "  [ok] cida.dump $(du -h "$D/postgres/cida.dump" | cut -f1)"
else
  log "  [EȘEC] pg_dump cida"
fi

for c in $(docker ps --format '{{.Names}}' | grep -iE 'postgres' | grep -v cida-postgres); do
  docker exec "$c" sh -c 'pg_dumpall -U ${POSTGRES_USER:-postgres}' > "$D/postgres/${c}.sql" 2>>"$LOG" \
    && log "  [ok] ${c}.sql $(du -h "$D/postgres/${c}.sql" | cut -f1)" \
    || log "  [sărit] $c"
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
  log "  [EȘEC] opt_ronor.tar.gz cod=$RC fisiere=$NF"
fi

tar czf "$D/caddy_config.tar.gz" -C /etc caddy 2>/dev/null \
  && log "  [ok] caddy_config.tar.gz"

# lanțul de audit al porții — element critic de guvernanță
if [ -f /opt/ronor/operators/audit.db ]; then
  cp -a /opt/ronor/operators/audit.db "$D/audit_gate.db" 2>/dev/null \
    && log "  [ok] audit_gate.db $(du -h "$D/audit_gate.db" | cut -f1)"
fi

# ------------------------------------------------------ 4. secrete, separat
log "--- 4. Secrete (arhivă separată, 600) ---"
mkdir -p "$DEST/secrets"
tar czf "$DEST/secrets/env-$TS.tar.gz" \
  /opt/ronor/.report_env /opt/n8n/.env 2>/dev/null
chmod 600 "$DEST/secrets/env-$TS.tar.gz" 2>/dev/null
log "  [ok] env-$TS.tar.gz (chmod 600, în afara arhivei principale)"

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
log "  [ok] INVENTAR.txt"

# ---------------------------------------------------------------- 6. bilanț
TOTAL=$(du -sh "$D" 2>/dev/null | cut -f1)
log "=== TOTAL: $TOTAL în $D ==="

# retenție: păstrăm 14 zile
find "$DEST" -maxdepth 1 -type d -name '20*' -mtime +14 -exec rm -rf {} + 2>/dev/null || true
find "$DEST/secrets" -name 'env-*.tar.gz' -mtime +14 -delete 2>/dev/null || true

ln -sfn "$D" "$DEST/latest"
log "verificare: $(ls -1 "$D" | wc -l) elemente"
ls -la "$D" | tail -12 | tee -a "$LOG"
