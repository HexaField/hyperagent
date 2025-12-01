# Phase 6 – Observability & UX Integration

Phase 6 introduces a narrator-focused activity rail so users can inspect Streaming LLM conversations without exposing raw agent output. The work spans the backend (Express router) and the workspace widget layer.

## Specifications

### S37 – Workspace Narrator API
1. A new Express router exported from `src/server/modules/workspaceNarrator/routes.ts` MUST mount under `/api/workspaces/:workspaceId/narrator`.
2. `GET /api/workspaces/:workspaceId/narrator/feed?limit=50&conversationId=conv-123` returns a JSON payload matching `WorkspaceNarratorFeedResponse` (defined under `src/interfaces/widgets/workspaceNarrator.ts`).
   - The router resolves the `conversationId` parameter by first honoring the explicit query string, then scanning `streaming-llm/data/tasks.graph.json` for a task whose `metadata.workspace_id` matches the `workspaceId` (falling back to `metadata.conversation_id` or `workspaceId`).
   - Events are read from `${STREAMING_LLM_DATA_DIR}/logs/{conversationId}.jsonl`, filtered to the narrator-oriented types (`NARRATION`, `NARRATION_SUPPRESSED`, `AGENT_UPDATE`, `AGENT_RESULT`, `SUMMARY_REFRESH`, `ERROR`).
   - The endpoint MUST return events sorted newest-first, capped at `limit` (default 50, max 200) with normalized fields `{ id, timestamp, type, headline, detail, severity, source }` plus optional `summaryRef` when the latest `SUMMARY_REFRESH` references an existing markdown file.
3. `GET /api/workspaces/:workspaceId/narrator/raw` streams the raw JSONL file for the resolved conversation with `Content-Type: application/jsonl` so CLI users can download the feed.

*Tests*: `src/server/modules/workspaceNarrator/routes.test.ts` covers conversation resolution, event normalization, and raw download behavior (including the empty-file case).

### S38 – Narrator Activity Widget
1. A new widget template id `workspace-narrator` MUST be added to `widgetTemplates.ts`, `widgets/registry.tsx`, and interfaces/files mirroring the existing widgets.
2. The widget component (`src/client/src/widgets/workspaceNarrator/index.tsx`) fetches the narrator feed for the active workspace, polls every ~5 seconds, and renders:
   - A filter header reusing the Coding Agent widget’s workspace filter logic (extracted into a shared `WorkspaceFilterInput` component so both widgets deduplicate state management).
   - A timeline that reuses the existing `MessageScroller` presentation to avoid duplicated markup/styling.
   - Inline controls for refreshing and downloading raw logs (calling the `raw` endpoint).
3. Feed entries render narrator text, suppressed notices, or agent updates with clear icons/severity colors while never exposing `render_to_user` content from agents.

*Tests*: `src/client/src/widgets/workspaceNarrator/workspaceNarrator.test.tsx` snapshots the widget timeline transformation logic and ensures the shared filter component is reused.

### S39 – Narrator Playbooks & Status Badges
1. Define a `PLAYBOOKS` map under `workspaceNarrator/playbooks.ts` that describes remediation guidance for `NARRATION_SUPPRESSED`, `ERROR`, and `AGENT_RESULT` failure payloads.
2. The server feed MUST annotate each event with `playbookId` when applicable so the UI can render contextual guidance.
3. The widget renders a status rail summarizing counts of narrator outputs, suppressions, and failures, alongside the 2–3 line playbook message for the currently selected event.

*Tests*: `workspaceNarrator.test.tsx` asserts that playbook metadata is surfaced in the rendered output, and `routes.test.ts` verifies the server sets `playbookId` for suppression and error events.

## TDD Workflow
1. Add the Vitest suites described above so Phase 6 fails until the router + widget exist.
2. Build the workspace narrator router, shared filter component, widget, and playbook helpers.
3. Re-run `python3 -m pytest src/modules/streaming-llm/backend/tests` (regression check) and `npm test -- workspaceNarrator` (or the closest scoped Vitest command) until green.
