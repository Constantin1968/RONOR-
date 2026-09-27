#!/usr/bin/env bash
# Doctorul RXB-Hub. Orice etapă picată oprește acceptarea (cod de ieșire 1).
#   A: sintaxa modulelor   R: testele   B: registrul refuză fără cheie   C: evaluarea pe cazurile înghețate
set -u
cd "$(dirname "$0")/.."
fail=0
step(){ if eval "$2" >/tmp/rxb-doctor.$1.log 2>&1; then echo "PASS $1"; else echo "FAIL $1 (vezi /tmp/rxb-doctor.$1.log)"; fail=1; fi; }
step A "python -m compileall -q api.py tools orchestrator ledger eval"
step R "python -m pytest -q tests"
step B "env -u RXB_LEDGER_HMAC_KEY python -c 'from ledger.ledger import Ledger,LedgerKeyMissing
try: Ledger(\":memory:\").append(\"x\",\"d\",{},\"t\")
except LedgerKeyMissing: raise SystemExit(0)
raise SystemExit(1)'"
step C "python eval/run_eval.py"
exit $fail
