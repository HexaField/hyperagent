# StreamingLLM TypeScript Client

This package exposes lightweight helpers for interacting with the FastAPI sidecar documented in `backend/README.md`. All exports are ESM-first, but they also work in Node environments via an optional `socketFactory`.

## Exports

| Function | Description |
| --- | --- |
| `listAgents(apiBase?: string)` | Fetches `{ agents: Agent[] }` from the sidecar. Defaults to `http://localhost:8000`. |
| `getAgent(agentId, apiBase?)` | Returns a single `Agent`. Throws on `404`. |
| `updateAgent(agent, apiBase?)` | Performs `PUT /agents/{id}` with updated metadata and markdown context. |
| `deleteAgent(agentId, apiBase?)` | Issues `DELETE /agents/{id}`. Resolves when the backend acknowledges removal. |
| `streamChat(params)` | Opens `ws(s)://` connection to `/ws/chat` and streams `token`, `done`, and `error` events. Returns a handle with `sendMessage` + `stop`. |

## Quick Start

```ts
import { listAgents, streamChat } from '@hyperagent/streaming-llm-client'

const agents = await listAgents('http://localhost:8000')
const primary = agents.find((agent) => agent.id === 'planner')

const handle = await streamChat({
  backendUrl: 'ws://localhost:8000/ws/chat',
  agentId: primary!.id,
  onEvent(event) {
    if (event.type === 'token') {
      process.stdout.write(event.token)
    }
    if (event.type === 'done') {
      console.log('\nconversation complete', event.conversationId)
    }
  },
  // Vitest + Node need a WebSocket implementation
  socketFactory: (url) => new (require('ws'))(url)
})

handle.sendMessage({ message: 'Summarize the repo in one sentence.' })
```

### Using `socketFactory`
- Browsers automatically supply `window.WebSocket`, so you can omit `socketFactory`.
- In Node.js (tests, CLIs, SSR) pass a factory that returns a `WebSocket` compatible client—`ws` is what the repo uses internally.
- The SDK buffers messages while the socket connects and reuses `conversationId` across turns, so you can call `handle.sendMessage` multiple times before invoking `handle.stop()`.

## Error Handling
- REST helpers throw with the raw text body when the response code is not `2xx`.
- `streamChat` raises if the socket closes before `onopen` fires or when `sendMessage` is invoked after `stop()`.

## Testing
Run `npm run test:streaming-llm` from the package root to execute both the unit and integration suites (which spawn the FastAPI backend automatically when `STREAMING_LLM_TEST_BACKEND_URL` is not set).
