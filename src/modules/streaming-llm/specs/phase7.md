# Phase 7 – Narrator Conversation Loop

Phase 7 connects the workspace narrator UI to the Streaming LLM sidecar so that user-authored narrator messages trigger controller + narrator output instead of being stand-alone log entries.

## Specifications

### S40 – Narrator Relay Service
1. Introduce a lightweight relay inside `src/server/modules/workspaceNarrator` that forwards `POST /api/workspaces/:workspaceId/narrator/messages` payloads to the Streaming LLM backend.
   - The relay MUST call the sidecar WebSocket (`/ws/chat`) with the resolved controller agent id, passing the workspace conversation id and user message.
   - The relay MUST stream tokens until `done`, persist both the narrator output and interim controller actions back into the `${STREAMING_LLM_DATA_DIR}/logs/{conversationId}.jsonl` file, and surface the final narrator response id in the API response.
   - Connection errors (socket failure, agent missing, timeout) return `502` with actionable JSON `{ error, detail }` while still logging the attempted message for audit.

### S41 – Controller/Narrator Task Bridge
1. When a user message arrives, append a `USER_MESSAGE` event and enqueue a controller task inside `tasks.graph.json` so the orchestrator runtime can observe and react.
   - Controller tasks MUST include `{ workspace_id, conversation_id, source: 'workspace-narrator' }` metadata so existing inference code can find them.
   - Once the controller produces `NARRATION` or `NARRATION_SUPPRESSED`, the bridge MUST mark the task as completed and emit a `WORKSPACE_NARRATOR_COMPLETED` event with the resolved narrator id.
2. Provide an integration test under `streaming-llm/backend/tests` that fakes the controller runner and asserts that enqueued tasks end up writing narrator events the UI can read.

### S42 – UI Feedback & Status
1. Enhance `WorkspaceNarratorWidget` so the composer reflects the relay state: pending (while controller runs), succeeded (narrator reply visible), or failed (expose error string).
   - Polling cadence should briefly increase (e.g., 1s) after a send until a new narrator message arrives, then fall back to the normal interval.
   - When failures occur, surface a dismissible inline alert plus a link to download the raw log for troubleshooting.
2. Update Vitest suites to simulate a relay error and confirm the widget shows the failure banner and resumes polling afterwards.

## TDD Workflow
1. Add failing tests for the relay (server) and UI status handling (client) that encode the behaviours above.
2. Implement the narrator relay, task bridge, and widget updates until both `npm test -- workspaceNarrator` and `python3 -m pytest src/modules/streaming-llm/backend/tests` pass.
3. Manually verify by running the Streaming LLM sidecar, sending a narrator message from the UI, and observing the reply appear without manual log intervention.
