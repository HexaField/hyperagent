# Phase 1 – Inventory & Interface Design

This phase documents the externally observable interfaces for the StreamingLLM sidecar so future phases can evolve behavior without reverse-engineering code. All deliverables remain inside `src/modules/streaming-llm`.

## Specifications

### S19 – Backend Surface Reference
The repository MUST expose an authoritative reference for the FastAPI server that:
1. Lives at `backend/README.md`.
2. Enumerates every REST route (`/healthz`, `/agents`, `/agents/{id}` CRUD) and `/ws/chat`, including verbs, request/response payloads, and error semantics.
3. Lists the Pydantic models used on each route and the key settings/environment variables required by `backend/settings.py`.

*Tests*: `documentation.test.ts::backend_readme_describes_routes` (Vitest) reads the README and asserts all endpoints/settings above are documented.

### S20 – TypeScript Client Reference
The TypeScript SDK MUST have a dedicated usage reference that:
1. Lives at `ts-client/README.md`.
2. Describes the exported helpers (`listAgents`, `getAgent`, `updateAgent`, `deleteAgent`, `streamChat`).
3. Provides a minimal example for streaming that mentions how to supply a custom `socketFactory` in Node environments.

*Tests*: `documentation.test.ts::client_readme_lists_helpers` inspects the README for function names and narrative text about `socketFactory` usage.

### S21 – Environment & Configuration Template
A sample environment file (`.env.sidecar.example`) MUST exist beside `plan.md` that:
1. Declares every env var consumed by `backend/settings.py` (model name, enable flag, port, agents dir, history sizes, max tokens, Ollama URL).
2. Documents default values and concise comments explaining each variable.

*Tests*: `documentation.test.ts::env_template_covers_settings` verifies the file exists and contains assignments for each required variable.

## TDD Workflow
1. Add failing Vitest coverage (`documentation.test.ts`) that enforces S19–S21.
2. Implement the documentation + env template until the tests pass.
3. Continue running `npm run test:streaming-llm` to guard the overall contract.
