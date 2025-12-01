# Phase 3 – StreamingLLM Sidecar Embedding

This phase turns the FastAPI backend into a documented, runnable sidecar process with clear deployment artifacts. Specs S26–S30 codify the contract so future consumers can rely on consistent tooling.

## Specifications

### S26 – Sidecar Run Script
1. A shell entrypoint `scripts/run-sidecar.sh` MUST exist.
2. The script exports env vars from `.env.sidecar` when present, validates Python availability, installs backend dependencies (`pip install -r backend/requirements.txt`) if `STREAMING_LLM_BOOTSTRAP_DEPS=1`, and launches `uvicorn backend.server:app --host 0.0.0.0 --port ${STREAMING_LLM_PORT:-8000}`.
3. It must execute from anywhere inside the repository by resolving its own directory.

*Tests*: `backend/tests/test_sidecar_script.py::test_run_sidecar_exists` asserts script presence + shebang + uvicorn invocation string.

### S27 – Docker Compose Snippet
1. `docker/workflow-runner/streaming-llm.compose.yml` MUST define a `streaming-llm` service mapping:
   - Image `python:3.11-slim` (or better) with volume mounts for `./data` and agent directory.
   - Port `${STREAMING_LLM_PORT:-8000}` → container `8000`.
   - Env file `.env.sidecar` plus defaults for Ollama URL.
2. File includes comments describing how to include the service in `docker-compose` deployments.

*Tests*: same test ensures file exists and mentions `streaming-llm` service + env file.

### S28 – README Sidecar Section
1. `streaming-llm/README.md` gains a “Sidecar Deployment” section referencing the run script and compose snippet.
2. Section lists required env vars (reuse Phase 1 names) and describes how UI/CLI should point at the sidecar.

*Tests*: `test_sidecar_script.py` scans README for the section header + key strings (e.g., `run-sidecar.sh`).

### S29 – .env Template Enhancements
1. `.env.sidecar.example` must include comments for compose usage plus `STREAMING_LLM_HOST`, `STREAMING_LLM_PORT`, `STREAMING_LLM_LOG_DIR`, and `STREAMING_LLM_SUMMARY_DIR` variables.

### S30 – Documentation Sync in `todo.md`
1. Phase 3 checklist entries flipped to `[x]` once assets exist.

## TDD Workflow
1. Add Pytest coverage for S26–S28 + S29 (file existence/content); extend existing `.env.sidecar.example` tests if necessary.
2. Implement script, compose file, README updates, and template changes until tests pass.
3. Finish by running `python3 -m pytest src/modules/streaming-llm/backend/tests` and `npm run test:streaming-llm`.
