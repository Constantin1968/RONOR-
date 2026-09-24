#!/usr/bin/env bash
# Installs only the corrected evidence-runner test environment, on top of the
# installed artifact stage, into the isolated development stack. Replaces
# exactly one service image: the evidence runner. Does
# not start a model, does not create or resume a run, does not touch any
# budget, ledger, mandate or secret, and does not modify the admitted worker
# baseline.
set -Eeuo pipefail
[[ "${1:-}" == --approved-evidence-home ]] || { echo 'Explicit approval required' >&2; exit 2; }
revision="${2:?reviewed revision}"
[[ "$revision" =~ ^[a-f0-9]{40}$ && "$(id -u)" == 0 ]] || exit 2
root=/srv/ronor/development-automation
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$source_dir" == "$root/releases/$revision" ]] || exit 2
[[ -f "$root/artifact.env" ]] || { echo artifact_stage_required >&2; exit 2; }
[[ ! -e "$root/evidence-home.env" ]] || { echo evidence_home_overlay_already_present >&2; exit 2; }
phase=preflight
trap 'echo "evidence_home_install_failed_phase=$phase; stopped_without_retry_or_rollback" >&2' ERR
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
peers() { printf '%s\n' "$1" | sed -e '/^ronor-development-automation-evidence-runner-1 /d'; }

before="$(snapshot)"
before_containers="$(containers)"
before_ledger="$(ledger)"
[[ "$(printf '%s\n' "$before_containers" | wc -l)" == 8 ]]
[[ -z "$(docker exec -e GIT_OPTIONAL_LOCKS=0 ronor-development-controller git -C /automation-worktrees/project status --porcelain)" ]]
[[ "$(sed -n 's/^RONOR_AUTOMATION_MAX_COST_USD=//p' "$root/environment")" == 100 ]]

compose=(docker compose --project-name ronor-development)
for name in environment verification-fix.env controller-fix.env accounting-fix.env \
            budget.env recovery-fix.env wirefix.env transport.env egress.env context.env artifact.env; do
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
)
for file in "${overlays[@]}"; do
  [[ -f "$file" ]]
  compose+=(-f "$file")
done
export RONOR_EVIDENCE_HOME_SOURCE="$source_dir" RONOR_EVIDENCE_HOME_TAG="$revision"
compose+=(-f "$source_dir/docker-compose.development-evidence-home.yml")
"${compose[@]}" config --quiet

phase=build
"${compose[@]}" build automation-evidence-runner
phase=recheck
[[ "$(snapshot)" == "$before" && "$(containers)" == "$before_containers" && "$(ledger)" == "$before_ledger" ]]
phase=replace-evidence-runner-only
"${compose[@]}" up -d --no-deps --no-build --wait automation-evidence-runner
phase=verify
[[ "$(snapshot)" == "$before" && "$(ledger)" == "$before_ledger" ]]
[[ "$(peers "$(containers)")" == "$(peers "$before_containers")" ]]
[[ "$(printf '%s\n' "$(containers)" | wc -l)" == 8 ]]
[[ "$(docker inspect ronor-development-automation-evidence-runner-1 --format '{{.Config.Image}}')" == "ronor-development-evidence:$revision" ]]
[[ "$(docker exec ronor-development-controller printenv RONOR_AUTOMATION_MAX_COST_USD)" == 100 ]]
phase=record
printf 'RONOR_EVIDENCE_HOME_SOURCE=%s\nRONOR_EVIDENCE_HOME_TAG=%s\n' "$source_dir" "$revision" > "$root/evidence-home.env"
printf '%s\n' "$before" > "$source_dir/evidence-home-preserved-state.json"
printf '%s\n' "$before_containers" > "$source_dir/evidence-home-containers-before.txt"
containers > "$source_dir/evidence-home-containers-after.txt"
printf 'ledger_sha256=%s\n' "$before_ledger" > "$source_dir/evidence-home-ledger-unchanged.txt"
echo 'evidence_home_installed; evidence_runner_only; seven_other_containers_unchanged; ledger_and_run_state_unchanged; no_model_started'
