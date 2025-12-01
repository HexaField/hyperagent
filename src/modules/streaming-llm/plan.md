# Streaming LLM Integration Plan

This system will remain completely isolated from the rest of the repository, only touching the `streaming-llm` folder and its contents.

> Implementation approach: every phase follows a strict spec-oriented TDD workflow—define requirements, codify them as executable specs/tests, then implement until all specs pass. No functionality ships without an accompanying specification and green tests.

## Phase 0 – Spec-Oriented Baseline

- [x] Capture current functionality requirements in `specs/phase0.md`, covering FastAPI backend routes, agent store, conversation manager, model engine, and the TypeScript client.
	- Each spec states observable behavior (inputs/outputs, side effects) and names the unit/integration tests that will enforce it.
- [x] Define the initial TDD loop for existing modules: write/extend tests under `backend/tests/` and `ts-client/tests/` mirroring the specs before refactoring anything.
	- Includes WebSocket contract tests, agent CRUD tests, and client SDK contract tests described in the spec document.
- [x] Establish tooling expectations: Pytest + Coverage for Python, Vitest for TypeScript, run via `npm run test:streaming-llm` and `pytest streaming-llm/backend/tests` prior to any code changes.

## Phase 1 – Inventory & Interface Design

- [x] Audit the FastAPI backend (`backend/`) and TypeScript client (`ts-client/`).
	- FastAPI exposes REST + WebSocket endpoints via `backend/server.py`, backed by `AgentStore`, `ConversationManager`, and `StreamingLLMEngine`. CORS is open (`*`), no auth yet. Config surfaces sit in `backend/settings.py` (env vars: `STREAMING_LLM_MODEL`, `..._ENABLE`, `..._START_SIZE`, `..._RECENT_SIZE`, `..._AGENTS_DIR`, `..._MAX_NEW_TOKENS`, `..._OLLAMA_URL`). Client SDK (`ts-client/src/client.ts`) mirrors the API surface with fetch helpers plus `streamChat` WebSocket orchestration.
- [x] Document required endpoints, payloads, and error semantics.
	- `GET /healthz` → `{ "status": "ok" }`.
	- `GET /agents` → `{ agents: Agent[] }`; `Agent` = `{ id, name, system_prompt, markdown_context }`.
	- `GET /agents/{id}` → `Agent`; 404 if missing.
	- `PUT /agents/{id}` with `{ name, system_prompt, markdown_context }` → `Agent`; trims ids, 400 on blank id.
	- `DELETE /agents/{id}` → 204, 404 if unknown.
	- `WS /ws/chat` expects initial JSON `{ agent_id, user_message, conversation_id?, options? }`; emits `token`, `done`, and `error` events (each include optional `conversation_id`). Errors surface as `{ type: "error", message }` and socket closes after completion/cancel.
- [x] Define internal module boundaries so everything stays inside `streaming-llm/`.
	- `backend/`: FastAPI app, agent store, conversation manager, model engine, settings.
	- `streaming_llm/`: Python package vendored from upstream (streaming optimizations, KV cache helpers).
	- `ts-client/`: Browser-friendly SDK bundling REST + WebSocket helpers; no references outside this directory.
	- `Makefile`, `README.md`, and future tooling will orchestrate builds/deps locally without importing from the broader repository.

## Phase 2 – Orchestrator & Log Foundations

- [x] Design the append-only event log schema and persistence model.
	- Event format: newline-delimited JSON rows stored under `streaming-llm/data/logs/{conversation_id}.jsonl`, each entry shaped as `{ id, timestamp, conversation_id, type, payload, meta }`.
	- Core event types: `USER_MESSAGE`, `NARRATION`, `AGENT_UPDATE`, `AGENT_RESULT`, `SYSTEM_NOTICE`, `TASK_CREATED`, `TASK_STATUS`, `ERROR`.
	- Metadata: `source` (orchestrator/agent id), `task_id`, `attention_score`, `visibility` (user, internal), plus optional `summary_ref` for older events.
	- Persistence: local filesystem first (ensures isolation), rotated nightly with optional compaction job that writes compressed archives to `streaming-llm/data/archive/`. Schema keeps storage-agnostic so a later phase can swap in SQLite without API changes.
- [x] Implement a task graph model spec owned by an in-folder orchestrator module.
	- Representation: `streaming-llm/data/tasks.graph.json` storing nodes `{ id, type, status, owner, inputs, outputs, created_at, updated_at, parent_id?, dependency_ids[] }` and edges derived from `parent/dependency` relationships.
	- Status lifecycle: `PENDING` → `DISPATCHED` → `IN_PROGRESS` → (`BLOCKED` | `FAILED` | `COMPLETED`). Each transition appended to the event log as `TASK_STATUS` with pointers back to the node.
	- Ownership: `owner` fields reference agent ids or `orchestrator` for synthetic tasks; `handoff_history` array captures reassignment metadata.
	- Access layer: `orchestrator/task_graph.py` (new in this folder) exposes CRUD helpers (`create_task`, `update_status`, `list_active`, `children_of(task_id)`) operating purely on the JSON file with optimistic locking (file-level `fcntl` lock) to maintain isolation without external DBs.
