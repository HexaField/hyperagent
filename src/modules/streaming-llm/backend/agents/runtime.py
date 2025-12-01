from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Dict, Optional

from backend.log import query as log_query
from backend.task_graph import store as task_store

from .base import AgentResult, AgentTask, AgentError

DATA_ROOT = Path(os.environ.get("STREAMING_LLM_DATA_DIR") or Path(__file__).resolve().parents[2] / "data")
LOG_ROOT = DATA_ROOT / "logs"


class PolicyViolation(ValueError):
    def __init__(self, message: str):
        super().__init__(message)
        self.policy_error = True


class AgentRuntime:
    def __init__(self, agent_id: str, agent_type: str, heartbeat_interval: float = 15.0):
        self.agent_id = agent_id
        self.agent_type = agent_type
        self.heartbeat_interval = heartbeat_interval
        self.last_heartbeat_at: Optional[float] = None

    def poll_next_task(self) -> Optional[AgentTask]:
        tasks = task_store.list_active({"PENDING"})
        for node in tasks:
            if node.get("type") != self.agent_type:
                continue
            claimed = task_store.update_task(
                node["id"],
                status="IN_PROGRESS",
                owner=self.agent_id,
                attempt=node.get("attempt", 0) + 1,
            )
            return self._to_agent_task(claimed)
        return None

    def emit_update(
        self,
        task: AgentTask,
        message: str,
        progress: Optional[Dict[str, Any]] = None,
        extra: Optional[Dict[str, Any]] = None,
    ) -> None:
        payload: Dict[str, Any] = {
            "task_id": task.id,
            "agent_id": self.agent_id,
            "agent_type": self.agent_type,
            "message": message,
        }
        if progress is not None:
            payload["progress"] = progress
        if extra:
            payload.update(extra)
        self._enforce_policy(payload)
        self._append_event(task, "AGENT_UPDATE", payload)
        self.last_heartbeat_at = time.time()

    def complete_task(self, task: AgentTask, result: AgentResult) -> Dict[str, Any]:
        payload = {
            "task_id": result.task_id,
            "agent_id": self.agent_id,
            "agent_type": self.agent_type,
            "outcome": result.outcome,
            "artifacts": result.artifacts or [],
            "notes": result.notes,
            "next_actions": result.next_actions,
        }
        self._enforce_policy(payload)
        self._append_event(task, "AGENT_RESULT", payload)
        return task_store.update_task(task.id, status="COMPLETED", outputs={"result": payload})

    def fail_task(self, task: AgentTask, error: AgentError) -> Dict[str, Any]:
        payload = {
            "task_id": error.task_id,
            "agent_id": self.agent_id,
            "agent_type": self.agent_type,
            "outcome": "failed",
            "error": error.to_payload(),
        }
        self._enforce_policy(payload)
        self._append_event(task, "AGENT_RESULT", payload)
        return task_store.update_task(
            task.id,
            status="FAILED",
            outputs={"error": error.to_payload()},
        )

    def heartbeat_due(self, last_ts: Optional[float], now: Optional[float] = None) -> bool:
        if last_ts is None:
            return True
        current = now or time.time()
        return (current - last_ts) >= self.heartbeat_interval

    def _append_event(self, task: AgentTask, kind: str, payload: Dict[str, Any]) -> None:
        LOG_ROOT.mkdir(parents=True, exist_ok=True)
        log_query.append_event(
            {
                "conversation_id": task.conversation_id(),
                "type": kind,
                "payload": payload,
                "visibility": "internal",
            }
        )

    def _enforce_policy(self, payload: Dict[str, Any]) -> None:
        if payload.get("render_to_user"):
            raise PolicyViolation("Agent events cannot add user-visible output; narrator only.")
        payload.pop("render_to_user", None)

    def _to_agent_task(self, node: Dict[str, Any]) -> AgentTask:
        return AgentTask(
            id=node["id"],
            type=node.get("type", "unknown"),
            status=node.get("status", "UNKNOWN"),
            owner=node.get("owner"),
            priority=node.get("priority", 0),
            inputs=node.get("inputs", {}),
            context=node.get("context", {}),
            metadata=node.get("metadata", {}),
            attempt=node.get("attempt", 0),
        )
