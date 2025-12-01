from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, List, Dict, Any, Optional
import uuid
import fcntl

DATA_ROOT = Path(os.environ.get("STREAMING_LLM_DATA_DIR") or Path(__file__).resolve().parents[2] / "data")
LOG_ROOT = DATA_ROOT / "logs"


def append_event(event: Dict[str, Any]) -> str:
    conversation_id = event.get("conversation_id")
    if not conversation_id:
        raise ValueError("conversation_id is required")
    LOG_ROOT.mkdir(parents=True, exist_ok=True)
    entry = dict(event)
    entry.setdefault("conversation_id", conversation_id)
    entry.setdefault("id", f"evt-{uuid.uuid4().hex}")
    entry["timestamp"] = _now_iso()
    path = LOG_ROOT / f"{conversation_id}.jsonl"
    with path.open("a+", encoding="utf-8") as handle:
        _lock(handle, fcntl.LOCK_EX)
        handle.seek(0, os.SEEK_END)
        handle.write(json.dumps(entry, ensure_ascii=False))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
        _lock(handle, fcntl.LOCK_UN)
    return entry["id"]


def tail(conversation_id: str, limit: int = 20) -> List[Dict[str, Any]]:
    path = LOG_ROOT / f"{conversation_id}.jsonl"
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as handle:
        _lock(handle, fcntl.LOCK_SH)
        lines = handle.readlines()
        _lock(handle, fcntl.LOCK_UN)
    return [_parse_line(line) for line in lines[-limit:]]


def since(timestamp: str) -> List[Dict[str, Any]]:
    cutoff = _parse_timestamp(timestamp)
    events = []
    for entry in _iter_all_events():
        event_time = _parse_timestamp(entry["timestamp"])
        if event_time >= cutoff:
            events.append(entry)
    events.sort(key=lambda item: item["timestamp"])
    return events


def by_type(event_types: List[str], visibility: Optional[str] = None) -> List[Dict[str, Any]]:
    types = set(event_types)
    results = []
    for entry in _iter_all_events():
        if entry.get("type") not in types:
            continue
        if visibility and entry.get("visibility") != visibility:
            continue
        results.append(entry)
    results.sort(key=lambda item: item["timestamp"])
    return results


def _iter_all_events() -> Iterable[Dict[str, Any]]:
    if not LOG_ROOT.exists():
        return []
    for log_file in sorted(LOG_ROOT.glob("*.jsonl")):
        with log_file.open("r", encoding="utf-8") as handle:
            _lock(handle, fcntl.LOCK_SH)
            for line in handle:
                yield _parse_line(line)
            _lock(handle, fcntl.LOCK_UN)


def _parse_line(line: str) -> Dict[str, Any]:
    line = line.strip()
    if not line:
        return {}
    return json.loads(line)


def _parse_timestamp(value: str) -> datetime:
    if value.endswith("Z"):
        value = value.replace("Z", "+00:00")
    return datetime.fromisoformat(value)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _lock(handle, mode):
    fcntl.flock(handle.fileno(), mode)
