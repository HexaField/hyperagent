from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path
from typing import List

import pytest

MODULE_PATH = "backend.orchestrator.controller_runner"
STREAMING_ROOT = Path(__file__).resolve().parents[2]


def _load_module(tmp_path: Path, monkeypatch):
    data_dir = tmp_path / "data"
    (data_dir / "logs").mkdir(parents=True)
    (data_dir / "summaries").mkdir()
    (data_dir / "archive").mkdir()
    (data_dir / "tasks.graph.json").write_text('{"tasks": []}')
    monkeypatch.setenv("STREAMING_LLM_DATA_DIR", str(data_dir))
    if MODULE_PATH in sys.modules:
        del sys.modules[MODULE_PATH]
    module = importlib.import_module(MODULE_PATH)
    module = importlib.reload(module)
    return module, data_dir


@pytest.fixture
def controller_runner(tmp_path, monkeypatch):
    return _load_module(tmp_path, monkeypatch)


def test_prompt_templates_have_placeholders():
    controller = STREAMING_ROOT / "orchestrator" / "prompts" / "controller.md"
    narrator = STREAMING_ROOT / "orchestrator" / "prompts" / "narrator.md"
    assert controller.exists()
    assert narrator.exists()
    ctrl_text = controller.read_text()
    nar_text = narrator.read_text()
    for token in ["{{SYSTEM_POLICY}}", "{{GLOBAL_STATE}}", "{{EVENT_FOCUS}}", "{{ACTION_GUIDE}}"]:
        assert token in ctrl_text
    for token in ["{{NARRATION_CONTEXT}}", "{{USER_CONTEXT}}", "{{SPEAK_INSTRUCTIONS}}"]:
        assert token in nar_text


def test_controller_runner_gating_logic(controller_runner):
    module, data_dir = controller_runner
    runner = module.ControllerRunner()
    events = [
        {"type": "USER_MESSAGE", "payload": {"text": "hi"}},
        {"type": "AGENT_UPDATE", "payload": {"state": "working"}},
    ]

    decision = runner.decide(hints=[], recent_events=events)
    assert decision["speak_now"] is False

    decision = runner.decide(hints=["user_waiting"], recent_events=events)
    assert decision["speak_now"] is True

    events.append({"type": "AGENT_RESULT", "payload": {"summary": "done"}})
    decision = runner.decide(hints=[], recent_events=events)
    assert decision["speak_now"] is True

    assert runner.idle_watchdog_due(0, 16, interval_seconds=15) is True
    assert runner.idle_watchdog_due(10, 20, interval_seconds=15) is False


def test_context_slice_respects_budget(controller_runner):
    module, data_dir = controller_runner
    events = [{"type": "TASK_STATUS", "payload": {"message": f"#{idx}"}} for idx in range(40)]
    context = module.build_context_slice("conv-1", events)
    assert context.count("TASK_STATUS") == 30
    summary_file = data_dir / "summaries" / "conv-1.md"
    assert summary_file.exists()
    logs_path = data_dir / "logs" / "conv-1.jsonl"
    assert logs_path.exists()
    log_entries = [json.loads(line) for line in logs_path.read_text().splitlines() if line.strip()]
    assert any(entry.get("type") == "SUMMARY_REFRESH" for entry in log_entries)


def test_narrator_prompt_respects_gate(controller_runner):
    module, data_dir = controller_runner
    runner = module.ControllerRunner()
    narrative = runner.build_narrator_prompt(
        actions=[{"thought": "waiting"}],
        context_markdown="context",
        speak_now=False,
        conversation_id="conv-2"
    )
    assert narrative is None
    logs_path = data_dir / "logs" / "conv-2.jsonl"
    assert logs_path.exists()
    entries = [json.loads(line) for line in logs_path.read_text().splitlines() if line.strip()]
    assert any(entry.get("type") == "NARRATION_SUPPRESSED" for entry in entries)

    narrative = runner.build_narrator_prompt(
        actions=[{"thought": "done"}],
        context_markdown="context",
        speak_now=True,
        conversation_id="conv-2"
    )
    assert "context" in narrative
    assert "done" in narrative