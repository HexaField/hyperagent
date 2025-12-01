#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${MODULE_ROOT}/.env.sidecar"

if [[ -f "${ENV_FILE}" ]]; then
  echo "[sidecar] Loading env from ${ENV_FILE}"
  set -a
  source "${ENV_FILE}"
  set +a
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to run the StreamingLLM sidecar" >&2
  exit 1
fi

BOOTSTRAP="${STREAMING_LLM_BOOTSTRAP_DEPS:-1}"
if [[ "${BOOTSTRAP}" == "1" ]]; then
  echo "[sidecar] Ensuring backend requirements are installed"
  # Equivalent of `pip install -r backend/requirements.txt` but resolved relative to the module root.
  python3 -m pip install -r "${MODULE_ROOT}/backend/requirements.txt"
fi

HOST="${STREAMING_LLM_HOST:-0.0.0.0}"
PORT="${STREAMING_LLM_PORT:-8000}"

cd "${MODULE_ROOT}"

exec python3 -m uvicorn backend.server:app --host "${HOST}" --port "${PORT}" --workers "${STREAMING_LLM_WORKERS:-1}"
