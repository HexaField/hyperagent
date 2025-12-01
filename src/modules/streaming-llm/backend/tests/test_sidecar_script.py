from __future__ import annotations

from pathlib import Path

STREAMING_ROOT = Path(__file__).resolve().parents[2]


def test_run_sidecar_exists():
    script = STREAMING_ROOT / "scripts" / "run-sidecar.sh"
    assert script.exists(), "run-sidecar.sh must exist"
    contents = script.read_text()
    assert contents.startswith("#!/"), "script must have shebang"
    assert "uvicorn backend.server:app" in contents
    assert "pip install -r backend/requirements.txt" in contents


def test_compose_snippet_exists():
    compose_file = STREAMING_ROOT / "docker" / "workflow-runner" / "streaming-llm.compose.yml"
    assert compose_file.exists(), "docker compose snippet missing"
    text = compose_file.read_text()
    assert "streaming-llm" in text
    assert ".env.sidecar" in text
    assert "8000" in text


def test_readme_mentions_sidecar_section():
    readme = STREAMING_ROOT / "README.md"
    assert readme.exists()
    text = readme.read_text()
    assert "Sidecar Deployment" in text
    assert "run-sidecar.sh" in text
    assert "docker/workflow-runner/streaming-llm.compose.yml" in text


def test_env_template_has_extra_vars():
    env_file = STREAMING_ROOT / ".env.sidecar.example"
    text = env_file.read_text()
    required = [
        "STREAMING_LLM_HOST=",
        "STREAMING_LLM_PORT=",
        "STREAMING_LLM_LOG_DIR=",
        "STREAMING_LLM_SUMMARY_DIR="
    ]
    for entry in required:
        assert entry in text, f"missing {entry}"
