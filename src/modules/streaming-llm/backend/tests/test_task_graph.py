from __future__ import annotations

import importlib
from pathlib import Path
from typing import Tuple

import pytest

MODULE_PATH = "backend.task_graph.store"


def _prepare_module(tmp_path: Path, monkeypatch):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "logs").mkdir()
    (data_dir / "summaries").mkdir()
    (data_dir / "archive").mkdir()
    graph_file = data_dir / "tasks.graph.json"
    graph_file.write_text('{"tasks": []}')
    monkeypatch.setenv("STREAMING_LLM_DATA_DIR", str(data_dir))
    if MODULE_PATH in importlib.sys.modules:
        importlib.sys.modules.pop(MODULE_PATH)
    module = importlib.import_module(MODULE_PATH)
    module = importlib.reload(module)
    return module, graph_file


@pytest.fixture
def task_store(tmp_path, monkeypatch):
    return _prepare_module(tmp_path, monkeypatch)


def test_create_and_list_tasks(task_store):
    store, _ = task_store
    created = store.create_task({
        "type": "analysis",
        "status": "PENDING",
        "owner": "planner",
        "inputs": {"question": "status"},
        "outputs": {},
        "dependency_ids": []
    })
    assert created["id"].startswith("task-")
    assert created["created_at"] == created["updated_at"]

    active = store.list_active({"PENDING"})
    assert any(task["id"] == created["id"] for task in active)


def test_update_task_refreshes_timestamp(task_store):
    store, _ = task_store
    task = store.create_task({
        "type": "analysis",
        "status": "PENDING",
        "owner": "planner",
        "inputs": {},
        "outputs": {},
        "dependency_ids": []
    })
    updated = store.update_task(task["id"], status="IN_PROGRESS", outputs={"notes": "working"})
    assert updated["status"] == "IN_PROGRESS"
    assert updated["updated_at"] > task["updated_at"]
    assert updated["outputs"]["notes"] == "working"


def test_load_and_save_graph(task_store):
    store, graph_file = task_store
    graph = store.load_graph()
    assert graph["tasks"] == []
    graph["tasks"].append({"id": "manual", "type": "analysis", "status": "PENDING"})
    store.save_graph(graph)
    persisted = store.load_graph()
    assert len(persisted["tasks"]) == 1
    assert persisted["tasks"][0]["id"] == "manual"
