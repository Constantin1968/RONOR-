#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" == --approved ]] || { echo 'Explicit deployment approval required' >&2; exit 2; }
revision="${2:?full reviewed commit required}"
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || exit 2
[[ "$(id -u)" == 0 ]] || exit 2
root=/srv/ronor/development-automation
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$source_dir" == "$root/releases/$revision" ]] || exit 2
verification_revision=dac8833ce2b1be4667f20bb30c7ffd2d5c7181ec
verification_source="$root/releases/$verification_revision"
[[ -f "$root/environment" && -f "$root/verification-fix.env" ]] || exit 2
[[ ! -e "$root/controller-fix.env" ]] || { echo 'Existing controller manifest requires review' >&2; exit 2; }
[[ "$(sed -n 's/^RONOR_VERIFICATION_FIX_SOURCE=//p' "$root/verification-fix.env")" == "$verification_source" ]] || exit 2
[[ "$(sed -n 's/^RONOR_VERIFICATION_FIX_TAG=//p' "$root/verification-fix.env")" == "$verification_revision" ]] || exit 2
phase=preflight
trap 'echo "controller_fix_failed_phase=$phase; stopped_without_automatic_retry_or_rollback" >&2' ERR
umask 077
before="$(docker ps -a --filter label=com.docker.compose.project=ronor-development --format '{{.Names}} {{.ID}}' | sort)"
[[ "$(printf '%s\n' "$before" | wc -l)" == 8 ]]
[[ "$(docker inspect ronor-development-controller --format '{{.Config.Image}}')" == 'ronor-development-controller:6562d6e7b76c' ]]
docker exec -e GIT_OPTIONAL_LOCKS=0 -i ronor-development-controller node - before \
  < "$source_dir/scripts/check-development-controller-update.cjs"
export RONOR_CONTROLLER_FIX_SOURCE="$source_dir" RONOR_CONTROLLER_FIX_TAG="$revision"
compose=(docker compose --project-name ronor-development
  --env-file "$root/environment" --env-file "$root/verification-fix.env"
  -f "$root/tooling/docker-compose.development-isolated.yml"
  -f "$verification_source/docker-compose.development-verification-fix.yml"
  -f "$source_dir/docker-compose.development-controller-fix.yml")
"${compose[@]}" config --quiet
phase=build
"${compose[@]}" build controller
phase=recheck-before-replace
docker exec -e GIT_OPTIONAL_LOCKS=0 -i ronor-development-controller node - before \
  < "$source_dir/scripts/check-development-controller-update.cjs"
phase=replace-controller-only
"${compose[@]}" up -d --no-deps --no-build --wait controller
phase=verify
after="$(docker ps -a --filter label=com.docker.compose.project=ronor-development --format '{{.Names}} {{.ID}}' | sort)"
[[ "$(printf '%s\n' "$before" | sed '/^ronor-development-controller /d')" == \
   "$(printf '%s\n' "$after" | sed '/^ronor-development-controller /d')" ]]
[[ "$(docker inspect ronor-development-controller --format '{{.Config.Image}}')" == "ronor-development-controller:$revision" ]]
docker exec -e GIT_OPTIONAL_LOCKS=0 -i ronor-development-controller node - after \
  < "$source_dir/scripts/check-development-controller-update.cjs"
phase=record
printf 'RONOR_CONTROLLER_FIX_SOURCE=%s\nRONOR_CONTROLLER_FIX_TAG=%s\n' "$source_dir" "$revision" > "$root/controller-fix.env"
printf '%s\n' "$before" > "$source_dir/controller-containers-before.txt"
printf '%s\n' "$after" > "$source_dir/controller-containers-after.txt"
echo 'controller_fix_installed; same_job_preserved; no_model_or_job_started'
