# Streaming LLM Implementation TODO

This checklist mirrors `plan.md` and keeps every task scoped entirely within `src/modules/streaming-llm`.

## Phase 0 – Spec-Oriented Baseline
- [x] Catalogue existing backend + client capabilities in `specs/phase0.md`.
- [x] Define the default TDD loop (Pytest + Vitest) and document required commands in the spec/README.
- [x] Ensure no refactors happen before the baseline specs are enforced (communicated in plan + spec doc).

## Phase 1 – Inventory & Interface Design
- [ ] Snapshot FastAPI server routes and pydantic models into short docs under `backend/README.md`.
- [ ] Document TypeScript client surfaces (`listAgents`, `streamChat`, etc.) and example usage.
- [ ] Capture environment/config expectations in `.env.sidecar.example`.

## Phase 2 – Orchestrator & Log Foundations
- [ ] Scaffold `data/logs`, `data/summaries`, and `data/tasks.graph.json` folders/files.
- [ ] Implement `log/query.py`, `log/summarize.py`, and `task_graph` helpers with file locking.
- [ ] Add JSON schemas/tests covering event types and task nodes.

## Phase 3 – StreamingLLM Sidecar Embedding
- [ ] Add `scripts/run-sidecar.sh` (or equivalent) plus supervisor instructions.
- [ ] Provide Docker Compose / Procfile snippets documenting ports, volumes, env vars.
- [ ] Update module README with routing + client topology guidance.

## Phase 4 – Controller/Narrator Prompting & Gating
- [ ] Create `orchestrator/prompts/controller.md` and `.../narrator.md` templates.
- [ ] Implement controller runner that enforces `speak_now` gating + idle watchdog.
- [ ] Build summarization + token-budgeting utilities wired into prompt builders.

## Phase 5 – Agent Interface Refactor
- [ ] Introduce `agents/base.py` + `agents/runtime.py` for common hooks/heartbeat logic.
- [ ] Retrofit existing agents (coder/search/RAG) to new task contract and logging APIs.
- [ ] Add orchestrator enforcement preventing agents from emitting user-visible text directly.

## Phase 6 – Observability & UX Integration
- [ ] Extend chat UI to narrator-only stream plus optional activity rail (status feed).
- [ ] Ship CLI/dashboard tools for inspecting logs, tasks, and narrator decisions.
- [ ] Define narrator/system error playbooks and surface them in the UI + docs.

## Phase 7 – Rollout & Hardening
- [ ] Add dedicated test commands (Vitest + Pytest) and wire them into CI.
- [ ] Build load/retention/fault-injection harnesses and capture benchmark artifacts.
- [ ] Plan shadow launch + canary rollout, including security/privacy validation checklists.
