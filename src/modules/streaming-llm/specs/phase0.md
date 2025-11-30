# Phase 0 – Spec-Oriented Baseline

This document captures the observable requirements of the existing Streaming LLM module so we can apply strict spec-first TDD before refactoring.

## Current Capabilities (Baseline)
- FastAPI backend exposes agent CRUD REST endpoints plus a `/ws/chat` WebSocket that streams tokens from an LLM.
- Agent configurations live as Markdown files on disk with YAML frontmatter managed by `AgentStore`.
- Conversation history is retained in-memory via `ConversationManager` with bounded turn history.
- StreamingLLM can proxy either to a local Hugging Face transformer or an Ollama-hosted model, depending on environment variables.
- TypeScript client offers ergonomic wrappers (`listAgents`, `getAgent`, `updateAgent`, `deleteAgent`, `streamChat`) that interact with the backend via HTTP/WebSocket, supporting browser and Node environments.

## Testing Tooling
- **Python**: `pytest` with coverage, tests live under `backend/tests/` (to be added).
- **TypeScript**: `vitest` in `ts-client/`.
- **WebSocket contract tests** run via `pytest` using `asyncio` clients plus mirrored Vitest integration tests that talk to a running FastAPI backend with a real LLM backend (Ollama or HF) whenever available. Tests may detect `STREAMING_LLM_TEST_SKIP_REAL=1` to avoid long runs locally, but CI should exercise the real integration path.

## Module Specifications

### backend/server.py
1. **S1 – Health endpoint**: `GET /healthz` returns `200` and `{ "status": "ok" }` even if no agents exist. *Tests*: `test_server_health_endpoint_returns_ok`.
2. **S2 – Agent listing**: `GET /agents` responds with every file-backed agent; empty directory yields `[]`. *Tests*: `test_list_agents_returns_all_agents`, `test_list_agents_handles_empty_store`.
3. **S3 – Agent CRUD validation**: `PUT /agents/{id}` trims ids/names, rejects blank ids, persists YAML frontmatter + markdown body. `DELETE /agents/{id}` removes both cache and file. *Tests*: `test_upsert_agent_trims_values`, `test_upsert_agent_persists_markdown`, `test_delete_agent_removes_file`.
4. **S4 – WebSocket handshake**: `/ws/chat` rejects malformed JSON, missing fields, or unknown agent ids with `{ "type": "error" }` then closes. *Tests*: `test_ws_rejects_missing_fields`, `test_ws_rejects_unknown_agent`.
5. **S5 – Streaming behavior**: successful chat streams `token` events in order, followed by `done`, and writes assistant message to `ConversationManager` unless cancelled. *Tests*: `test_ws_streams_tokens_and_done`, `test_ws_records_assistant_on_completion`, `test_ws_handles_client_disconnect`.

### backend/agent_store.py
1. **S6 – Default seeding**: initializing `AgentStore` seeds files for `planner` and `researcher` if absent. *Tests*: `test_agent_store_seeds_defaults_once`.
2. **S7 – Read/write parity**: agents saved to disk (YAML + markdown) and reloaded produce identical `Agent` objects. *Tests*: `test_agent_store_round_trip`.
3. **S8 – Delete semantics**: deleting removes in-memory cache entry and Markdown file (idempotent). *Tests*: `test_agent_store_delete_removes_file_and_cache`.

### backend/conversation_manager.py
1. **S9 – Conversation lifecycle**: `ensure(None)` creates UUID; calling `append`/`history` respects `max_turns` with eviction. *Tests*: `test_conversation_manager_creates_ids`, `test_conversation_history_truncates`.

### backend/model_engine.py
1. **S10 – Prompt composition**: `build_prompt` merges system prompt, context, history, and user message exactly once with blank trimming. *Tests*: `test_build_prompt_orders_sections`.
2. **S11 – Provider detection**: `StreamingLLMEngine` selects Ollama when `model_name_or_path` begins with `ollama:` or lacks `/` but contains `:`. *Tests*: `test_detect_provider_handles_ollama_prefix`, `test_detect_provider_handles_hf_models`.
3. **S12 – Ollama streaming**: `_stream_from_ollama` yields tokens as `response` chunks and raises on `error`. *Tests*: `test_stream_from_ollama_yields_tokens`, `test_stream_from_ollama_raises_on_error` (mock `httpx`).
4. **S13 – Local sampling**: when using HF models, `stream` raises if torch/model/tokenizer are uninitialized. *Tests*: `test_stream_raises_without_local_model`.

### ts-client/src/client.ts
1. **S14 – WebSocket lifecycle**: `streamChat` resolves only after socket opens; buffers messages while connecting, throws if closed early. *Tests*: `client.test.ts::streamChat_waits_for_open`.
2. **S15 – Event parsing**: `onEvent` receives normalized `token`, `done`, `error` events even if backend uses `conversation_id` or `conversationId`. *Tests*: `client.test.ts::streamChat_maps_events`.
3. **S16 – REST helpers**: `listAgents`, `getAgent`, `updateAgent`, `deleteAgent` propagate HTTP errors with textual messages. *Tests*: `client.test.ts::listAgents_handles_errors` etc.
4. **S17 – Real backend streaming**: `streamChat` can connect to a running backend (spawned locally for tests) and emit at least one `token` followed by `done` when the backend is configured to use a real LLM. *Tests*: `client.integration.test.ts::streamChat_streams_with_real_backend` (requires `STREAMING_LLM_TEST_BACKEND_URL` or auto-spawned server + Ollama/HF reachable model).
5. **S18 – Conversation reuse**: `streamChat` keeps the WebSocket open after a `done` event so callers can invoke `sendMessage` repeatedly; the client should automatically attach the latest `conversationId` unless one is manually overridden. *Tests*: `client.integration.test.ts::streamChat_supports_multi_turn`.

## TDD Workflow
1. For every spec above, create/extend tests (Phase 0 only touches files inside `streaming-llm`).
2. Run `pytest streaming-llm/backend/tests` and `npm run test:streaming-llm` (Vitest) repeatedly until all specs pass.
3. Only after the baseline is green do we proceed to Phase 1+ changes.
