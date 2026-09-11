#!/usr/bin/env bash
# Installs only the corrected commit-assignment instruction of the planner, on
# top of the installed evidence-home stage, into the isolated development stack.
# Replaces exactly one service image: the LangGraph planner. Refuses to run
# while the one-probe runtime window is still in place, so the standing 15
# minute bound is restored first. Does not start a model, does not create or
# resume a run, does not touch any budget, ledger, mandate or secret, and does
# not modify the admitted worker baseline.
set -Eeuo pipefail
[[ "${1:-}" == --approved-planner-fix ]] || { echo 'Explicit approval required' >&2; exit 2; }
revision="${2:?reviewed revision}"
[[ "$revision" =~ ^[a-f0-9]{40}$ && "$(id -u)" == 0 ]] || exit 2
root=/srv/ronor/development-automation
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$source_dir" == "$root/releases/$revision" ]] || exit 2
[[ -f "$root/artifact.env" && -f "$root/evidence-home.env" ]] || { echo prior_stages_required >&2; exit 2; }
[[ ! -e "$root/runtime-window.env" ]] || { echo runtime_window_must_be_withdrawn_first >&2; exit 2; }
[[ ! -e "$root/planner-fix.env" ]] || { echo planner_fix_overlay_already_present >&2; exit 2; }
phase=preflight
trap 'echo "planner_fix_install_failed_phase=$phase; stopped_without_retry_or_rollback" >&2' ERR
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
peers() { printf '%s\n' "$1" | sed -e '/^ronor-development-langgraph-1 /d'; }

before="$(snapshot)"
before_containers="$(containers)"
before_ledger="$(ledger)"
[[ "$(printf '%s\n' "$before_containers" | wc -l)" == 8 ]]
[[ -z "$(docker exec -e GIT_OPTIONAL_LOCKS=0 ronor-development-controller git -C /automation-worktrees/project status --porcelain)" ]]
[[ "$(docker exec ronor-development-controller printenv RONOR_AUTOMATION_MAX_RUNTIME_MINUTES)" == 15 ]]
[[ "$(docker exec ronor-development-controller printenv RONOR_AUTOMATION_MAX_COST_USD)" == 100 ]]
[[ "$(sed -n 's/^RONOR_AUTOMATION_MAX_COST_USD=//p' "$root/environment")" == 100 ]]

compose=(docker compose --project-name ronor-development)
for name in environment verification-fix.env controller-fix.env accounting-fix.env \
            budget.env recovery-fix.env wirefix.env transport.env egress.env context.env \
            artifact.env evidence-home.env; do
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
export RONOR_PLANNER_FIX_SOURCE="$source_dir" RONOR_PLANNER_FIX_TAG="$revision"
compose+=(-f "$source_dir/docker-compose.development-planner-fix.yml")
"${compose[@]}" config --quiet

phase=build
"${compose[@]}" build langgraph
phase=recheck
[[ "$(snapshot)" == "$before" && "$(containers)" == "$before_containers" && "$(ledger)" == "$before_ledger" ]]
phase=replace-langgraph-only
"${compose[@]}" up -d --no-deps --no-build --wait langgraph
phase=verify
[[ "$(snapshot)" == "$before" && "$(ledger)" == "$before_ledger" ]]
[[ "$(peers "$(containers)")" == "$(peers "$before_containers")" ]]
[[ "$(printf '%s\n' "$(containers)" | wc -l)" == 8 ]]
[[ "$(docker inspect ronor-development-langgraph-1 --format '{{.Config.Image}}')" == "ronor-development-planner:$revision" ]]
[[ "$(docker exec ronor-development-controller printenv RONOR_AUTOMATION_MAX_RUNTIME_MINUTES)" == 15 ]]
[[ "$(docker exec ronor-development-controller printenv RONOR_AUTOMATION_MAX_COST_USD)" == 100 ]]
# The installed planner must serve the pinned instruction, not the bare sentence.
token="$(docker exec ronor-development-langgraph-1 sh -c 'cat /run/secrets/langgraph_token')"
plan="$(docker exec -e T="$token" ronor-development-langgraph-1 node -e "const http=require('http');const body=JSON.stringify({objective:'documentation probe'});const req=http.request({host:'127.0.0.1',port:2024,path:'/v1/plan',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),authorization:'Bearer '+process.env.T}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>process.stdout.write(d))});req.on('error',e=>{process.stderr.write(String(e));process.exit(1)});req.end(body)")"
printf '%s' "$plan" | grep -q 'Do not run the test suite'
printf '%s' "$plan" | grep -q 'already executed by the runtime'
! printf '%s' "$plan" | grep -q 'after all declared tests pass'
phase=record
printf 'RONOR_PLANNER_FIX_SOURCE=%s\nRONOR_PLANNER_FIX_TAG=%s\n' "$source_dir" "$revision" > "$root/planner-fix.env"
printf '%s\n' "$before" > "$source_dir/planner-fix-preserved-state.json"
printf '%s\n' "$before_containers" > "$source_dir/planner-fix-containers-before.txt"
containers > "$source_dir/planner-fix-containers-after.txt"
printf 'ledger_sha256=%s\n' "$before_ledger" > "$source_dir/planner-fix-ledger-unchanged.txt"
printf '%s\n' "$plan" > "$source_dir/planner-fix-served-plan.json"
echo 'planner_fix_installed; langgraph_only; seven_other_containers_unchanged; pinned_commit_instruction_served; ledger_and_run_state_unchanged; no_model_started'
