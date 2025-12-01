from __future__ import annotations

import importlib
import os
from pathlib import Path
import sys

import pytest

MODULE_PATH = "backend.log.query"


def _prepare_module(tmp_path: Path, monkeypatch) -> any:
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
    return module


@pytest.fixture
def log_query(tmp_path, monkeypatch):
    return _prepare_module(tmp_path, monkeypatch)


def test_append_and_tail(log_query):
    event_id = log_query.append_event({
        "conversation_id": "alpha",
        "type": "USER_MESSAGE",
        "payload": {"text": "hello"},
        "visibility": "user"
    })
    assert isinstance(event_id, str)

    events = log_query.tail("alpha", limit=5)
    assert len(events) == 1
    event = events[0]
    assert event["id"] == event_id
    assert event["conversation_id"] == "alpha"
    assert "timestamp" in event


def test_since_and_by_type(log_query):
    first_id = log_query.append_event({
        "conversation_id": "alpha",
        "type": "USER_MESSAGE",
        "payload": {"text": "hello"},
        "visibility": "user"
    })
    second_id = log_query.append_event({
        "conversation_id": "beta",
        "type": "AGENT_UPDATE",
        "payload": {"state": "working"},
        "visibility": "internal"
    })

    alpha_events = log_query.tail("alpha", limit=1)
    start_ts = alpha_events[0]["timestamp"]

    since_events = log_query.since(start_ts)
    ids = {event["id"] for event in since_events}
    assert {first_id, second_id}.issubset(ids)

    filtered = log_query.by_type(["AGENT_UPDATE"], visibility="internal")
    assert len(filtered) == 1
    assert filtered[0]["id"] == second_id
