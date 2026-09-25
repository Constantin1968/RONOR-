#!/bin/bash
# Verifica, numai prin citire, ca fiecare serviciu din manifest ruleaza exact imaginea fixata.
# Iesire: 0 = toate corespund, 1 = abatere, 2 = serviciu din manifest care nu ruleaza.
set -u
M="$(dirname "$0")/manifest.tsv"; abatere=0; lipsa=0
while IFS=$'\t' read -r proj svc wd tag pin; do
  case "$proj" in \#*|'') continue;; esac
  c=$(docker ps -q --filter "label=com.docker.compose.project=$proj" --filter "label=com.docker.compose.service=$svc" | head -1)
  if [ -z "$c" ]; then echo "LIPSA    $proj/$svc nu ruleaza"; lipsa=1; continue; fi
  rulat=$(docker inspect -f '{{.Image}}' "$c"); dig=${pin#*@}
  if [ "$rulat" = "$dig" ] || docker image inspect -f '{{join .RepoDigests " "}}' "$rulat" 2>/dev/null | grep -q "$dig"; then
    echo "OK       $proj/$svc"
  else echo "ABATERE  $proj/$svc ruleaza $rulat, manifestul cere $pin"; abatere=1; fi
done < "$M"
[ $abatere = 1 ] && exit 1; [ $lipsa = 1 ] && exit 2; exit 0
