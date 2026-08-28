#!/bin/bash
# Rulează un audit RONOR și livrează rezultatul prin Telegram + email.
# Variabile: RONOR_BOT_TOKEN, RONOR_CHAT_ID, RONOR_MAIL_FROM, RONOR_MAIL_TO,
#            RESEND_API_KEY  (din /opt/ronor/.report_env)
set -uo pipefail
TIP="${1:-maturitate}"
TS=$(date -u +%Y%m%d-%H%M%S)
OUT=/opt/ronor/reports/audit_${TIP}_${TS}.txt
mkdir -p /opt/ronor/reports

set -a; . /opt/ronor/.report_env 2>/dev/null; set +a

case "$TIP" in
  maturitate)  python3 /opt/ronor/maturitate.py      > "$OUT" 2>&1 ;;
  restaurare)  bash    /opt/ronor/test_restaurare.sh > "$OUT" 2>&1 ;;
  backup)      bash    /opt/ronor/backup_hetzner.sh  > "$OUT" 2>&1 ;;
  surse)       python3 /opt/ronor/analiza_surse.py   > "$OUT" 2>&1 ;;
  *)           echo "tip necunoscut: $TIP" > "$OUT" ;;
esac

SUMAR=$(grep -E "SCOR:|VERDICT|TOTAL:|CRITERII CRITICE|\[ok\]|\[EȘEC\]" "$OUT" 2>/dev/null | head -8)
[ -z "$SUMAR" ] && SUMAR=$(tail -8 "$OUT")

MSG="RONOR — AUDIT AUTOMAT: ${TIP}
$(date -u '+%Y-%m-%d %H:%M UTC')

${SUMAR}

Raport complet pe nod: ${OUT}
Generat pe nodul suveran. Fără infrastructură Manus."

if [ -n "${RONOR_BOT_TOKEN:-}" ] && [ -n "${RONOR_CHAT_ID:-}" ]; then
  R=$(curl -s -m 30 -X POST "https://api.telegram.org/bot${RONOR_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${RONOR_CHAT_ID}" \
    --data-urlencode "text=${MSG}" 2>&1)
  echo "$R" | grep -q '"ok":true' && echo "[Telegram] OK" || echo "[Telegram] eșec: $(echo "$R" | head -c 150)"
else
  echo "[Telegram] variabile absente"
fi

if [ -n "${RESEND_API_KEY:-}" ]; then
  # Trimitem cu curl, nu urllib: Cloudflare blochează User-Agent Python-urllib
  # cu 403 / code 1010. curl este dovedit funcțional pe acest nod.
  BODY=$(python3 -c "
import json,sys
txt = open(sys.argv[1], encoding='utf-8', errors='replace').read()[:60000]
print(json.dumps({
    'from': sys.argv[2],
    'to': [sys.argv[3]],
    'subject': 'RONOR Audit automat - ' + sys.argv[4],
    'text': txt,
}))
" "$OUT" "${RONOR_MAIL_FROM:-ronor@ma11ai.com}" "${RONOR_MAIL_TO:-constantine@ma11ai.com}" "$TIP")

  RESP=$(curl -s -m 45 -X POST https://api.resend.com/emails \
    -H "Authorization: Bearer ${RESEND_API_KEY}" \
    -H "Content-Type: application/json" \
    -H "User-Agent: RONOR-Control/1.0" \
    -d "$BODY" 2>&1)

  if echo "$RESP" | grep -q '"id"'; then
    echo "[E-mail] OK: $(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" 2>/dev/null)"
  else
    echo "[E-mail] eșec: $(echo "$RESP" | head -c 200)"
  fi
fi

ls -1t /opt/ronor/reports/audit_*.txt 2>/dev/null | tail -n +61 | xargs -r rm -f
