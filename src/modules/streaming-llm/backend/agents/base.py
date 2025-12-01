from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from .runtime import AgentRuntime


@dataclass
class AgentTask:
    """Normalized task structure consumed by agents."""

    id: str
    type: str
    status: str
    owner: Optional[str]
    priority: int
    inputs: Dict[str, Any]
    context: Dict[str, Any]
    metadata: Dict[str, Any]
    attempt: int = 0

    def conversation_id(self) -> str:
        return (
            self.metadata.get("conversation_id")
            or self.inputs.get("conversation_id")
            or self.id
        )


@dataclass
class AgentResult:
    task_id: str
    outcome: str
    artifacts: List[Any] = field(default_factory=list)
    notes: Optional[str] = None
    next_actions: Optional[List[Dict[str, Any]]] = None


class AgentError(Exception):
    def __init__(self, task_id: str, reason: str, retryable: bool = False, details: Optional[Dict[str, Any]] = None):
        super().__init__(reason)
        self.task_id = task_id
        self.reason = reason
        self.retryable = retryable
        self.details = details or {}

    def to_payload(self) -> Dict[str, Any]:
        return {
            "task_id": self.task_id,
            "reason": self.reason,
            "retryable": self.retryable,
            "details": self.details,
        }


class BaseAgent(ABC):
    agent_type: str

    def execute_once(self, runtime: "AgentRuntime") -> Optional[AgentResult]:
        task = runtime.poll_next_task()
        if not task:
            return None
        self.on_assign(task, runtime)
        self.on_progress(task, runtime)
        try:
            result = self.handle_task(task, runtime)
        except AgentError as error:
            self.on_error(task, error, runtime)
            runtime.fail_task(task, error)
            return None
        self.on_complete(task, result, runtime)
        runtime.complete_task(task, result)
        return result

    @abstractmethod
    def handle_task(self, task: AgentTask, runtime: "AgentRuntime") -> AgentResult:
        """Execute the core task logic and return an AgentResult."""

    def on_assign(self, task: AgentTask, runtime: "AgentRuntime") -> None:
        """Hook invoked immediately after claiming a task."""

    def on_complete(self, task: AgentTask, result: AgentResult, runtime: "AgentRuntime") -> None:
        """Hook invoked after successful completion."""

    def on_progress(self, task: AgentTask, runtime: "AgentRuntime") -> None:
        """Hook for subclasses to emit heartbeat-style updates."""

    def on_error(self, task: AgentTask, error: AgentError, runtime: "AgentRuntime") -> None:
        """Hook invoked when handle_task raises AgentError."""