- [x] Provide querying and summarization utilities for downstream consumers.
	- `log/query.py`: exposes `tail(conversation_id, limit)`, `since(timestamp)`, `by_type(event_types, visibility)`, all reading JSONL files via streaming iterators to minimize memory.
	- `log/summarize.py`: maintains rolling summaries per conversation by compressing older events into markdown bullets saved under `data/summaries/{conversation_id}.md`; integrates with `summary_ref` metadata in log entries.
	- `task_graph/view.py`: helper that projects graph subsets (active tasks, dependency chains) and produces digest structs for controller/narrator prompt builders.
	- All utilities stay filesystem-bound (no extra services) and export pure functions so FastAPI routes and orchestrator workers can import them without creating circular dependencies.

## Phase 3 – StreamingLLM Sidecar Embedding

- [x] Finalize the FastAPI StreamingLLM service as a long-lived sidecar.
	- Process layout: `uvicorn backend.server:app --host 0.0.0.0 --port 8000` wrapped by a lightweight supervisor (e.g., `scripts/run-sidecar.sh`) living in this directory. Sidecar runs independently but ships with a `.env.sidecar` file detailing all required env vars so other repo parts can reference it without code coupling.
	- Lifecycle: started on workspace boot (docker-compose service `streaming-llm` or `npm run streaming-llm:dev`) and restarted automatically if it crashes; no attempt to embed directly into `src/server`.
	- Isolation: all dependencies installed via `pip install -r backend/requirements.txt` scoped to this module; shared assets (agents, logs, task graphs) live under `streaming-llm/data/` and are mounted into the container/process as volumes when needed.
- [x] Define the sidecar’s deployment contract.
	- Ports: default HTTP/WebSocket on `8000` (configurable via `STREAMING_LLM_PORT` env). Health served at `/healthz` for liveness + readiness probes.
	- Volumes: `./data/agents` (agent markdown), `./data/logs`, `./data/tasks.graph.json`, `./data/summaries`. Docker Compose snippet kept inside this folder mounts these paths read-write.
	- Env vars: documented in `README.md` + `.env.example` (`STREAMING_LLM_MODEL`, `STREAMING_LLM_ENABLE`, `STREAMING_LLM_START_SIZE`, `STREAMING_LLM_RECENT_SIZE`, `STREAMING_LLM_AGENTS_DIR`, `STREAMING_LLM_MAX_NEW_TOKENS`, `STREAMING_LLM_OLLAMA_URL`, `STREAMING_LLM_PORT`). Defaults favor local HF with streaming enabled.
	- Health policy: readiness waits for agent store preload + optional local model load; failure responses include JSON error for debugging.
- [x] Publish the `/agents/*`, `/healthz`, and `/ws/chat` routes via the sidecar surface only.
	- Reverse proxy guidance: document optional `docker/workflow-runner` nginx (or `traefik`) snippet that maps `/streaming-llm/*` → `http://streaming-llm:8000/*`. In local dev, the UI talks directly to `http://localhost:8000` or `ws://localhost:8000/ws/chat`.
	- Orchestrator integration: rather than new backend handlers, other services call the sidecar over HTTP/WebSocket, keeping this folder the single owner of these endpoints.
- [x] Ensure TypeScript client settings align with the sidecar topology.
	- `ts-client` docs now standardize on `backendUrl` pointing to the sidecar host (e.g., `ws://localhost:8000/ws/chat` or `/streaming-llm/ws/chat` behind a proxy) and highlight how to inject a Node-compatible `socketFactory`.
	- `.env.example` includes `STREAMING_LLM_BASE_URL` to help CLI tools resolve the sidecar without hardcoding URLs elsewhere in the repo.
	- README additions (to be implemented) will show local/dev/prod connection matrices so consumers inside this directory can configure themselves without touching the broader codebase.

## Phase 4 – Controller/Narrator Prompting & Gating

- [x] Create distinct prompt templates for controller vs. narrator modes.
	- Controller prompt pulls: latest `USER_MESSAGE`, recent `TASK_STATUS`, unresolved `AGENT_UPDATE`s, active task graph snapshot, and relevant summaries. Template structure:
		1. **System band** (persona + orchestration policy)
		2. **Global state digest** (task graph summary, pending blockers)
		3. **Event focus list** (top-N log snippets with metadata)
		4. **Instruction block** (produce JSON `{ "actions": [...], "speak_now": bool, "notes": string }`).
	- Narrator prompt trims to user-visible context: condensed event summaries, new agent results, pending acknowledgements, plus guidance to respond concisely if `speak_now` flips true.
	- Prompt templates live under `streaming-llm/orchestrator/prompts/` as `.md` or `.jinja` files so they can be iterated without code changes.
- [x] Implement explicit `speak_now` vs. `stay_silent` gating in orchestration logic.
	- Controller responses must always include `{"speak_now": true|false}` as part of the JSON action block. Orchestrator enforces schema validation and defaults to `false` on malformed output.
	- Gating criteria include: critical agent failures, user questions unanswered >30s, task completion milestones, or explicit user follow-ups. These are supplied to the controller via a `attention_hints` array.
	- When `speak_now=false`, narrator stays silent but logs `NARRATION_SUPPRESSED` events to aid debugging. When true, narrator prompt fires using the latest curated context slice.
	- Idle watchdog (async loop) re-invokes controller every 15s while tasks run to reevaluate gating without waiting for new user input.
