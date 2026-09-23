#!/bin/bash
# Interim mirror hardening, NOT independent immutable retention.
# Install only after approval. Does not modify source backup permissions.
set -euo pipefail
umask 077

LOCAL_BASE="${LOCAL_BASE:-/opt/ronor-backups}"
REMOTE_BASE="${REMOTE_BASE:-/opt/ronor-backups-offsite}"
REMOTE="${REMOTE:-root@100.87.14.42}"
KNOWN_HOSTS="${KNOWN_HOSTS:-/root/.ssh/known_hosts}"
VERIFY_SCRIPT="${VERIFY_SCRIPT:-/usr/local/lib/ronor/offsite_verify.py}"
LOCK_FILE="${LOCK_FILE:-/var/lock/ronor-offsite.lock}"
LOG_FILE="${LOG_FILE:-/var/log/ronor-offsite.log}"
[[ "$REMOTE_BASE" =~ ^/[A-Za-z0-9_./-]+$ ]] || exit 64
[[ "$REMOTE" =~ ^[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+$ ]] || exit 64
[[ "$KNOWN_HOSTS" =~ ^/[A-Za-z0-9_./-]+$ ]] || exit 64
[[ -f "$KNOWN_HOSTS" && -f "$VERIFY_SCRIPT" ]] || exit 66

exec 9>"$LOCK_FILE"
flock -n 9 || exit 75
exec >>"$LOG_FILE" 2>&1
echo "=== offsite $(date -u +%FT%TZ) ==="
trap 'rc=$?; echo "offsite_exit=$rc"; exit "$rc"' EXIT

STAMP=$(basename -- "$(readlink -f -- "$LOCAL_BASE/hetzner-local/latest")")
[[ "$STAMP" =~ ^[0-9]{8}-[0-9]{6}$ ]] || exit 65
[[ -d "$LOCAL_BASE/hetzner-local/$STAMP" ]] || exit 66
SSH=(ssh -o BatchMode=yes -o StrictHostKeyChecking=yes
     -o "UserKnownHostsFile=$KNOWN_HOSTS" -o ConnectTimeout=20)

# Root remains the current recipient; migrate to a restricted account separately.
# Do not claim that this makes the backup immune to a compromised source.
"${SSH[@]}" "$REMOTE" "test -d '$REMOTE_BASE' && test ! -L '$REMOTE_BASE' && chown root:root '$REMOTE_BASE' && chmod 700 '$REMOTE_BASE'"
rsync -aH --timeout=600 --safe-links \
  --exclude=/hetzner-local/latest \
  --chown=root:root --chmod=Dgo=,Fgo= \
  -e "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS -o ConnectTimeout=20" \
  "$LOCAL_BASE/" "$REMOTE:$REMOTE_BASE/"

# A failed rsync or verification must stop before the success marker and latest.
python3 "$VERIFY_SCRIPT" "$LOCAL_BASE" "$REMOTE_BASE" "$STAMP" \
  --host "$REMOTE" --known-hosts "$KNOWN_HOSTS"
"${SSH[@]}" "$REMOTE" "test -d '$REMOTE_BASE/hetzner-local/$STAMP' && cd '$REMOTE_BASE/hetzner-local' && ln -sfnT -- '$STAMP' latest"
echo "offsite_replica_verified snapshot=$STAMP restore_tested=false"
