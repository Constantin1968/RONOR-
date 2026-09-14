#!/usr/bin/env bash
# Admit only the independently checked recovery commit. Preserve strict equality
# admission and a common evidence baseline. No model call, push or history rewrite.
set -Eeuo pipefail
[[ "${1:-}" == --approved-recovery ]] || exit 2
root=/srv/ronor/development-automation
head=4d5fd8832cf434355c1993e66b887c78aab1b0a8
old=6562d6e7b76cb15eba7b4a65b60ee246e148d2a3
umask 077
source_dir="$(sed -n 's/^RONOR_WIREFIX_SOURCE=//p' "$root/wirefix.env")"
snapshot() { docker exec -e GIT_OPTIONAL_LOCKS=0 -i ronor-development-controller node - < "$source_dir/scripts/capture-development-state.cjs"; }
before="$(snapshot)"
[[ "$(docker exec -e GIT_OPTIONAL_LOCKS=0 ronor-development-controller git -C /automation-worktrees/project rev-parse HEAD)" == "$head" ]]
[[ -z "$(docker exec -e GIT_OPTIONAL_LOCKS=0 ronor-development-controller git -C /automation-worktrees/project status --porcelain)" ]]
[[ "$(sed -n 's/^RONOR_AUTOMATION_EXPECTED_HEAD=//p' "$root/environment")" == "$old" ]]
[[ "$(sed -n 's/^RONOR_AUTOMATION_MAX_COST_USD=//p' "$root/environment")" == 100 ]]
ledger="$(sha256sum "$root/model-budget/ledger.db" | cut -d' ' -f1)"
others() {
  docker ps -a --filter label=com.docker.compose.project=ronor-development --format '{{.Names}} {{.ID}}' |
    sed -E '/^ronor-development-(controller |automation-evidence-runner-1 )/d' | sort
}
before_others="$(others)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/root/ronor-ops-backups/admit-head-$stamp"
evidence="$root/maintenance/admit-head-$stamp"
mkdir -p "$backup" "$evidence"
cp -p "$root/environment" "$backup/environment"
printf '%s\n' "$before" > "$evidence/before.json"
sed -i "s/^RONOR_AUTOMATION_EXPECTED_HEAD=$old$/RONOR_AUTOMATION_EXPECTED_HEAD=$head/" "$root/environment"
compose=(docker compose --project-name ronor-development)
for name in environment verification-fix.env controller-fix.env accounting-fix.env budget.env recovery-fix.env wirefix.env; do
  compose+=(--env-file "$root/$name")
done
files="$(docker inspect ronor-development-controller --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}')"
IFS=, read -ra config_files <<< "$files"
[[ "${#config_files[@]}" == 7 ]]
for file in "${config_files[@]}"; do
  [[ "$file" == "$root/"* && -f "$file" ]]
  compose+=(-f "$file")
done
"${compose[@]}" config --quiet
"${compose[@]}" up -d --no-deps --no-build --wait controller automation-evidence-runner
[[ "$(snapshot)" == "$before" ]]
[[ "$(others)" == "$before_others" ]]
[[ "$(sha256sum "$root/model-budget/ledger.db" | cut -d' ' -f1)" == "$ledger" ]]
snapshot > "$evidence/after.json"
printf 'new_ceiling_usd=100\nold_expected_head=%s\nnew_expected_head=%s\nledger_sha256_unchanged=%s\n' "$old" "$head" "$ledger" > "$evidence/change.txt"
echo "recovered_head_admitted; common_evidence_baseline; state_unchanged; six_other_containers_unchanged; evidence=$evidence"
