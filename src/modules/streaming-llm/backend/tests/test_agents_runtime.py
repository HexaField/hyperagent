from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path
from types import ModuleType
from typing import Tuple

import pytest

BASE_MODULE = "backend.agents.base"
RUNTIME_MODULE = "backend.agents.runtime"
TASK_STORE_MODULE = "backend.task_graph.store"
LOG_QUERY_MODULE = "backend.log.query"


def _purge_backend_modules() -> None:
    prefixes = ("backend.agents", "backend.task_graph", "backend.log")
    for module_name in list(sys.modules.keys()):
        if module_name.startswith(prefixes):
            sys.modules.pop(module_name, None)


def _load_agents(tmp_path: Path, monkeypatch) -> Tuple[ModuleType, ModuleType, ModuleType, ModuleType, Path]:
    data_dir = tmp_path / "data"
    (data_dir / "logs").mkdir(parents=True)
    (data_dir / "summaries").mkdir()
    (data_dir / "archive").mkdir()
    (data_dir / "tasks.graph.json").write_text('{"tasks": []}')
    monkeypatch.setenv("STREAMING_LLM_DATA_DIR", str(data_dir))
    _purge_backend_modules()
    base = importlib.import_module(BASE_MODULE)
    runtime = importlib.import_module(RUNTIME_MODULE)
    task_store = importlib.import_module(TASK_STORE_MODULE)
    log_query = importlib.import_module(LOG_QUERY_MODULE)
    return base, runtime, task_store, log_query, data_dir


@pytest.fixture
def agent_env(tmp_path, monkeypatch):
    return _load_agents(tmp_path, monkeypatch)


def _create_task(task_store: ModuleType, overrides: dict) -> dict:
    base_payload = {
        "type": "coder",
        "status": "PENDING",
        "owner": None,
        "inputs": {"input": ""},
        "outputs": {},
        "context": {"summary_ids": []},
        "metadata": {"conversation_id": "conv-phase5"},
        "priority": 5,
    }
    base_payload.update(overrides)
    return task_store.create_task(base_payload)


def _read_log(path: Path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def test_base_agent_handles_lifecycle(agent_env):
    base, runtime_mod, task_store, _, data_dir = agent_env
    created = _create_task(
        task_store,
        {
            "type": "coder",
            "metadata": {"conversation_id": "conv-agent-1"},
            "inputs": {"input": "build"},
        },
    )
    runtime = runtime_mod.AgentRuntime(agent_id="coder-1", agent_type="coder")

    class EchoAgent(base.BaseAgent):
        agent_type = "coder"

        def handle_task(self, task, runtime):
            runtime.emit_update(task, message="working", progress={"step": 1})
            return base.AgentResult(
                task_id=task.id,
                outcome="success",
                artifacts=[{"type": "note", "value": "done"}],
                notes="complete",
                next_actions=[],
            )

    agent = EchoAgent()
    result = agent.execute_once(runtime)
    assert result is not None
    assert result.outcome == "success"

    log_path = data_dir / "logs" / "conv-agent-1.jsonl"
    entries = _read_log(log_path)
    assert [entry["type"] for entry in entries] == ["AGENT_UPDATE", "AGENT_RESULT"]
    assert entries[-1]["payload"]["outcome"] == "success"
    graph = task_store.load_graph()
    node = next(item for item in graph["tasks"] if item["id"] == created["id"])
    assert node["status"] == "COMPLETED"


def test_agent_runtime_claims_and_updates_tasks(agent_env):
    base, runtime_mod, task_store, _, _ = agent_env
    task_one = _create_task(
        task_store,
        {
            "type": "coder",
            "metadata": {"conversation_id": "conv-rt"},
            "priority": 1,
        },
    )
    _create_task(task_store, {"type": "search", "metadata": {"conversation_id": "conv-other"}})
    runtime = runtime_mod.AgentRuntime(agent_id="coder-9", agent_type="coder", heartbeat_interval=2.0)

    claimed = runtime.poll_next_task()
    assert claimed is not None
    assert claimed.id == task_one["id"]

    graph = task_store.load_graph()
    node = next(item for item in graph["tasks"] if item["id"] == claimed.id)
    assert node["status"] == "IN_PROGRESS"
    assert node["owner"] == "coder-9"
    assert node["attempt"] == 1

    runtime.emit_update(claimed, message="still working")
    last = runtime.last_heartbeat_at
    assert last is not None
    assert runtime.heartbeat_due(last, now=last) is False
    assert runtime.heartbeat_due(last, now=last + 3) is True

    result = base.AgentResult(
        task_id=claimed.id,
        outcome="success",
        artifacts=[],
        notes="done",
        next_actions=None,
    )
    runtime.complete_task(claimed, result)
    graph = task_store.load_graph()
    node = next(item for item in graph["tasks"] if item["id"] == claimed.id)
    assert node["status"] == "COMPLETED"


def test_runtime_rejects_user_visible_payloads(agent_env):
    _, runtime_mod, task_store, _, _ = agent_env
    _create_task(task_store, {"type": "coder", "metadata": {"conversation_id": "conv-guard"}})
    runtime = runtime_mod.AgentRuntime(agent_id="coder-guard", agent_type="coder")
    task = runtime.poll_next_task()
    assert task is not None

    with pytest.raises(runtime_mod.PolicyViolation) as exc_info:
        runtime.emit_update(task, message="nope", extra={"render_to_user": True})
    assert getattr(exc_info.value, "policy_error", False) is True
    assert "user-visible" in str(exc_info.value)
