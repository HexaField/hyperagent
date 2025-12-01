from __future__ import annotations

import json
from pathlib import Path

STREAMING_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = STREAMING_ROOT / "data"


def test_data_scaffold_exists() -> None:
    expected = ["logs", "summaries", "archive"]
    for folder_name in expected:
        folder = DATA_DIR / folder_name
        assert folder.is_dir(), f"missing folder: {folder}"
        keep = folder / ".gitkeep"
        assert keep.exists(), f"missing .gitkeep sentinel for {folder_name}"

    tasks_file = DATA_DIR / "tasks.graph.json"
    assert tasks_file.is_file(), "tasks.graph.json must exist"
    payload = json.loads(tasks_file.read_text())
    assert isinstance(payload, dict)
    assert "tasks" in payload
    assert isinstance(payload["tasks"], list)
