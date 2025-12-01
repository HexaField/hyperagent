from __future__ import annotations

import hashlib
import json
import os
from collections import defaultdict
from pathlib import Path
from typing import Dict, Any, List

DATA_ROOT = Path(os.environ.get("STREAMING_LLM_DATA_DIR") or Path(__file__).resolve().parents[2] / "data")
SUMMARIES_ROOT = DATA_ROOT / "summaries"


def rolling_summary(conversation_id: str, events: List[Dict[str, Any]]) -> Dict[str, Any]:
    groups: Dict[str, List[str]] = defaultdict(list)
    for event in events:
        group = event.get("type", "UNKNOWN")
        groups[group].append(_stringify_event(event))

    lines: List[str] = []
    for group in sorted(groups.keys()):
        lines.append(f"### {group}")
        for item in groups[group]:
            lines.append(f"- {item}")
    content = "\n".join(lines).strip()
    summary_ref = hashlib.sha256(content.encode("utf-8")).hexdigest()
    return {
        "conversation_id": conversation_id,
        "content": content,
        "summary_ref": summary_ref
    }


def persist_summary(conversation_id: str, summary: Dict[str, Any]) -> Path:
    SUMMARIES_ROOT.mkdir(parents=True, exist_ok=True)
    path = SUMMARIES_ROOT / f"{conversation_id}.md"
    header = f"<!-- summary_ref:{summary['summary_ref']} -->\n"
    path.write_text(header + summary["content"] + "\n", encoding="utf-8")
    return path


def _stringify_event(event: Dict[str, Any]) -> str:
    payload = event.get("payload")
    if isinstance(payload, str):
        return payload
    if isinstance(payload, dict):
        return json.dumps(payload, sort_keys=True)
    if event.get("message"):
        return str(event["message"])
    return "(no payload)"
