#!/bin/bash
# Driver pentru raportarea cu proveninta (cens). Scriptul anterior,
# /opt/ronor/run_report.sh, ramane pe disc si nemodificat: revenirea la el
# e o singura linie in crontab.
set -a
. /opt/ronor/.report_env
# Cheia Qdrant nu e in .report_env; o luam din mediul serviciului declarativ.
if [ -z "${QDRANT_API_KEY:-}" ]; then
  QDRANT_API_KEY=$(docker inspect ronor-langgraph \
    -f '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | grep '^QDRANT_API_KEY=' | cut -d= -f2-)
fi
set +a
exec /usr/bin/python3 /opt/ronor/raportare/trimite.py "$@"
