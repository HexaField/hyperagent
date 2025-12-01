# Streaming LLM Module

Original Repo: https://github.com/mit-han-lab/streaming-llm

This module provides a small FastAPI backend plus a TypeScript client that together expose a streaming chat interface for multi-agent LLM workflows inside Hyperagent.

## What it does

- Manages agents (name, system prompt, markdown context) through REST endpoints.
- Streams chat completions over WebSockets so the UI can render tokens as soon as they are generated.
- Persists conversation turns and replays them when constructing the next prompt.
- Supports either a local Hugging Face transformer (with optional StreamingLLM KV cache) or an Ollama-hosted model based on configuration.

## TypeScript client usage

```ts
import { listAgents, streamChat, type ChatEvent } from 'streaming-llm-client'

const agents = await listAgents('http://localhost:8000')
const primary = agents[0]

const { sendMessage, stop } = await streamChat({
  backendUrl: 'ws://localhost:8000/ws/chat',
  agentId: primary.id,
  options: { temperature: 0.2, maxNewTokens: 400 },
  onEvent: (event: ChatEvent) => {
    if (event.type === 'token') process.stdout.write(event.token)
    if (event.type === 'error') console.error(event.message)
    if (event.type === 'done') console.log('\nassistant finished')
  }
})

// Send as many turns as you like over the same socket
await sendMessage({ message: 'Summarize the latest run.' })
await sendMessage({
  message: 'Now give me the key risks.',
  options: { temperature: 0.1 }
})

// When finished, close the stream
stop()
```

- `listAgents` and `getAgent` talk to the REST API; `updateAgent` lets you push new system prompts.
- `streamChat` is `async` and resolves once the WebSocket handshake succeeds, returning `{ sendMessage, stop }` so callers can reuse the same connection for each user turn (and get a rejection if the socket fails to open).
- Pass a `socketFactory` when running in Node environments that do not expose `WebSocket` globally.

### Managing agents via the TypeScript client

```ts
import { listAgents, getAgent, updateAgent, deleteAgent, type Agent } from 'streaming-llm-client'

// 1. Create or edit (the backend upserts on PUT)
const upserted: Agent = await updateAgent({
  id: 'reviewer',
  name: 'Reviewer',
  system_prompt: 'You are Reviewer, a precise PR reviewer.',
  markdown_context: '- Keep responses focused on regressions.\n'
})

// 2. Fetch the latest definition
const latest = await getAgent(upserted.id)

// 3. Remove when no longer needed
await deleteAgent(upserted.id)

// 4. Confirm removal (list returns an array, absence implies success)
const remaining = await listAgents()
```

- `updateAgent` doubles as both “create” and “edit” because the backend persists the payload to `{agents_dir}/{id}.md` every time you call it.
- `deleteAgent` issues `DELETE /agents/{id}` and removes both the cached definition and the Markdown file on disk.
- `listAgents` is an easy way to validate your changes or display available personas in a UI.

## Architecture at a glance

- **Backend (`backend/`)** – FastAPI application (`server.py`) that exposes health/agent routes and the `/ws/chat` WebSocket. It wires together the agent store, conversation manager, and model engine, and streams tokens back to each connected client.
- **Agent store (`agent_store.py`)** – Simple filesystem-backed registry that keeps agent metadata and normalizes read/write access for the HTTP layer.
- **Conversation manager (`conversation_manager.py`)** – Tracks conversation IDs, historical turns, and ensures user/assistant messages are appended in order before every generation.
- **Model engine (`model_engine.py`)** – Builds prompts from agent data + history and either calls a local Transformer with StreamingLLM optimizations or proxies to Ollama via HTTP streaming.
- **TypeScript client (`ts-client/`)** – Lightweight wrapper that offers `streamChat`, `listAgents`, `getAgent`, and `updateAgent` so the webapp (or any consumer) can talk to the backend without duplicating protocol details.

The Makefile at the module root orchestrates installing backend dependencies, building the TypeScript client, and running the backend + reference webapp together during development.

## Sidecar Deployment

- **Local script**: run `./scripts/run-sidecar.sh` (from anywhere inside this module) to load `.env.sidecar`, optionally bootstrap Python deps, and start `uvicorn backend.server:app`. Set `STREAMING_LLM_BOOTSTRAP_DEPS=0` if you want to skip the `pip install -r backend/requirements.txt` step.
- **Docker Compose**: `docker/workflow-runner/streaming-llm.compose.yml` defines a standalone `streaming-llm` service that mounts this folder, loads `.env.sidecar`, and exposes `${STREAMING_LLM_PORT:-8000}`. Include it via `docker compose -f docker/workflow-runner/streaming-llm.compose.yml up streaming-llm` or merge it into your existing stack.
- **Environment**: `.env.sidecar.example` lists every variable consumed by `backend/settings.py` along with deployment-specific overrides such as `STREAMING_LLM_HOST`, log/summary directories, and Ollama endpoints. Update it, copy to `.env.sidecar`, and both the script + compose service will pick it up automatically.
