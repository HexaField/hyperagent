from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

MODULE_LOG = "backend.log.query"
MODULE_TASKS = "backend.task_graph.store"


def _load_modules(tmp_path: Path, monkeypatch):
    data_dir = tmp_path / "data"
    (data_dir / "logs").mkdir(parents=True)
    (data_dir / "summaries").mkdir()
    (data_dir / "archive").mkdir()
    (data_dir / "tasks.graph.json").write_text('{"tasks": []}')
    monkeypatch.setenv("STREAMING_LLM_DATA_DIR", str(data_dir))
    for name in (MODULE_LOG, MODULE_TASKS):
        if name in sys.modules:
            del sys.modules[name]
    log_query = importlib.import_module(MODULE_LOG)
    task_store = importlib.import_module(MODULE_TASKS)
    log_query = importlib.reload(log_query)
    task_store = importlib.reload(task_store)
    return log_query, task_store, data_dir


def test_workspace_narrator_task_bridge(tmp_path, monkeypatch):
    log_query, task_store, data_dir = _load_modules(tmp_path, monkeypatch)
    workspace_id = "ws-bridge"
    conversation_id = "conv-bridge"

    user_event_id = log_query.append_event({
        "conversation_id": conversation_id,
        "type": "USER_MESSAGE",
        "payload": {"text": "Status?"},
        "visibility": "user"
    })

    task = task_store.create_task({
        "type": "controller",
        "status": "PENDING",
        "inputs": {"conversation_id": conversation_id},
        "metadata": {
            "workspace_id": workspace_id,
            "conversation_id": conversation_id,
            "source": "workspace-narrator"
        }
    })

    log_query.append_event({
        "conversation_id": conversation_id,
        "type": "AGENT_UPDATE",
        "payload": {"status": "controller_enqueued", "task_id": task["id"]},
        "visibility": "internal"
    })

    narrator_event_id = log_query.append_event({
        "conversation_id": conversation_id,
        "type": "NARRATION",
        "payload": {"headline": "Narrator reply", "text": "Acknowledged."},
        "visibility": "user"
    })

    task_store.update_task(task["id"], status="COMPLETED", outputs={"narrator_event_id": narrator_event_id})

    completion_event_id = log_query.append_event({
        "conversation_id": conversation_id,
        "type": "WORKSPACE_NARRATOR_COMPLETED",
        "payload": {
            "task_id": task["id"],
            "narrator_event_id": narrator_event_id
        },
        "visibility": "system"
    })

    events = log_query.tail(conversation_id, limit=10)
    event_ids = {event["id"] for event in events}
    assert {user_event_id, narrator_event_id, completion_event_id}.issubset(event_ids)
    assert any(event["type"] == "USER_MESSAGE" for event in events)
    assert any(event["type"] == "WORKSPACE_NARRATOR_COMPLETED" for event in events)

    graph = json.loads((data_dir / "tasks.graph.json").read_text())
    stored_task = next(node for node in graph["tasks"] if node["id"] == task["id"])
    assert stored_task["metadata"]["source"] == "workspace-narrator"
    assert stored_task["outputs"]["narrator_event_id"] == narrator_event_id