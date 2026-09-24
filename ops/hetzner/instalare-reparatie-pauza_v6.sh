#!/usr/bin/env bash
# RONOR — instalarea reparatiei confirmarii pauzei, versiunea a sasea (d3cb2e1): termenul Codex configurabil,
# dovezi de test compactate si verificatorul Codex construit din aceeasi versiune.
#
# Urmeaza mecanismul real de versiuni al gazdei: fiecare revizie admisa are
# releases/<sha>, iar existing-verification.env indica sursa, eticheta si capul.
# Suprapunerea existing-verification construieste din acea sursa exact trei
# servicii: controller, openhands-bridge (unde ruleaza fereastra de pauza) si
# automation-evidence-runner. Versiunea a sasea adauga o singura suprapunere noua,
# docker-compose.development-codex-release.yml, aplicata ultima, care construieste
# si codex-verifier din aceeasi sursa. In total patru servicii; nimic altceva.
# Atentie la instalatoarele urmatoare: ele trebuie sa indrepte si aceasta a doua cale.
#
# Se opreste la prima eroare. Face copii ale fisierelor de mediu. Revenire:
#   bash instalare-reparatie-pauza_v6.sh --revenire <STAMP>
# Revenirea readuce cele patru servicii pe 85730ec, iar codex-verifier pe imaginea
# veche ronor-budget-runtime:78984d9, care nu se sterge.
#
# Urmeaza pas cu pas instalatorul v3 din 22.09 (70f7eda): suprapunerea se copiaza
# neschimbata din versiunea precedenta, iar compose-args.txt se indreapta catre ea.
# Arborele tooling nu se muta (doar fetch); se aliniaza numai arborele admis.
set -euo pipefail

VECHI=85730ecbe7a234c47785fe921ee89ef082e1fde5
NOU=d3cb2e1a649714e5fd91d7f289e45c665c59d4de
# Arborele tooling nu a fost mutat de v4 si ramane pe aceasta revizie.
TOOLING_PIN=70f7eda216c7555d0e93b7742d8fe9e144d8ff0e
RAMURA=automation/development-controller
BAZA=/srv/ronor/development-automation
TOOLING=$BAZA/tooling
WORKTREE=$BAZA/worktree
REL=$BAZA/releases/$NOU
OLDREL=$BAZA/releases/$VECHI
SUP=docker-compose.development-existing-verification.yml
CSUP=docker-compose.development-codex-release.yml
ARGSF=$BAZA/compose-args.txt
EVE=$BAZA/existing-verification.env
ENVF=$BAZA/environment
G="git -c safe.directory=$TOOLING -c safe.directory=$WORKTREE"
SERVICII="controller openhands-bridge automation-evidence-runner codex-verifier"
CONTAINERE="ronor-development-controller ronor-development-openhands-bridge-1 ronor-development-automation-evidence-runner-1 ronor-development-codex-verifier-1"
compose() { cd "$TOOLING"; # shellcheck disable=SC2046
  docker compose -p ronor-development $(cat "$BAZA/compose-args.txt") --env-file "$EVE" "$@"; }
pas() { echo; echo "===== $* ====="; }

if [ "${1:-}" = "--revenire" ]; then
  S=${2:?stamp}
  cp -v "$ENVF.$S-inainte-de-d3cb2e1" "$ENVF"
  cp -v "$EVE.$S-inainte-de-d3cb2e1" "$EVE"
  cp -v "$ARGSF.$S-inainte-de-d3cb2e1" "$ARGSF"
  $G -C "$WORKTREE" reset -q --hard "$VECHI"
  # shellcheck disable=SC2086
  compose up -d --no-build --force-recreate --no-deps $SERVICII
  echo "REVENIRE INCHEIATA pe $VECHI"; exit 0
fi

STAMP=$(date -u +%Y%m%d-%H%M%S)

pas "0. Preconditii"
for D in "$WORKTREE" "$TOOLING"; do
  H=$($G -C "$D" rev-parse HEAD); A=$VECHI; [ "$D" = "$TOOLING" ] && A=$TOOLING_PIN
  [ "$H" = "$A" ] || { echo "OPRIT: $D este pe $H, nu pe $A."; exit 1; }
  [ -z "$($G -C "$D" status --porcelain)" ] || { echo "OPRIT: $D are modificari nesalvate."; exit 1; }
