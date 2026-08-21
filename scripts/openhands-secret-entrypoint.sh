#!/bin/sh
set -eu

read_secret() {
  secret_name="$1"
  secret_path="$2"
  if [ ! -f "$secret_path" ] || [ ! -r "$secret_path" ]; then
    echo "OpenHands startup refused: required secret file ${secret_name} is unavailable" >&2
    exit 78
  fi
  secret_value="$(tr -d '\r\n' < "$secret_path")"
  if [ -z "$secret_value" ]; then
    echo "OpenHands startup refused: required secret ${secret_name} is empty" >&2
    exit 78
  fi
  printf '%s' "$secret_value"
}

export SESSION_API_KEY="$(read_secret session_api_key "${RONOR_OPENHANDS_SESSION_API_KEY_FILE:-/run/secrets/openhands_session_key}")"
export LLM_API_KEY="$(read_secret llm_api_key "${RONOR_OPENHANDS_LLM_API_KEY_FILE:-/run/secrets/openhands_llm_api_key}")"
export OH_SECRET_KEY="$(read_secret persistence_encryption_key "${RONOR_OPENHANDS_SECRET_KEY_FILE:-/run/secrets/openhands_secret_key}")"

exec tini -- openhands-agent-server "$@"
