#!/usr/bin/env bash
#
# R-Knowledge Disabled-Mode Runtime Equivalence Harness
# MIP-014 STEP 2 · Phase 5 · Gate G5 (ABSOLUTE)
#
# Boots the compiled runtime in DISABLED mode and in ENABLED mode and records the
# observable difference between them. Static analysis proves the composition root
# is correctly guarded; this harness proves the RUNTIME behaves accordingly, which
# is a different claim and the one an operator actually cares about.
#
# Boot uses `node dist/index.js`, the documented start path. `ts-node src/index.ts`
# does not boot at the BASELINE commit either — src/api/model-exchange-router.ts
# imports "../model-exchange/registry.js" with an explicit .js extension, which
# CommonJS ts-node cannot resolve. That is a pre-existing condition of the baseline,
# recorded here rather than fixed, because fixing it is outside this Order's scope.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT_DISABLED=3091
PORT_ENABLED=3092
OUT="evidence/knowledge"

# Kill any lingering process on the ports we intend to use, so a re-run after a
# partial failure does not collide with a zombie from the previous attempt.
for _port in $PORT_DISABLED $PORT_ENABLED; do
  _pid=$(ss -ltnp 2>/dev/null | grep ":${_port}" | grep -oP 'pid=\K[0-9]+' | head -1 || true)
  [ -n "$_pid" ] && kill "$_pid" 2>/dev/null && sleep 0.5
done
mkdir -p "$OUT"

snapshot_fs() {
  # data/ is excluded: it contains audit.db and its WAL/SHM files, which the
  # runtime updates on every boot regardless of whether R-Knowledge is enabled.
  # The claim BE-5 is testing is that R-Knowledge ITSELF creates no file; the
  # audit database is a pre-existing side effect of the runtime, not of this plane.
  find . -path ./node_modules -prune -o -path ./.git -prune -o -path ./dist -prune \
    -o -path ./evidence -prune -o -path ./data -prune -o -print 2>/dev/null | sort
}

wait_for_health() {
  local port="$1" attempts=0
  until curl -sf -o /dev/null "http://localhost:${port}/health"; do
    attempts=$((attempts + 1))
    [ "$attempts" -gt 40 ] && return 1
    sleep 0.5
  done
  return 0
}

probe_routes() {
  local port="$1"
  # POST routes probed with POST and GET routes with GET. Probing a GET route with
  # POST returns 404 from Express whether or not the route is mounted, so a
  # uniform POST probe would have reported /status and /quarantine as absent even
  # when the plane was enabled — an accidental false PASS on the disabled-mode
  # claim, caused by the probe rather than by the runtime.
  # `corpus` added by MIP-015 Stage D. It MUST appear here: a route absent from this
  # probe would never be checked for the disabled-mode 404, and the equivalence
  # claim would be silently narrower than it appears.
  for route in ingest corpus query compose; do
    printf '/api/v1/knowledge/%s %s\n' "$route" \
      "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
         -d '{}' "http://localhost:${port}/api/v1/knowledge/${route}")"
  done
  for route in status quarantine; do
    printf '/api/v1/knowledge/%s %s\n' "$route" \
      "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${port}/api/v1/knowledge/${route}")"
  done
  for route in health api/v1/sentinel/status api/v1/model-exchange/registry; do
    printf '/%s %s\n' "$route" \
      "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${port}/${route}")"
  done
}

echo "== building =="
npm run build >/dev/null 2>&1 || { echo "BUILD FAILED"; exit 1; }

# ── DISABLED MODE ────────────────────────────────────────────────────────────
echo "== disabled mode =="
snapshot_fs > /tmp/eq_fs_before.txt

env -u KNOWLEDGE_ENABLED PORT="$PORT_DISABLED" node dist/index.js > /tmp/eq_disabled_boot.log 2>&1 &
DISABLED_PID=$!
wait_for_health "$PORT_DISABLED" || { echo "DISABLED BOOT FAILED"; cat /tmp/eq_disabled_boot.log; kill $DISABLED_PID 2>/dev/null; exit 1; }

curl -s "http://localhost:${PORT_DISABLED}/health" > "$OUT/health-disabled.json"
probe_routes "$PORT_DISABLED" > "$OUT/routes-disabled.txt"
# Open handles held by the process, to evidence that no store or socket was opened.
ls -l /proc/$DISABLED_PID/fd 2>/dev/null | wc -l > /tmp/eq_fd_disabled.txt
lsof -p $DISABLED_PID 2>/dev/null | grep -c "knowledge" > /tmp/eq_knowledge_handles.txt || echo 0 > /tmp/eq_knowledge_handles.txt

kill $DISABLED_PID 2>/dev/null
wait $DISABLED_PID 2>/dev/null
snapshot_fs > /tmp/eq_fs_after.txt

echo "-- filesystem diff (must be EMPTY) --"
diff /tmp/eq_fs_before.txt /tmp/eq_fs_after.txt > "$OUT/fs-diff-disabled.txt" 2>&1
FS_DIFF_LINES=$(wc -l < "$OUT/fs-diff-disabled.txt")
echo "diff lines: $FS_DIFF_LINES"

# ── ENABLED MODE (for contrast; proves the harness can detect a difference) ──
echo "== enabled mode =="
env KNOWLEDGE_ENABLED=true \
    KNOWLEDGE_VECTOR_STORE=sqlite \
    KNOWLEDGE_SQLITE_PATH=/tmp/eq_knowledge.db \
    KNOWLEDGE_EMBEDDING_DIMENSIONS=384 \
    PORT="$PORT_ENABLED" node dist/index.js > /tmp/eq_enabled_boot.log 2>&1 &
ENABLED_PID=$!
wait_for_health "$PORT_ENABLED" || { echo "ENABLED BOOT FAILED"; cat /tmp/eq_enabled_boot.log; kill $ENABLED_PID 2>/dev/null; exit 1; }

curl -s "http://localhost:${PORT_ENABLED}/health" > "$OUT/health-enabled.json"
probe_routes "$PORT_ENABLED" > "$OUT/routes-enabled.txt"

kill $ENABLED_PID 2>/dev/null
wait $ENABLED_PID 2>/dev/null
rm -f /tmp/eq_knowledge.db

echo "== comparing =="
python3 scripts/knowledge-equivalence-report.py
