from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, List, Optional, Set
import uuid
import fcntl

DATA_ROOT = Path(os.environ.get("STREAMING_LLM_DATA_DIR") or Path(__file__).resolve().parents[2] / "data")
GRAPH_PATH = DATA_ROOT / "tasks.graph.json"


def load_graph() -> Dict[str, Any]:
    _ensure_graph_file()
    with GRAPH_PATH.open("r", encoding="utf-8") as handle:
        _lock(handle, fcntl.LOCK_SH)
        data = json.load(handle)
        _lock(handle, fcntl.LOCK_UN)
    if "tasks" not in data:
        data["tasks"] = []
    return data


def save_graph(graph: Dict[str, Any]) -> None:
    GRAPH_PATH.parent.mkdir(parents=True, exist_ok=True)
    graph.setdefault("tasks", [])
    with GRAPH_PATH.open("w", encoding="utf-8") as handle:
        _lock(handle, fcntl.LOCK_EX)
        json.dump(graph, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
        _lock(handle, fcntl.LOCK_UN)


def create_task(task: Dict[str, Any]) -> Dict[str, Any]:
    graph = load_graph()
    now = _now_iso()
    node = {
        "id": task.get("id", f"task-{uuid.uuid4().hex}"),
        "type": task["type"],
        "status": task["status"],
        "owner": task.get("owner"),
        "inputs": task.get("inputs", {}),
        "outputs": task.get("outputs", {}),
        "context": task.get("context", {}),
        "metadata": task.get("metadata", {}),
        "priority": task.get("priority", 0),
        "attempt": task.get("attempt", 0),
        "created_at": task.get("created_at", now),
        "updated_at": now,
        "parent_id": task.get("parent_id"),
        "dependency_ids": task.get("dependency_ids", []),
    }
    graph.setdefault("tasks", []).append(node)
    save_graph(graph)
    return node


def update_task(task_id: str, **patch: Any) -> Dict[str, Any]:
    graph = load_graph()
    for node in graph.get("tasks", []):
        if node["id"] == task_id:
            node.update(patch)
            node["updated_at"] = _now_iso()
            save_graph(graph)
            return node
    raise KeyError(f"task {task_id} not found")


def list_active(statuses: Optional[Set[str]] = None) -> List[Dict[str, Any]]:
    graph = load_graph()
    tasks = graph.get("tasks", [])
    if not statuses:
        return list(tasks)
    wanted = set(statuses)
    return [task for task in tasks if task.get("status") in wanted]


def _ensure_graph_file() -> None:
    GRAPH_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not GRAPH_PATH.exists():
        GRAPH_PATH.write_text('{"tasks": []}', encoding="utf-8")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _lock(handle, mode) -> None:
    fcntl.flock(handle.fileno(), mode)
