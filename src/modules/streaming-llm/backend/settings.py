from functools import lru_cache
from pathlib import Path
import os
from pydantic import BaseModel


DEFAULT_AGENTS_DIR = Path(".agents")


class Settings(BaseModel):
    model_name_or_path: str = os.environ.get(
        "STREAMING_LLM_MODEL", "llama3.2:latest"
    )
    enable_streaming: bool = os.environ.get("STREAMING_LLM_ENABLE", "1") == "1"
    start_size: int = int(os.environ.get("STREAMING_LLM_START_SIZE", "4"))
    recent_size: int = int(os.environ.get("STREAMING_LLM_RECENT_SIZE", "2048"))
    agents_dir: Path = Path(
        os.environ.get("STREAMING_LLM_AGENTS_DIR") or DEFAULT_AGENTS_DIR
    )
    max_new_tokens: int = int(os.environ.get("STREAMING_LLM_MAX_NEW_TOKENS", "512"))
    ollama_base_url: str = os.environ.get(
        "STREAMING_LLM_OLLAMA_URL", "http://127.0.0.1:11434"
    )


@lru_cache()
def get_settings() -> Settings:
    return Settings()
