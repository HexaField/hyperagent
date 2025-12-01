# Phase 2 – Orchestrator & Log Foundations

This phase introduces append-only event logs, summaries, and a task graph representation that live entirely inside `src/modules/streaming-llm`. As with prior phases, each behavior is codified as a spec with an accompanying automated test.

## Specifications

### S22 – Filesystem Scaffold
1. The repository MUST contain a `data/` subtree with the following paths checked in (empty but tracked via `.gitkeep`):
   - `data/logs/.gitkeep`
   - `data/summaries/.gitkeep`
   - `data/archive/.gitkeep`
   - `data/tasks.graph.json`
2. `tasks.graph.json` starts as a valid JSON document shaped like `{ "tasks": [] }`.

*Tests*: `backend/tests/test_fs_scaffold.py::test_data_scaffold_exists` asserts presence + initial shape.

### S23 – Event Log Writer & Query Helpers
1. Implement `log/query.py` with:
   - `append_event(event: dict) -> str` that assigns a UUID `id`, RFC3339 `timestamp`, writes as JSONL row under `data/logs/{conversation_id}.jsonl`, and returns the event id.
   - `tail(conversation_id: str, limit: int = 20) -> list[dict]` returning the newest `limit` events for that conversation (preserving chronological order).
   - `since(timestamp: str) -> list[dict]` streaming all events across conversations whose timestamp is >= given RFC3339 instant.
   - `by_type(event_types: list[str], visibility: str | None = None) -> list[dict]` filtering across all logs.
2. Writers must `os.makedirs` parent directories, use `fcntl.flock` (shared for reads, exclusive for writes), and ensure events persist immediately (fsync).

*Tests*: `backend/tests/test_log_query.py` covers append/tail/since/by_type, verifying locking-friendly behavior by writing to temp dirs.

### S24 – Summarization Snapshots
1. `log/summarize.py` exposes `rolling_summary(conversation_id: str, events: list[dict]) -> dict` that collapses older events into markdown bullets grouped by `type`.
2. `persist_summary(conversation_id: str, summary: dict)` writes markdown to `data/summaries/{conversation_id}.md` and returns the file path.
3. Each summary record must include `summary_ref` (sha256 of content) so callers can reference immutable snapshots.

*Tests*: `backend/tests/test_log_summarize.py` ensures bullet grouping, deterministic hashing, and file persistence.

### S25 – Task Graph Storage with Locking
1. `task_graph/store.py` manages `data/tasks.graph.json` with helpers:
   - `load_graph() -> dict`
   - `save_graph(graph: dict) -> None`
   - `create_task(task: dict) -> dict`
   - `update_task(task_id: str, **patch) -> dict`
   - `list_active(statuses: set[str] | None = None) -> list[dict]`
   Functions must enforce optimistic locking through `fcntl.flock` on the JSON file and ensure `updated_at` timestamps refresh on every mutation.
2. Task nodes follow schema `{ id, type, status, owner, inputs, outputs, created_at, updated_at, parent_id?, dependency_ids[] }`.

*Tests*: `backend/tests/test_task_graph.py` validates CRUD operations, timestamp updates, and locking semantics (simulated via sequential calls).

## TDD Workflow
1. Add the Pytest modules listed above (ensuring they fail before implementation where applicable).
2. Implement filesystem scaffolding + Python modules until all specs pass.
3. Run `pytest src/modules/streaming-llm/backend/tests` and `npm run test:streaming-llm` to maintain confidence.
