#!/usr/bin/env bash
# Raises ONLY the explicit runtime bound of the controller, from 15 to 45
# minutes, for one supervised probe. Recreates exactly one container, the
# controller, on the image already installed. Builds nothing, changes no code,
# does not start a model, does not create or resume a run, does not touch any
# budget, ledger, mandate or secret, does not change the cost ceiling, and does
# not modify the admitted worker baseline.
set -Eeuo pipefail
[[ "${1:-}" == --approved-runtime-window ]] || { echo 'Explicit approval required' >&2; exit 2; }
minutes="${2:?approved runtime bound in minutes}"
[[ "$minutes" == 45 && "$(id -u)" == 0 ]] || exit 2
root=/srv/ronor/development-automation
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$source_dir" == "$root/releases/"* ]] || exit 2
[[ -f "$root/artifact.env" && -f "$root/evidence-home.env" ]] || { echo prior_stages_required >&2; exit 2; }
[[ ! -e "$root/runtime-window.env" ]] || { echo runtime_window_overlay_already_present >&2; exit 2; }
phase=preflight
trap 'echo "runtime_window_install_failed_phase=$phase; stopped_without_retry_or_rollback" >&2' ERR
umask 077

containers() {
  docker ps -a --filter label=com.docker.compose.project=ronor-development \
    --format '{{.Names}} {{.Image}}' | sort
}
ledger() { sha256sum "$root/model-budget/ledger.db" | cut -d' ' -f1; }
peers() { printf '%s\n' "$1" | sed -e '/^ronor-development-controller /d'; }

before_containers="$(containers)"
before_ledger="$(ledger)"
before_image="$(docker inspect ronor-development-controller --format '{{.Config.Image}}')"
[[ "$(printf '%s\n' "$before_containers" | wc -l)" == 8 ]]
[[ -z "$(docker exec -e GIT_OPTIONAL_LOCKS=0 ronor-development-controller git -C /automation-worktrees/project status --porcelain)" ]]
[[ "$(docker exec ronor-development-controller printenv RONOR_AUTOMATION_MAX_RUNTIME_MINUTES)" == 15 ]]
[[ "$(docker exec ronor-development-controller printenv RONOR_AUTOMATION_MAX_COST_USD)" == 100 ]]
[[ "$(sed -n 's/^RONOR_AUTOMATION_MAX_COST_USD=//p' "$root/environment")" == 100 ]]

printf 'RONOR_AUTOMATION_MAX_RUNTIME_MINUTES=%s\n' "$minutes" > "$root/runtime-window.env.candidate"

compose=(docker compose --project-name ronor-development)
for name in environment verification-fix.env controller-fix.env accounting-fix.env \
            budget.env recovery-fix.env wirefix.env transport.env egress.env context.env \
            artifact.env evidence-home.env runtime-window.env.candidate; do
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
  "$root/releases/63e06acc83c3cb91b1a9bc9d13c0bc7f4de05e6f/docker-compose.development-context.yml"
  "$root/releases/c6fff9d799916d510cf529f091772a82ecc68299/docker-compose.development-artifact.yml"
  "$root/releases/c19edd85ddf80ae5a0c5747dc38838d826e5aa31/docker-compose.development-evidence-home.yml"
)
for file in "${overlays[@]}"; do
  [[ -f "$file" ]]
  compose+=(-f "$file")
done
compose+=(-f "$source_dir/docker-compose.development-runtime-window.yml")
"${compose[@]}" config --quiet

phase=recreate-controller-only
"${compose[@]}" up -d --no-deps --no-build --force-recreate --wait controller
phase=verify
[[ "$(ledger)" == "$before_ledger" ]]
[[ "$(peers "$(containers)")" == "$(peers "$before_containers")" ]]
[[ "$(printf '%s\n' "$(containers)" | wc -l)" == 8 ]]
[[ "$(docker inspect ronor-development-controller --format '{{.Config.Image}}')" == "$before_image" ]]
[[ "$(docker exec ronor-development-controller printenv RONOR_AUTOMATION_MAX_RUNTIME_MINUTES)" == "$minutes" ]]
[[ "$(docker exec ronor-development-controller printenv RONOR_AUTOMATION_MAX_COST_USD)" == 100 ]]
[[ -z "$(docker exec -e GIT_OPTIONAL_LOCKS=0 ronor-development-controller git -C /automation-worktrees/project status --porcelain)" ]]
phase=record
mv "$root/runtime-window.env.candidate" "$root/runtime-window.env"
printf '%s\n' "$before_containers" > "$source_dir/runtime-window-containers-before.txt"
containers > "$source_dir/runtime-window-containers-after.txt"
printf 'ledger_sha256=%s\ncontroller_image=%s\nprevious_bound_minutes=15\napproved_bound_minutes=%s\n' \
  "$before_ledger" "$before_image" "$minutes" > "$source_dir/runtime-window-record.txt"
echo "runtime_window_installed; controller_only; same_image; seven_other_containers_unchanged; cost_ceiling_unchanged; ledger_and_run_state_unchanged; no_model_started"
