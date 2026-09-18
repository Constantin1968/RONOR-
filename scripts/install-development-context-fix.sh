#!/usr/bin/env bash
# Installs only the corrected context, pagination and receipt code, into the
# isolated development stack. Replaces exactly two service images: the
# controller and the OpenHands bridge. Does not start a model, does not
# create or resume a run, does not touch any budget, ledger, mandate or
# secret, and does not modify the admitted worker baseline.
set -Eeuo pipefail
[[ "${1:-}" == --approved-context ]] || { echo 'Explicit approval required' >&2; exit 2; }
revision="${2:?reviewed revision}"
[[ "$revision" =~ ^[a-f0-9]{40}$ && "$(id -u)" == 0 ]] || exit 2
root=/srv/ronor/development-automation
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$source_dir" == "$root/releases/$revision" ]] || exit 2
[[ ! -e "$root/context.env" ]] || { echo context_overlay_already_present >&2; exit 2; }
phase=preflight
trap 'echo "context_install_failed_phase=$phase; stopped_without_retry_or_rollback" >&2' ERR
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
peers() { printf '%s\n' "$1" | sed -e '/^ronor-development-controller /d' -e '/^ronor-development-openhands-bridge-1 /d'; }

before="$(snapshot)"
before_containers="$(containers)"
before_ledger="$(ledger)"
[[ "$(printf '%s\n' "$before_containers" | wc -l)" == 8 ]]
[[ -z "$(docker exec -e GIT_OPTIONAL_LOCKS=0 ronor-development-controller git -C /automation-worktrees/project status --porcelain)" ]]
[[ "$(sed -n 's/^RONOR_AUTOMATION_MAX_COST_USD=//p' "$root/environment")" == 100 ]]

compose=(docker compose --project-name ronor-development)
for name in environment verification-fix.env controller-fix.env accounting-fix.env \
            budget.env recovery-fix.env wirefix.env transport.env egress.env; do
  [[ -f "$root/$name" ]]
  compose+=(--env-file "$root/$name")
done
overlays=(
  "$root/tooling/docker-compose.development-isolated.yml"
  "$root/releases/dac8833ce2b1be4667f20bb30c7ffd2d5c7181ec/docker-compose.development-verification-fix.yml"
  "$root/releases/7b5c719191546ef8e7d834ab739189cb9de183fb/docker-compose.development-controller-fix.yml"
  "$root/releases/ac3e22c27fbf51cd1910e71974253779981e8098/docker-compose.development-accounting-fix.yml"
  "$root/releases/78984d9a2f0d79b5af85f8f664839bbdf8ed8a57/docker-compose.development-budget.yml"
  "$root/releases/28b0536faee7cf5ad58441c3fb8cabc66e973c72/docker-compose.development-recovery.yml"
  "$root/releases/568bf8de22407d72ad264d86352c611c46ab1398/docker-compose.development-wirefix.yml"
  "$root/releases/a52529fb021e38d8d7d9f65033b36a87862909a0/docker-compose.development-transport.yml"
  "$root/releases/735802e293d0d4aae214c15553d1d9fcff50c3fe/docker-compose.development-egress.yml"
)
for file in "${overlays[@]}"; do
  [[ -f "$file" ]]
  compose+=(-f "$file")
done
export RONOR_CONTEXT_SOURCE="$source_dir" RONOR_CONTEXT_TAG="$revision"
compose+=(-f "$source_dir/docker-compose.development-context.yml")
"${compose[@]}" config --quiet

phase=build
"${compose[@]}" build controller openhands-bridge
phase=recheck
[[ "$(snapshot)" == "$before" && "$(containers)" == "$before_containers" && "$(ledger)" == "$before_ledger" ]]
phase=replace-controller-and-bridge-only
"${compose[@]}" up -d --no-deps --no-build --wait controller openhands-bridge
phase=verify
[[ "$(snapshot)" == "$before" && "$(ledger)" == "$before_ledger" ]]
[[ "$(peers "$(containers)")" == "$(peers "$before_containers")" ]]
[[ "$(printf '%s\n' "$(containers)" | wc -l)" == 8 ]]
[[ "$(docker inspect ronor-development-controller --format '{{.Config.Image}}')" == "ronor-development-controller:$revision" ]]
[[ "$(docker inspect ronor-development-openhands-bridge-1 --format '{{.Config.Image}}')" == "ronor-context-runtime:$revision" ]]
[[ "$(docker exec ronor-development-controller printenv RONOR_AUTOMATION_MAX_COST_USD)" == 100 ]]
phase=record
printf 'RONOR_CONTEXT_SOURCE=%s\nRONOR_CONTEXT_TAG=%s\n' "$source_dir" "$revision" > "$root/context.env"
printf '%s\n' "$before" > "$source_dir/context-preserved-state.json"
printf '%s\n' "$before_containers" > "$source_dir/context-containers-before.txt"
containers > "$source_dir/context-containers-after.txt"
printf 'ledger_sha256=%s\n' "$before_ledger" > "$source_dir/context-ledger-unchanged.txt"
echo 'context_fix_installed; controller_and_bridge_only; six_other_containers_unchanged; ledger_and_run_state_unchanged; no_model_started'
