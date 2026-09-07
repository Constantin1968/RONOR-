#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" == --approved ]] || { echo 'Explicit deployment approval required' >&2; exit 2; }
revision="${2:?reviewed full commit required}"
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || exit 2
[[ "$(id -u)" == 0 ]] || exit 2
root=/srv/ronor/development-automation
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$source_dir" == "$root/releases/$revision" ]] || exit 2
[[ -f "$root/environment" && -f "$root/tooling/docker-compose.development-isolated.yml" ]] || exit 2
[[ ! -e "$root/verification-fix.env" ]] || { echo 'Existing fix manifest requires review' >&2; exit 2; }
phase=preflight
trap 'echo "verification_fix_failed_phase=$phase" >&2' ERR
docker exec ronor-development-controller node -e '
  const DB=require("better-sqlite3");
  const db=new DB(process.env.AUDIT_DB_PATH,{readonly:true,fileMustExist:true});
  for(const table of ["runtime_automation_runs","runtime_development_jobs"]) {
    const exists=db.prepare("select 1 from sqlite_master where type=? and name=?").get("table",table);
    if(exists && db.prepare("select count(*) as n from "+table).get().n!==0) throw new Error("existing_jobs_require_review");
  }
  db.close();
'
[[ -z "$(docker exec ronor-development-openhands-agent-1 git -C /workspace/project status --porcelain)" ]]
base=(docker compose --project-name ronor-development --env-file "$root/environment" -f "$root/tooling/docker-compose.development-isolated.yml")
before="$(docker ps --filter label=com.docker.compose.project=ronor-development --format '{{.Names}} {{.ID}}' | sort)"
[[ "$(printf '%s\n' "$before" | wc -l)" == 8 ]]
export RONOR_VERIFICATION_FIX_SOURCE="$source_dir" RONOR_VERIFICATION_FIX_TAG="$revision"
compose=("${base[@]}" -f "$source_dir/docker-compose.development-verification-fix.yml")
"${compose[@]}" config --quiet
phase=build
"${compose[@]}" build codex-verifier automation-evidence-runner
phase=git-identity
docker exec ronor-development-openhands-agent-1 git -C /workspace/project config --local user.name 'RONOR Development Worker'
docker exec ronor-development-openhands-agent-1 git -C /workspace/project config --local user.email 'ronor-development@localhost'
phase=replace-two-services
"${compose[@]}" up -d --no-deps --no-build --wait codex-verifier automation-evidence-runner
phase=verify-isolation
after="$(docker ps --filter label=com.docker.compose.project=ronor-development --format '{{.Names}} {{.ID}}' | sort)"
unchanged_before="$(printf '%s\n' "$before" | sed '/ronor-development-codex-verifier-1 /d; /ronor-development-automation-evidence-runner-1 /d')"
unchanged_after="$(printf '%s\n' "$after" | sed '/ronor-development-codex-verifier-1 /d; /ronor-development-automation-evidence-runner-1 /d')"
[[ "$unchanged_before" == "$unchanged_after" ]]
[[ -z "$(docker exec ronor-development-openhands-agent-1 git -C /workspace/project status --porcelain)" ]]
phase=record
umask 077
printf 'RONOR_VERIFICATION_FIX_SOURCE=%s\nRONOR_VERIFICATION_FIX_TAG=%s\n' "$source_dir" "$revision" > "$root/verification-fix.env"
printf '%s\n' "$before" > "$source_dir/containers-before.txt"
printf '%s\n' "$after" > "$source_dir/containers-after.txt"
"${compose[@]}" ps --format json
echo 'verification_fix_installed; no model request or development job started'