- [x] Add summarization rules for long-running conversations.
	- Rolling window: retain last ~30 log events verbatim; older events collapsed via `log/summarize.py` into markdown bullet blocks keyed by topic/task. Summaries stored alongside checksums so they can be refreshed when new related events arrive.
	- Relevance filter: controller receives only events tagged with `attention_score >= 0.5` or explicitly referenced by current tasks; narrator gets the latest `NARRATION` + `AGENT_RESULT` summaries to avoid duplication.
	- Token budgeting: prompt builder enforces `max_tokens_per_section` (configurable) and truncates low-priority sections first (e.g., stale agent updates) before trimming user context.
	- When summaries change, a `SUMMARY_REFRESH` event is appended so future prompt reconstructions can reuse cached text instead of recomputing from the raw log each time.

## Phase 5 – Agent Interface Refactor

- [x] Define a standardized task contract for knowledge agents.
	- Task shape: `{ id, type, priority, status, owner, input, context, deadline, metadata }` where `input` contains structured fields (e.g., repo path, query) and `context` references log summary IDs.
	- Every agent must return `AGENT_RESULT` payloads as `{ task_id, outcome: "success"|"failed"|"partial", artifacts: [...], notes, next_actions? }`.
	- Lifecycle hooks: `on_assign` (acknowledge task, emit `AGENT_UPDATE`), `on_progress` (optional heartbeat), `on_complete` (emit result), `on_error` (emit failure + retry hint). Hooks implemented via base class in `agents/base.py` inside this directory.
- [x] Update agents to consume tasks from the orchestrator and emit log events.
	- Transport: lightweight gRPC-like protocol over stdin/stdout (for local tools) or HTTP polling/webhooks; initial implementation uses the event log + task graph files (agents tail `tasks.graph.json` for assignments matching their `type`).
	- Heartbeats: agents must send `AGENT_UPDATE` every 15s while `IN_PROGRESS`; orchestrator marks tasks `STALE` if heartbeat exceeds timeout and may reassign.
	- Retry policy: orchestrator tracks `attempt` count per task and uses exponential backoff before requeueing; agents include `retryable: bool` in error payloads to guide decisions.
	- Common client library (`agents/runtime.py`) handles file locks, heartbeat timers, and structured logging so each agent implementation stays minimal.
- [x] Guard against direct user-channel writes from agents.
	- Enforcement: orchestrator rejects any `AGENT_*` event containing `render_to_user=true`; only narrator events can surface to the UI, and they must reference a validated `speak_now` decision.
	- Audit trail: every narrator emission logs `NARRATION` + `NARRATION_SOURCE` metadata (e.g., which tasks contributed) so debugging remains easy.
	- UI contract: chat frontend renders only `NARRATION` events streamed through StreamingLLM, while optional status panes subscribe to filtered `AGENT_UPDATE`s labeled as system notifications.
	- Security: sandboxed agents run with minimal privileges and cannot access UI channels directly; they communicate strictly via filesystem/event log APIs defined in this folder.

## Phase 6 – Observability & UX Integration

- [x] Extend the chat UI/WebSocket client for narrator-first semantics.
	- Chat timeline renders only `NARRATION`/StreamingLLM outputs; user turns remain unchanged.
	- Add a collapsible “System Activity” rail fed by filtered `AGENT_UPDATE` events (through a new `/ws/status` or SSE bridge) so users can peek at backend progress without cluttering chat.
	- WebSocket handler in the UI subscribes to narrator stream plus status stream, keeping them isolated so token streaming stays smooth.
- [x] Build developer-facing introspection tools.
	- CLI utilities: `scripts/log-tail.ts` and `scripts/task-view.ts` (inside this module) to stream JSONL entries or visualize the task graph with filters.
	- Web dashboard: lightweight Vite app (or extension of existing UI) showing log timeline, task DAG, and narrator decisions; consumes the same query utilities from Phase 2.
	- Tracing hooks: environment flag `STREAMING_LLM_TRACE=1` enables verbose logging + spans written to `data/traces/{date}.jsonl`, capturing controller prompt inputs/outputs for audit.
- [x] Define error-handling narratives and fallbacks.
	- Narrator playbooks: standardized responses for (a) agent failure with retry scheduled, (b) task blocked awaiting user input, (c) orchestrator crash/restart. Each playbook references relevant task ids so users can correlate.
	- Timeout handling: if no narrator output after `speak_now=true` was triggered, orchestrator emits a lightweight `SYSTEM_NOTICE` to reassure users (“Still working, summarizing shortly…”).
	- Conflict resolution: when agents disagree, orchestrator calls controller with `attention_hints=["conflict"]`; narrator then summarizes discrepancies and outlines next steps before any final answer.
	- UI surfacing: chat shows concise status text, while the activity rail links to detailed logs for power users.
