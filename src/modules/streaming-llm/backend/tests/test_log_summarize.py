from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

MODULE_PATH = "backend.log.summarize"


def _prepare_module(tmp_path: Path, monkeypatch):
    data_dir = tmp_path / "data"
    (data_dir / "logs").mkdir(parents=True)
    (data_dir / "summaries").mkdir()
    (data_dir / "archive").mkdir()
    (data_dir / "tasks.graph.json").write_text('{"tasks": []}')
    monkeypatch.setenv("STREAMING_LLM_DATA_DIR", str(data_dir))
    if MODULE_PATH in sys.modules:
        sys.modules.pop(MODULE_PATH)
    module = importlib.import_module(MODULE_PATH)
    module = importlib.reload(module)
    return module, data_dir


@pytest.fixture
def log_summarize(tmp_path, monkeypatch):
    return _prepare_module(tmp_path, monkeypatch)


def test_rolling_summary_groups_events(log_summarize):
    module, _ = log_summarize
    events = [
        {"type": "USER_MESSAGE", "payload": {"text": "Hello"}},
        {"type": "AGENT_UPDATE", "payload": {"state": "working"}},
        {"type": "USER_MESSAGE", "payload": {"text": "Status?"}},
    ]
    summary = module.rolling_summary("alpha", events)
    assert summary["conversation_id"] == "alpha"
    assert "USER_MESSAGE" in summary["content"]
    assert summary["content"].count("-") >= 2
    assert len(summary["summary_ref"]) == 64


def test_persist_summary_writes_markdown(log_summarize):
    module, data_dir = log_summarize
    summary = {
        "conversation_id": "alpha",
        "content": "### USER_MESSAGE\n- Hello",
        "summary_ref": "deadbeef" * 8
    }
    path = module.persist_summary("alpha", summary)
    assert path == data_dir / "summaries" / "alpha.md"
    assert path.exists()
    content = path.read_text()
    assert "USER_MESSAGE" in content
    assert summary["summary_ref"] in content