done
grep -qx "RONOR_EXISTING_VERIFY_TAG=$VECHI" "$EVE" || { echo "OPRIT: existing-verification.env nu indica $VECHI."; exit 1; }
if grep -q "$CSUP" "$ARGSF"; then echo "OPRIT: $CSUP apare deja in compose-args.txt."; exit 1; fi
# Nicio rulare de automatizare nu poate fi in curs: recrearea ar taia-o la mijloc.
ACTIV=$(python3 -c "
import sqlite3; c=sqlite3.connect('file:$BAZA/data/development.db?mode=ro',uri=True)
print(c.execute(\"select count(*) from runtime_automation_runs where status not in ('complete','completed','failed','cancelled','rejected')\").fetchone()[0])")
[ "$ACTIV" = 0 ] || { echo "OPRIT: $ACTIV rulari de automatizare nu sunt terminale."; exit 1; }
echo "nicio rulare de automatizare in curs"
[ ! -e "$REL" ] || { echo "OPRIT: $REL exista deja."; exit 1; }
echo "worktree curat pe $VECHI, tooling curat pe $TOOLING_PIN; legatura de versiune indica $VECHI"

pas "1. Aduc revizia in ambele depozite"
for D in "$TOOLING" "$WORKTREE"; do $G -C "$D" fetch -q origin "$RAMURA"; done
CAP=$($G -C "$TOOLING" rev-parse "origin/$RAMURA")
[ "$CAP" = "$NOU" ] || { echo "OPRIT: capul ramurii este $CAP, nu revizia aprobata $NOU."; exit 1; }
$G -C "$WORKTREE" cat-file -e "$NOU^{commit}"
echo "cap confirmat: $NOU"

pas "2. Directorul de versiune releases/$NOU"
install -d -m 755 "$REL"
$G -C "$TOOLING" archive "$NOU" | tar -x -C "$REL"
cp -v "$OLDREL/$SUP" "$REL/$SUP"
cmp "$OLDREL/$SUP" "$REL/$SUP" && echo "suprapunere identica cu cea precedenta"
test -f "$REL/Dockerfile.development-tools"
grep -q pauseConfirmWindowFromEnv "$REL/src/runtime/automation/services/openhands-bridge-server.ts"
test -f "$REL/tests/runtime/openhands-pause-window.test.ts"
grep -q verifier_code "$REL/src/runtime/automation/runner.ts"
test -f "$REL/$CSUP"
grep -q codexTimeoutFromEnv "$REL/src/runtime/automation/services/verification-authorities-server.ts"
grep -q codexControllerTimeoutFromEnv "$REL/src/runtime/automation/adapter-registry.ts"
grep -q compactMaterialsForModel "$REL/src/runtime/automation/services/codex-evaluator.ts"
if grep -q "failure detail: %s" "$REL/tests/runtime/automation-codex-diagnostics.test.ts"; then echo "OPRIT: titlul de test inca interpoleaza valoarea"; exit 1; fi
echo "sursa extrasa; reparatiile, testele si suprapunerea Codex prezente"

pas "3. Copii ale fisierelor de mediu (sufix $STAMP)"
cp -v "$ENVF" "$ENVF.$STAMP-inainte-de-d3cb2e1"
cp -v "$EVE" "$EVE.$STAMP-inainte-de-d3cb2e1"
cp -v "$ARGSF" "$ARGSF.$STAMP-inainte-de-d3cb2e1"

pas "4. Arborele admis pe revizia noua"
$G -C "$WORKTREE" checkout -q "$RAMURA"
$G -C "$WORKTREE" reset -q --hard "$NOU"

pas "5. Legatura de versiune"
python3 - "$ARGSF" "$OLDREL/$SUP" "$REL/$SUP" <<'PYA'
import sys
c,v,n=sys.argv[1:]
t=open(c).read()
if t.count(v)!=1: sys.exit(f"OPRIT: {v} apare de {t.count(v)} ori in compose-args.txt")
open(c,"w").write(t.replace(v,n)); print("compose-args: o singura referinta indreptata")
PYA
printf ' -f %s' "$REL/$CSUP" >> "$ARGSF"
echo "compose-args: suprapunerea Codex adaugata ultima"
sed -i "s|^RONOR_EXISTING_VERIFY_SOURCE=.*|RONOR_EXISTING_VERIFY_SOURCE=$REL|;s|^RONOR_EXISTING_VERIFY_TAG=.*|RONOR_EXISTING_VERIFY_TAG=$NOU|;s|^RONOR_EXISTING_VERIFY_HEAD=.*|RONOR_EXISTING_VERIFY_HEAD=$NOU|" "$EVE"
sed -i "s|^RONOR_AUTOMATION_EXPECTED_HEAD=.*|RONOR_AUTOMATION_EXPECTED_HEAD=$NOU|" "$ENVF"
grep -hE "^RONOR_(EXISTING_VERIFY_(SOURCE|TAG|HEAD)|AUTOMATION_EXPECTED_HEAD)=" "$EVE" "$ENVF"
N=$(compose config --format json | python3 -c "
import json,sys; d=json.load(sys.stdin)['services']
print(sum(1 for s in '$SERVICII'.split() if d[s]['build']['context']=='$REL' and d[s]['image'].endswith(':$NOU')))")
[ "$N" = 4 ] || { echo "OPRIT: configuratia nu leaga cele patru servicii de $NOU ($N/4)."; exit 1; }
compose config --format json | python3 -c "
import json,sys; c=json.load(sys.stdin)['services']['codex-verifier']
e=c.get('environment',{}); s=sorted(x['source'] for x in c.get('secrets',[]))
assert e.get('RONOR_MODEL_RATE_CARD')=='dashscope-intl-qwen3.8-max-20260902', 'rate card'
assert e.get('RONOR_CODEX_BASE_URL')=='http://model-egress-proxy:3004/v1', 'egress'
assert s==['codex_api_key','codex_receipt_private_key','codex_verifier_token'], 'secrets'
assert c.get('read_only') is True and c['command'][-1]=='codex', 'isolation'
print('codex-verifier: tarif, poarta de iesire, secrete si izolare neschimbate')"
echo "configuratie valida; cele patru servicii indica $NOU"

pas "6. Construiesc cele patru imagini"
# shellcheck disable=SC2086
compose build $SERVICII

pas "7. Recreez doar cele patru containere"
# shellcheck disable=SC2086
compose up -d --no-build --force-recreate --no-deps $SERVICII

pas "8. Verificare"
for i in $(seq 1 30); do
  NESANATOASE=0
  for C in $CONTAINERE; do
    S=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$C")
    [ "$S" = healthy ] || NESANATOASE=1
  done
  [ $NESANATOASE = 0 ] && break; sleep 5
done
for C in $CONTAINERE; do
  docker inspect -f '{{.Name}} {{.Config.Image}} {{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$C"
done
[ $NESANATOASE = 0 ] || { echo "ESEC: nu toate cele patru sunt sanatoase; revenire: --revenire $STAMP"; exit 1; }
for C in ronor-development-controller ronor-development-openhands-bridge-1; do
  N=$(docker exec "$C" sh -c 'grep -rl pauseConfirmWindowFromEnv /app/dist 2>/dev/null | wc -l')
  [ "${N:-0}" -gt 0 ] || { echo "ESEC: $C nu contine reparatia; revenire: --revenire $STAMP"; exit 1; }
  echo "  $C: reparatia prezenta in $N fisiere compilate"
done
N=$(docker exec ronor-development-controller sh -c 'grep -rl verifier_code /app/dist 2>/dev/null | wc -l')
[ "${N:-0}" -gt 0 ] || { echo "ESEC: controllerul nu contine verifier_code; revenire: --revenire $STAMP"; exit 1; }
echo "  controller: verifier_code prezent in $N fisiere compilate"
for C in ronor-development-controller ronor-development-codex-verifier-1; do
  N=$(docker exec "$C" sh -c 'grep -rl codexTimeoutFromEnv /app/dist 2>/dev/null | wc -l')
  [ "${N:-0}" -gt 0 ] || { echo "ESEC: $C nu contine termenul Codex nou; revenire: --revenire $STAMP"; exit 1; }
  echo "  $C: termenul Codex nou prezent in $N fisiere compilate"
done
N=$(docker exec ronor-development-codex-verifier-1 sh -c 'grep -rl compactMaterialsForModel /app/dist 2>/dev/null | wc -l')
[ "${N:-0}" -gt 0 ] || { echo "ESEC: verificatorul nu contine compactarea; revenire: --revenire $STAMP"; exit 1; }
echo "  codex-verifier: compactarea prezenta in $N fisiere compilate"
docker ps --filter name=ronor-development --format '  {{.Names}}  {{.Image}}  {{.Status}}'
echo; echo "INSTALARE INCHEIATA pe $NOU. Revenire: --revenire $STAMP"
