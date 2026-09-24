#!/usr/bin/env bash
# Installs only the corrected Codex failure diagnostics of the controller, on
# top of the installed planner-fix stage, into the isolated development stack.
# Replaces exactly one service image: the development controller. Does not
# start a model, does not create or resume a run, does not touch any budget,
# ledger, mandate or secret, and does not modify the admitted worker baseline.
# The Codex verifier service keeps its installed image, so the controller must
# remain compatible with the failure shape that verifier already emits.
set -Eeuo pipefail
[[ "${1:-}" == --approved-diagnostics ]] || { echo 'Explicit approval required' >&2; exit 2; }
revision="${2:?reviewed revision}"
[[ "$revision" =~ ^[a-f0-9]{40}$ && "$(id -u)" == 0 ]] || exit 2
root=/srv/ronor/development-automation
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$source_dir" == "$root/releases/$revision" ]] || exit 2
[[ -f "$root/artifact.env" && -f "$root/evidence-home.env" && -f "$root/planner-fix.env" ]] || { echo prior_stages_required >&2; exit 2; }
[[ ! -e "$root/runtime-window.env" ]] || { echo runtime_window_must_be_withdrawn_first >&2; exit 2; }
[[ ! -e "$root/diagnostics.env" ]] || { echo diagnostics_overlay_already_present >&2; exit 2; }
phase=preflight
trap 'echo "diagnostics_install_failed_phase=$phase; stopped_without_retry_or_rollback" >&2' ERR
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
peers() { printf '%s\n' "$1" | sed -e '/^ronor-development-controller /d'; }

before="$(snapshot)"
before_containers="$(containers)"
before_ledger="$(ledger)"
before_worker_head="$(docker exec -e GIT_OPTIONAL_LOCKS=0 ronor-development-controller git -C /automation-worktrees/project rev-parse HEAD)"
[[ "$(printf '%s\n' "$before_containers" | wc -l)" == 8 ]]
[[ -z "$(docker exec -e GIT_OPTIONAL_LOCKS=0 ronor-development-controller git -C /automation-worktrees/project status --porcelain)" ]]
[[ "$(docker exec ronor-development-controller printenv RONOR_AUTOMATION_MAX_RUNTIME_MINUTES)" == 15 ]]
[[ "$(docker exec ronor-development-controller printenv RONOR_AUTOMATION_MAX_COST_USD)" == 100 ]]
[[ "$(sed -n 's/^RONOR_AUTOMATION_MAX_COST_USD=//p' "$root/environment")" == 100 ]]
before_verifier="$(docker inspect ronor-development-codex-verifier-1 --format '{{.Config.Image}}')"
before_planner="$(docker inspect ronor-development-langgraph-1 --format '{{.Config.Image}}')"

compose=(docker compose --project-name ronor-development)
for name in environment verification-fix.env controller-fix.env accounting-fix.env \
            budget.env recovery-fix.env wirefix.env transport.env egress.env context.env \
            artifact.env evidence-home.env planner-fix.env; do
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
  "$root/releases/280b7e699b863fbc38b187b37e540f92e5258e8e/docker-compose.development-planner-fix.yml"
)
for file in "${overlays[@]}"; do
  [[ -f "$file" ]]
  compose+=(-f "$file")
done
export RONOR_DIAGNOSTICS_SOURCE="$source_dir" RONOR_DIAGNOSTICS_TAG="$revision"
compose+=(-f "$source_dir/docker-compose.development-diagnostics.yml")
"${compose[@]}" config --quiet

