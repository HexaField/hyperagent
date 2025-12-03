# FastAPI Surface Reference

This document captures the Phase 1 inventory for the StreamingLLM sidecar backend. It mirrors the behavior codified in `specs/phase1.md#s19` so downstream clients never have to inspect code to learn the contract.

## Routes

| Verb | Path | Description | Request Body | Response |
| --- | --- | --- | --- | --- |
| GET | `/healthz` | Liveness/readiness probe. Always returns `200` when the app can accept traffic. | _None_ | `{ "status": "ok" }` |
| GET | `/agents` | Lists every agent discovered in `AgentStore`. | _None_ | `{ "agents": AgentPayload[] }` |
| GET | `/agents/{id}` | Fetch a single agent by identifier. | _None_ | `AgentPayload` (`404` if missing). |
| PUT | `/agents/{id}` | Create or update an agent. Trims blank ids/names and persists frontmatter + markdown body. | `AgentUpdateRequest` | `AgentPayload` |
| DELETE | `/agents/{id}` | Remove an agent from disk + cache. | _None_ | `204 No Content` (or `404`). |
| WS | `/ws/chat` | Streams chat tokens for the requested agent. | JSON frame `{ agent_id, user_message, conversation_id?, options? }` sent immediately after the socket opens. | WebSocket emits `{ type: "token" }`, `{ type: "done" }`, or `{ type: "error" }` messages. |

Plain-text summary: `GET /healthz`, `GET /agents`, `GET /agents/{id}`, `PUT /agents/{id}`, `DELETE /agents/{id}`, `WS /ws/chat`.

### WebSocket Event Semantics

- `token`: `{ "type": "token", "token": string, "conversation_id"?: string }` emitted for each generated token.
- `done`: `{ "type": "done", "conversation_id"?: string }` marks completion; socket stays open for additional turns until the client disconnects.
- `error`: `{ "type": "error", "message": string }` followed by socket close.

Clients should preserve the latest `conversation_id` returned in either `token` or `done` events and send it back in later `conversation_id` fields to continue the same thread.

## Pydantic Models

| Model                | Shape                                                                           |
| -------------------- | ------------------------------------------------------------------------------- |
| `AgentPayload`       | `{ id: string, name: string, system_prompt: string, markdown_context: string }` |
| `AgentUpdateRequest` | `{ name: string, system_prompt: string, markdown_context: string }`             |
| `AgentListResponse`  | `{ agents: AgentPayload[] }`                                                    |

## Settings & Environment Variables

These environment variables feed `backend/settings.py`:

| Variable | Default | Description |
| --- | --- | --- |
| `STREAMING_LLM_MODEL` | `llama3.2:latest` | Model name or local path provided to the engine. |
| `STREAMING_LLM_ENABLE` | `1` | Enables/disables the StreamingLLM optimizations. |
| `STREAMING_LLM_START_SIZE` | `4` | Number of tokens captured from the beginning of the conversation context. |
| `STREAMING_LLM_RECENT_SIZE` | `2048` | Token count retained from the recent conversation tail. |
| `STREAMING_LLM_AGENTS_DIR` | `.agents` | Filesystem directory that stores Markdown-backed agents. |
| `STREAMING_LLM_MAX_NEW_TOKENS` | `512` | Cap on tokens generated per request. |
| `STREAMING_LLM_OLLAMA_URL` | `http://127.0.0.1:11434` | Base URL for Ollama when proxying to a local model. |
| `STREAMING_LLM_PORT` | `8000` | (Operational) Port used when running `uvicorn backend.server:app`. |

## Development Notes

- Run `uvicorn backend.server:app --host 0.0.0.0 --port ${STREAMING_LLM_PORT}` to launch the sidecar.
- Agent fixtures live under `.agents-test/` for integration tests; the `AgentStore` seeds defaults when empty.
