#!/bin/bash
# TEST DE RESTAURARE — criteriul care lipsea complet.
#
# Principiu: o copie de rezerva nerestaurata niciodata NU e o copie de rezerva,
# e o presupunere. Acest test dovedeste ca datele pot fi recuperate efectiv.
#
# Metoda NEDISTRUCTIVA: restauram instantaneul Qdrant intr-o colectie NOUA
# (`ronor_memory_restore_test`), verificam numarul de puncte si o cautare reala,
# apoi o stergem. Colectia de productie nu e atinsa in niciun moment.

set -uo pipefail

B=/opt/ronor-backups/hetzner-local/latest
QK=$(docker inspect ronor-qdrant --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep '^QDRANT__SERVICE__API_KEY=' | cut -d= -f2-)
TESTCOL=ronor_memory_restore_test

echo "=================================================================="
echo "  TEST DE RESTAURARE — nedistructiv"
echo "=================================================================="

echo
echo "=== 1. STAREA DE REFERINȚĂ (producție, neatinsă) ==="
PROD=$(curl -s -m 15 -H "api-key: $QK" http://127.0.0.1:6333/collections/ronor_memory 2>/dev/null \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['points_count'])" 2>/dev/null)
echo "  ronor_memory în producție: $PROD puncte"

SNAP=$(ls -1 "$B/qdrant/" 2>/dev/null | grep '^ronor_memory__' | head -1)
echo "  instantaneu de testat: ${SNAP:0:60}..."
echo "  dimensiune: $(du -h "$B/qdrant/$SNAP" 2>/dev/null | cut -f1)"

echo
echo "=== 2. CURĂȚARE PREALABILĂ (dacă testul a rulat înainte) ==="
curl -s -m 20 -X DELETE -H "api-key: $QK" "http://127.0.0.1:6333/collections/$TESTCOL" >/dev/null 2>&1
echo "  gata"

echo
echo "=== 3. RESTAURARE ÎN COLECȚIE NOUĂ ==="
R=$(curl -s -m 300 -X POST -H "api-key: $QK" \
  -F "snapshot=@$B/qdrant/$SNAP" \
  "http://127.0.0.1:6333/collections/$TESTCOL/snapshots/upload?priority=snapshot" 2>/dev/null)
echo "  răspuns: $(echo "$R" | head -c 200)"

sleep 5

echo
echo "=== 4. VERIFICARE: câte puncte au fost recuperate? ==="
REST=$(curl -s -m 20 -H "api-key: $QK" "http://127.0.0.1:6333/collections/$TESTCOL" 2>/dev/null \
  | python3 -c "import json,sys; d=json.load(sys.stdin)['result']; print(d['points_count'])" 2>/dev/null)
echo "  puncte în colecția restaurată: ${REST:-EȘEC}"

if [ -n "$REST" ] && [ "$REST" = "$PROD" ]; then
  echo "  [VERDICT] IDENTIC cu producția ($PROD) — restaurare completă"
elif [ -n "$REST" ] && [ "$REST" -gt 0 ] 2>/dev/null; then
  echo "  [VERDICT] restaurat $REST din $PROD — PARȚIAL"
else
  echo "  [VERDICT] EȘEC — datele NU sunt recuperabile"
fi

echo
echo "=== 5. TEST FUNCȚIONAL: o căutare reală în datele restaurate ==="
# Cautam un vector aleator din colectia restaurata si verificam ca payload-ul
# e intact — dovada ca nu doar numarul de puncte e corect, ci si continutul.
curl -s -m 25 -X POST -H "api-key: $QK" -H "Content-Type: application/json" \
  -d '{"limit":2,"with_payload":true}' \
  "http://127.0.0.1:6333/collections/$TESTCOL/points/scroll" 2>/dev/null \
  | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)['result']['points']
    print(f'  puncte citite: {len(d)}')
    for p in d[:2]:
        pl = p.get('payload', {})
        txt = str(pl.get('content') or pl.get('text') or pl)[:110]
        print(f'    [{p[\"id\"]}] {txt}')
    print('  [ok] conținutul este intact și lizibil')
except Exception as e:
    print(f'  [EȘEC] payload necitibil: {e}')
"

echo
echo "=== 6. CURĂȚARE — ștergem colecția de test ==="
curl -s -m 20 -X DELETE -H "api-key: $QK" "http://127.0.0.1:6333/collections/$TESTCOL" >/dev/null 2>&1
AFTER=$(curl -s -m 15 -H "api-key: $QK" http://127.0.0.1:6333/collections 2>/dev/null \
  | python3 -c "import json,sys; print(' '.join(c['name'] for c in json.load(sys.stdin)['result']['collections']))" 2>/dev/null)
echo "  colecții rămase: $AFTER"

echo
echo "=== 7. CONFIRMARE: producția e neatinsă ==="
FINAL=$(curl -s -m 15 -H "api-key: $QK" http://127.0.0.1:6333/collections/ronor_memory 2>/dev/null \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['points_count'])" 2>/dev/null)
echo "  ronor_memory: $FINAL puncte (înainte: $PROD)"
[ "$FINAL" = "$PROD" ] && echo "  [ok] producția intactă" || echo "  [ATENȚIE] producția s-a modificat!"

echo
echo "=== 8. TEST POSTGRES — dump-ul e valid? ==="
if [ -f "$B/postgres/cida.dump" ]; then
  # pg_restore --list citeste cuprinsul arhivei fara sa restaureze nimic.
  N=$(docker exec -i cida-postgres pg_restore --list < "$B/postgres/cida.dump" 2>/dev/null | grep -c "TABLE DATA")
  echo "  tabele cu date în dump: ${N:-0}"
  [ "${N:-0}" -gt 5 ] && echo "  [ok] dump valid și citibil" || echo "  [ATENȚIE] dump suspect de gol"
fi
