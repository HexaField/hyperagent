from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from backend.log import query as log_query
from backend.log import summarize as log_summarize

MODULE_ROOT = Path(__file__).resolve().parents[2]
PROMPT_ROOT = MODULE_ROOT / "orchestrator" / "prompts"
DATA_ROOT = Path(os.environ.get("STREAMING_LLM_DATA_DIR") or (MODULE_ROOT / "data"))
LOG_ROOT = DATA_ROOT / "logs"
SUMMARY_ROOT = DATA_ROOT / "summaries"

SPEAK_HINTS = {"user_waiting", "task_completed", "agent_failed"}
TRIGGER_EVENT_TYPES = {"ERROR", "AGENT_RESULT"}


class ControllerRunner:
    def __init__(self, max_events: int = 30, prompt_dir: Optional[Path] = None):
        self.max_events = max_events
        self.prompt_dir = prompt_dir or PROMPT_ROOT
        self.controller_template = (self.prompt_dir / "controller.md").read_text(encoding="utf-8")
        self.narrator_template = (self.prompt_dir / "narrator.md").read_text(encoding="utf-8")

    def build_controller_prompt(
        self,
        conversation_id: str,
        events: List[Dict[str, Any]],
        task_digest: str,
        summary_text: str,
        hints: Optional[List[str]] = None,
    ) -> str:
        global_state = task_digest.strip() or "No active tasks."
        if summary_text:
            global_state = f"{global_state}\n\nSummaries:\n{summary_text.strip()}"
        context = build_context_slice(conversation_id, events, self.max_events)
        placeholder_values = {
            "{{SYSTEM_POLICY}}": "You are the Hyperagent controller. Produce JSON actions that coordinate specialists while respecting safety, task graph ownership, and user intent.",
            "{{GLOBAL_STATE}}": global_state,
            "{{EVENT_FOCUS}}": context,
            "{{ACTION_GUIDE}}": "Return JSON {\"actions\": [...], \"speak_now\": bool, \"notes\": string}. Include attention_hints you considered: " + ", ".join(hints or []),
        }
        prompt = self.controller_template
        for token, value in placeholder_values.items():
            prompt = prompt.replace(token, value)
        return prompt

    def decide(self, hints: Optional[List[str]], recent_events: List[Dict[str, Any]]) -> Dict[str, Any]:
        hints = hints or []
        speak = any(h in SPEAK_HINTS for h in hints)
        if not speak:
            for event in reversed(recent_events[-5:]):
                if event.get("type") in TRIGGER_EVENT_TYPES:
                    speak = True
                    break
        decision = {
            "speak_now": speak,
            "actions": [
                {
                    "kind": "reflect",
                    "attention_hints": hints,
                    "recent_event_types": [event.get("type") for event in recent_events[-3:]],
                }
            ],
            "notes": "Auto-gated via ControllerRunner",
        }
        return decision

    def idle_watchdog_due(self, last_decision_ts: float, now_ts: float, interval_seconds: int = 15) -> bool:
        return (now_ts - last_decision_ts) >= interval_seconds

    def build_narrator_prompt(
        self,
        actions: List[Dict[str, Any]],
        context_markdown: str,
        speak_now: bool,
        conversation_id: str,
    ) -> Optional[str]:
        if not speak_now:
            _sync_log_modules()
            LOG_ROOT.mkdir(parents=True, exist_ok=True)
            log_query.append_event(
                {
                    "conversation_id": conversation_id,
                    "type": "NARRATION_SUPPRESSED",
                    "payload": {"reason": "speak_now=false", "actions": actions},
                    "visibility": "internal",
                }
            )
            return None
        placeholder_values = {
            "{{NARRATION_CONTEXT}}": context_markdown.strip() or "No recent context.",
            "{{USER_CONTEXT}}": json.dumps(actions, ensure_ascii=False),
            "{{SPEAK_INSTRUCTIONS}}": "Respond concisely and acknowledge prior context before sharing new insights.",
        }
        prompt = self.narrator_template
        for token, value in placeholder_values.items():
            prompt = prompt.replace(token, value)
        return prompt


def build_context_slice(conversation_id: str, events: List[Dict[str, Any]], max_events: int = 30) -> str:
    _sync_log_modules()
    LOG_ROOT.mkdir(parents=True, exist_ok=True)
    SUMMARY_ROOT.mkdir(parents=True, exist_ok=True)
    kept = events[-max_events:]
    trimmed = events[:-max_events]
    lines = []
    for event in kept:
        label = event.get("type", "EVENT")
        payload = _render_payload(event.get("payload"))
        lines.append(f"- [{label}] {payload}")
    summary_section = ""
    if trimmed:
        summary = log_summarize.rolling_summary(conversation_id, trimmed)
        log_summarize.persist_summary(conversation_id, summary)
        log_query.append_event(
            {
                "conversation_id": conversation_id,
                "type": "SUMMARY_REFRESH",
                "payload": {"summary_ref": summary["summary_ref"]},
                "visibility": "internal",
            }
        )
        summary_section = (
            f"\n### Summaries\n- Ref {summary['summary_ref']} (see summaries/{conversation_id}.md)"
        )
    return "\n".join(lines) + summary_section


def _render_payload(payload: Any) -> str:
    if payload is None:
        return "(no payload)"
    if isinstance(payload, str):
        return payload
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def _sync_log_modules() -> None:
    """Keep log module roots aligned with controller runner data dir."""
    if getattr(log_query, "LOG_ROOT", None) != LOG_ROOT:
        log_query.DATA_ROOT = DATA_ROOT
        log_query.LOG_ROOT = LOG_ROOT
    if getattr(log_summarize, "SUMMARIES_ROOT", None) != SUMMARY_ROOT:
        log_summarize.DATA_ROOT = DATA_ROOT
        log_summarize.SUMMARIES_ROOT = SUMMARY_ROOT
