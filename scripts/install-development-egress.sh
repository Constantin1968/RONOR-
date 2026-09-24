#!/usr/bin/env bash
# Installs only the corrected budget egress proxy image. Does not patch the
# worker, change its admitted baseline, start a model, or alter any budget,
# ledger, mandate or secret.
set -Eeuo pipefail
[[ "${1:-}" == --approved-egress ]] || exit 2
revision="${2:?reviewed revision}"
[[ "$revision" =~ ^[a-f0-9]{40}$ && "$(id -u)" == 0 ]] || exit 2
root=/srv/ronor/development-automation
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$source_dir" == "$root/releases/$revision" ]] || exit 2
[[ ! -e "$root/egress.env" ]] || { echo egress_overlay_already_present >&2; exit 2; }
[[ -f "$root/transport.env" ]] || { echo transport_overlay_missing >&2; exit 2; }
phase=preflight
trap 'echo "egress_install_failed_phase=$phase; stopped_without_retry_or_rollback" >&2' ERR
umask 077
containers() {
  docker ps -a --filter label=com.docker.compose.project=ronor-development \
    --format '{{.Names}} {{.ID}}' | sort
}
snapshot() {
  docker exec -e GIT_OPTIONAL_LOCKS=0 -i ronor-development-controller node - \
    < "$source_dir/scripts/capture-development-state.cjs"
}
ledger() { sha256sum "$root/model-budget/ledger.db" | cut -d' ' -f1; }
before="$(snapshot)"
before_containers="$(containers)"
before_ledger="$(ledger)"
[[ "$(printf '%s\n' "$before_containers" | wc -l)" == 8 ]]
[[ -z "$(docker exec -e GIT_OPTIONAL_LOCKS=0 ronor-development-controller git -C /automation-worktrees/project status --porcelain)" ]]
[[ "$(sed -n 's/^RONOR_AUTOMATION_MAX_COST_USD=//p' "$root/environment")" == 100 ]]
compose=(docker compose --project-name ronor-development)
for name in environment verification-fix.env controller-fix.env accounting-fix.env budget.env recovery-fix.env wirefix.env transport.env; do
  [[ -f "$root/$name" ]]
  compose+=(--env-file "$root/$name")
done
files="$(docker inspect ronor-development-controller --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}')"
IFS=, read -ra config_files <<< "$files"
[[ "${#config_files[@]}" == 8 ]]
for file in "${config_files[@]}"; do
  [[ ( "$file" == "$root/"* || "$file" == "$root/releases/"* ) && -f "$file" ]]
  compose+=(-f "$file")
done
export RONOR_EGRESS_SOURCE="$source_dir" RONOR_EGRESS_TAG="$revision"
compose+=(-f "$source_dir/docker-compose.development-egress.yml")
"${compose[@]}" config --quiet
phase=build-proxy
"${compose[@]}" build model-egress-proxy
phase=recheck
[[ "$(snapshot)" == "$before" && "$(containers)" == "$before_containers" && "$(ledger)" == "$before_ledger" ]]
phase=replace-proxy-only
"${compose[@]}" up -d --no-deps --no-build --wait model-egress-proxy
phase=verify
[[ "$(snapshot)" == "$before" && "$(ledger)" == "$before_ledger" ]]
[[ "$(containers | sed '/^ronor-development-model-egress-proxy-1 /d')" == "$(printf '%s\n' "$before_containers" | sed '/^ronor-development-model-egress-proxy-1 /d')" ]]
[[ "$(docker inspect ronor-development-model-egress-proxy-1 --format '{{.Config.Image}}')" == "ronor-egress-runtime:$revision" ]]
[[ "$(docker inspect ronor-development-controller --format '{{.Config.Image}}')" == "ronor-development-controller:$(sed -n 's/^RONOR_TRANSPORT_TAG=//p' "$root/transport.env")" ]]
phase=record
printf 'RONOR_EGRESS_SOURCE=%s\nRONOR_EGRESS_TAG=%s\n' "$source_dir" "$revision" > "$root/egress.env"
printf '%s\n' "$before" > "$source_dir/egress-preserved-state.json"
printf '%s\n' "$before_containers" > "$source_dir/egress-containers-before.txt"
containers > "$source_dir/egress-containers-after.txt"
printf 'ledger_sha256=%s\n' "$before_ledger" > "$source_dir/egress-ledger-unchanged.txt"
echo 'egress_installed; proxy_only; seven_other_containers_unchanged; ledger_and_run_state_unchanged; no_model_started'
