#!/bin/bash
# Aplica: (3) politica de repornire unless-stopped pe stiva ronor-development,
# fara recreare de containere; (4) corectia F17 a copiei de siguranta.
# Revenire: bash aplica-restart-f17.sh --revenire <TS>
set -euo pipefail
B=/srv/ronor/development-automation
OV=$B/tooling/docker-compose.development-restart.yml
STG=/root/f17-staging
CT="ronor-development-controller ronor-development-openhands-bridge-1 ronor-development-codex-verifier-1 ronor-development-automation-evidence-runner-1 ronor-development-model-egress-proxy-1 ronor-development-langgraph-1 ronor-development-openhands-agent-1 ronor-development-victoria-assurance-1"
if [ "${1:-}" = "--revenire" ]; then
  R=$B/revenire-restart-f17-${2:?TS}
  [ -d "$R" ] || { echo "nu exista $R"; exit 2; }
  cp -a "$R/backup_hetzner.sh" /opt/ronor/backup_hetzner.sh
  cp -a "$R/compose-args.txt" $B/compose-args.txt
  while read -r n p; do docker update --restart "$p" "$n" >/dev/null; done < "$R/politici.txt"
  rm -f "$OV"
  sha256sum /opt/ronor/backup_hetzner.sh $B/compose-args.txt
  for n in $CT; do echo "$n $(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' $n)"; done
  echo revenire_facuta; exit 0
fi
TS=$(date -u +%Y%m%d-%H%M%S); R=$B/revenire-restart-f17-$TS; mkdir -p "$R"; chmod 700 "$R"
cp -a /opt/ronor/backup_hetzner.sh "$R/"; cp -a $B/compose-args.txt "$R/"
for n in $CT; do echo "$n $(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' $n)"; done > "$R/politici.txt"
echo "sha_backup_original $(sha256sum /opt/ronor/backup_hetzner.sh | cut -c1-64)"
cd $STG && sha256sum -c SHA256SUMS
# (4) F17
install -m 755 -o root -g root $STG/backup_hetzner.sh /opt/ronor/backup_hetzner.sh
bash -n /opt/ronor/backup_hetzner.sh
# (3) repornire: suprapunere persistenta pentru recrearile viitoare + aplicare imediata
install -m 644 $STG/docker-compose.development-restart.yml "$OV"
ARGS="$(cat $B/compose-args.txt) -f $OV"
docker compose -p ronor-development $ARGS config -q
grep -q -- "$OV" $B/compose-args.txt || printf ' -f %s' "$OV" >> $B/compose-args.txt
docker compose -p ronor-development $(cat $B/compose-args.txt) config --format json 2>/dev/null | python3 -c "import json,sys; s=json.load(sys.stdin)['services']; print('config_restart', {k:v.get('restart') for k,v in s.items()})"
for n in $CT; do docker update --restart unless-stopped "$n" >/dev/null; done
for n in $CT; do echo "$n $(docker inspect -f '{{.HostConfig.RestartPolicy.Name}} {{.State.Status}} {{.State.StartedAt}}' $n)"; done
echo "REVENIRE: bash $STG/aplica-restart-f17.sh --revenire $TS"
