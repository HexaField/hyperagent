# Phase 4 – Controller/Narrator Prompting & Gating

This phase introduces concrete prompt templates plus Python utilities that enforce the `speak_now` gating contract. All functionality lives inside `src/modules/streaming-llm` and builds on the event log + task graph work from Phase 2.

## Specifications

### S31 – Prompt Templates
1. Two markdown templates MUST exist in `orchestrator/prompts/`: `controller.md` and `narrator.md`.
2. Each template contains named sections for **System Instructions**, **Global State Digest**, **Event Focus**, and **Action Format**.
3. Templates expose placeholders (`{{SYSTEM_POLICY}}`, `{{GLOBAL_STATE}}`, `{{EVENT_FOCUS}}`, `{{ACTION_GUIDE}}`) so the orchestrator can inject runtime context without string concatenation.

*Tests*: `backend/tests/test_controller_runner.py::test_prompt_templates_have_placeholders` verifies both files and their placeholder text.

### S32 – Controller Runner & Speak Gate
1. Module `backend/orchestrator/controller_runner.py` MUST expose a `ControllerRunner` with:
   - `build_controller_prompt(...)` returning the filled controller template for a supplied set of events, task digests, summaries, and hints (caps raw events to 30).
   - `decide(hints, recent_events)` returning a dict containing `speak_now: bool`, `actions: list`, and `notes: str`. Default `speak_now` is `False`, but becomes `True` when hints include `"user_waiting"`, `"task_completed"`, or when recent events contain `ERROR`/`AGENT_RESULT` types.
   - `idle_watchdog_due(last_decision_ts, now_ts, interval_seconds=15)` boolean helper.
2. Runner MUST log suppressed narrator turns by emitting `NARRATION_SUPPRESSED` entries via `log.query.append_event` when `speak_now` is `False` but narration text was requested.

*Tests*: `test_controller_runner.py::test_controller_runner_gating_logic` and `::test_idle_watchdog` cover these behaviors.

### S33 – Summaries & Token Budgeting
1. Function `build_context_slice(conversation_id, events)` (exported from the same module) MUST:
   - Retain at most 30 newest events verbatim.
   - When more events exist, call `backend.log.summarize.rolling_summary` and `persist_summary` to compress older ones, appending a `SUMMARY_REFRESH` event with the new `summary_ref`.
   - Return a markdown string containing both preserved events and a `### Summaries` section referencing the latest summary ref.
2. Narrator prompts constructed via `build_narrator_prompt(actions, context, speak_now)` MUST include the summary text only when `speak_now=True`; otherwise they return `None` and rely on the suppression event.

*Tests*: `test_controller_runner.py::test_context_slice_respects_budget` and `::test_narrator_prompt_respects_gate` exercise the summary builder and narrator gating.

## TDD Workflow
1. Add the tests listed above (they should fail until the prompts + runner exist).
2. Implement prompt templates, controller runner, and narrator helpers.
3. Re-run `python3 -m pytest src/modules/streaming-llm/backend/tests` plus `npm run test:streaming-llm` to keep the full suite green.
