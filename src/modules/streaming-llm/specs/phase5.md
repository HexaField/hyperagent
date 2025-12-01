# Phase 5 – Agent Interface Refactor

Phase 5 standardises how knowledge agents consume tasks and emit log events so that the orchestrator can confidently reason about ownership and narration rules. All work continues to live in `src/modules/streaming-llm`.

## Specifications

### S34 – Agent Task Contract & Base Hooks
1. A new module `backend/agents/base.py` MUST define structured containers for agent work:
   - `AgentTask` encapsulates `{id, type, owner, status, priority, input, context, metadata}` pulled from the task graph.
   - `AgentResult` captures `{task_id, outcome, artifacts, notes, next_actions}`.
   - `AgentError` (or similar) carries `reason` plus `retryable` metadata.
2. `BaseAgent` subclasses declare `agent_type` and implement `handle_task(self, task, runtime) -> AgentResult`.
3. `BaseAgent.execute_once(runtime)` (or equivalent) MUST:
   - Claim the next pending task matching `agent_type` via the runtime.
   - Invoke lifecycle hooks `on_assign`, `on_progress` (optional heartbeat helper), `on_complete`, `on_error` that emit `AGENT_UPDATE` / `AGENT_RESULT` events through the runtime.
   - Bubble up `None` when no work is available so agents can idle gracefully.

*Tests*: `backend/tests/test_agents_runtime.py::test_base_agent_handles_lifecycle` validates the dataclasses and hook-driven event emission.

### S35 – Agent Runtime & Heartbeat Utilities
1. Module `backend/agents/runtime.py` MUST expose `AgentRuntime`, initialised with `agent_id`, `agent_type`, and optional heartbeat interval.
2. Runtime responsibilities:
   - `poll_next_task()` (or `claim_task`) reads `task_graph.store.list_active`, locks `tasks.graph.json`, and transitions the first matching `PENDING` task to `IN_PROGRESS` while stamping `owner=agent_id` and `attempt +=1`.
   - `emit_update(task_id, message, progress=None)` appends `AGENT_UPDATE` events to the log and refreshes `last_heartbeat_at`.
   - `complete_task(task_id, result)` writes an `AGENT_RESULT` event, updates the task to `COMPLETED`, and returns the persisted node.
   - `fail_task(task_id, error)` logs an `AGENT_RESULT` with `outcome="failed"` and marks the task `FAILED`.
   - `heartbeat_due(last_ts)` helper returns `True` when the interval has elapsed.
3. Runtime MUST coordinate all filesystem paths using `STREAMING_LLM_DATA_DIR` just like other modules so tests can point it at temp dirs.

*Tests*: `backend/tests/test_agents_runtime.py::test_agent_runtime_claims_and_updates_tasks` covers claiming, completion, and heartbeat bookkeeping.

### S36 – Output Guardrails (Narrator-Only UX)
1. Any `AGENT_UPDATE`/`AGENT_RESULT` emitted through the runtime MUST be forced to `visibility="internal"`.
2. If an agent payload contains `render_to_user=true` (or any truthy flag attempting to surface user text), the runtime MUST raise `ValueError` and refuse to append the event.
3. The runtime MUST append a `policy_error` field to the raised exception so callers can differentiate policy blocks vs. other errors; tests stub this via `pytest.raises`.
4. Enforcement ensures narrator is the sole component that can set `visibility="user"`, satisfying the Phase 4 gating contract.

*Tests*: `backend/tests/test_agents_runtime.py::test_runtime_rejects_user_visible_payloads` asserts the guardrail behaviour.

## TDD Workflow
1. Add `backend/tests/test_agents_runtime.py` with failing coverage for lifecycle hooks, runtime task mutation, and policy enforcement.
2. Implement `backend/agents/base.py` and `backend/agents/runtime.py`, plus any minor orchestrator/log glue needed to satisfy the specs.
3. Re-run `python3 -m pytest src/modules/streaming-llm/backend/tests` (focuses on this module) until all tests pass.
