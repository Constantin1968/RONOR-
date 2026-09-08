#!/usr/bin/env bash
# Prepared, NOT executed. Requires explicit approval for the remote intervention.
# Installs only the transport image. Does not patch the worker, change its admitted
# baseline, start a model, or alter any budget/ledger/mandate.
set -Eeuo pipefail
[[ "${1:-}" == --approved-transport ]] || exit 2
revision="${2:?reviewed revision}"
[[ "$revision" =~ ^[a-f0-9]{40}$ && "$(id -u)" == 0 ]] || exit 2
root=/srv/ronor/development-automation
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$source_dir" == "$root/releases/$revision" ]] || exit 2
[[ ! -e "$root/transport.env" ]] || { echo transport_overlay_already_present >&2; exit 2; }
phase=preflight
trap 'echo "transport_install_failed_phase=$phase; stopped_without_retry_or_rollback" >&2' ERR
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
for name in environment verification-fix.env controller-fix.env accounting-fix.env budget.env recovery-fix.env wirefix.env; do
  [[ -f "$root/$name" ]]
  compose+=(--env-file "$root/$name")
done
files="$(docker inspect ronor-development-controller --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}')"
IFS=, read -ra config_files <<< "$files"
[[ "${#config_files[@]}" == 7 ]]
for file in "${config_files[@]}"; do
  [[ "$file" == "$root/"* && -f "$file" ]]
  compose+=(-f "$file")
done
export RONOR_TRANSPORT_SOURCE="$source_dir" RONOR_TRANSPORT_TAG="$revision"
compose+=(-f "$source_dir/docker-compose.development-transport.yml")
"${compose[@]}" config --quiet
phase=build-controller
"${compose[@]}" build controller
phase=recheck
[[ "$(snapshot)" == "$before" && "$(containers)" == "$before_containers" && "$(ledger)" == "$before_ledger" ]]
phase=replace-controller-only
"${compose[@]}" up -d --no-deps --no-build --wait controller
phase=verify
[[ "$(snapshot)" == "$before" && "$(ledger)" == "$before_ledger" ]]
[[ "$(containers | sed '/^ronor-development-controller /d')" == "$(printf '%s\n' "$before_containers" | sed '/^ronor-development-controller /d')" ]]
[[ "$(docker inspect ronor-development-controller --format '{{.Config.Image}}')" == "ronor-development-controller:$revision" ]]
[[ "$(docker exec ronor-development-controller printenv RONOR_AUTOMATION_MAX_COST_USD)" == 100 ]]
phase=record
printf 'RONOR_TRANSPORT_SOURCE=%s\nRONOR_TRANSPORT_TAG=%s\n' "$source_dir" "$revision" > "$root/transport.env"
printf '%s\n' "$before" > "$source_dir/transport-preserved-state.json"
printf '%s\n' "$before_containers" > "$source_dir/transport-containers-before.txt"
containers > "$source_dir/transport-containers-after.txt"
printf 'ledger_sha256=%s\n' "$before_ledger" > "$source_dir/transport-ledger-unchanged.txt"
echo 'transport_installed; controller_only; seven_other_containers_unchanged; ledger_and_run_state_unchanged; no_model_started'