phase=build
"${compose[@]}" build controller
phase=recheck
[[ "$(snapshot)" == "$before" && "$(containers)" == "$before_containers" && "$(ledger)" == "$before_ledger" ]]
phase=replace-controller-only
"${compose[@]}" up -d --no-deps --no-build --wait controller
phase=verify
[[ "$(snapshot)" == "$before" && "$(ledger)" == "$before_ledger" ]]
[[ "$(peers "$(containers)")" == "$(peers "$before_containers")" ]]
[[ "$(printf '%s\n' "$(containers)" | wc -l)" == 8 ]]
[[ "$(docker inspect ronor-development-controller --format '{{.Config.Image}}')" == "ronor-development-controller:$revision" ]]
[[ "$(docker inspect ronor-development-codex-verifier-1 --format '{{.Config.Image}}')" == "$before_verifier" ]]
[[ "$(docker inspect ronor-development-langgraph-1 --format '{{.Config.Image}}')" == "$before_planner" ]]
[[ "$(docker exec ronor-development-controller printenv RONOR_AUTOMATION_MAX_RUNTIME_MINUTES)" == 15 ]]
[[ "$(docker exec ronor-development-controller printenv RONOR_AUTOMATION_MAX_COST_USD)" == 100 ]]
[[ "$(docker exec -e GIT_OPTIONAL_LOCKS=0 ronor-development-controller git -C /automation-worktrees/project rev-parse HEAD)" == "$before_worker_head" ]]
[[ -z "$(docker exec -e GIT_OPTIONAL_LOCKS=0 ronor-development-controller git -C /automation-worktrees/project status --porcelain)" ]]
# The installed controller must distinguish the failure classes instead of
# collapsing them, and must refuse a credential-shaped detail.
classes="$(docker exec ronor-development-controller node -e "
const d = require('/app/dist/runtime/automation/verification-diagnostics.js');
const of = c => d.verificationFailureCategory(c);
const read = v => d.readVerificationFailureDiagnostic(v);
const rejection = { category: 'rejection', code: 'codex_verdict_rejected', verdict: 'fail' };
const out = {
  rejected: of('codex_verdict_rejected'),
  missing_evidence: of('codex_evidence_missing'),
  service: of('codex_api_http_503'),
  gateway: of('adapter_http_502'),
  collapsed: of('codex_adapter_failed'),
  unknown_code: of('definitely_not_a_known_code'),
  newline_rejected: of('adapter_http_502\n'),
  kept: read({ ...rejection, summary: 'required evidence refused' }),
  secret_dropped: read({ ...rejection, summary: 'Authorization: Bearer abcdef123456' }),
  throwing_survived: read({ get code() { throw new Error('boom'); } }),
};
process.stdout.write(JSON.stringify(out));
")"
printf '%s' "$classes" | grep -q '"rejected":"rejection"'
printf '%s' "$classes" | grep -q '"missing_evidence":"rejection"'
printf '%s' "$classes" | grep -q '"service":"service"'
printf '%s' "$classes" | grep -q '"gateway":"http"'
printf '%s' "$classes" | grep -q '"collapsed":"unknown"'
printf '%s' "$classes" | grep -q '"unknown_code":null'
printf '%s' "$classes" | grep -q '"newline_rejected":null'
printf '%s' "$classes" | grep -q '"kept":{'
printf '%s' "$classes" | grep -q '"secret_dropped":null'
! printf '%s' "$classes" | grep -q 'abcdef123456'
printf '%s' "$classes" | grep -q '"throwing_survived":null'
phase=record
printf 'RONOR_DIAGNOSTICS_SOURCE=%s\nRONOR_DIAGNOSTICS_TAG=%s\n' "$source_dir" "$revision" > "$root/diagnostics.env"
printf '%s\n' "$before" > "$source_dir/diagnostics-preserved-state.json"
printf '%s\n' "$before_containers" > "$source_dir/diagnostics-containers-before.txt"
containers > "$source_dir/diagnostics-containers-after.txt"
printf 'ledger_sha256=%s\n' "$before_ledger" > "$source_dir/diagnostics-ledger-unchanged.txt"
printf '%s\n' "$classes" > "$source_dir/diagnostics-installed-classes.json"
echo 'diagnostics_installed; controller_only; seven_other_containers_unchanged; failure_classes_distinguished; credential_detail_refused; ledger_and_run_state_unchanged; no_model_started'
