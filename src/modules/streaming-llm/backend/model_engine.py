from __future__ import annotations

import json
import logging
from typing import Any, Dict, Generator, Iterable, List, Optional, Tuple

import httpx

from .agent_store import Agent
from .settings import get_settings, Settings


logger = logging.getLogger(__name__)


class StreamingLLMEngine:
    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()
        self.provider, self.ollama_model = self._detect_provider(
            self.settings.model_name_or_path,
        )
        self.ollama_base_url = self.settings.ollama_base_url.rstrip("/")
        self.model = None
        self.tokenizer = None
        self.device = None
        self.eos_token_id = None
        self.kv_cache = None
        self.torch = None

        if self.provider == "ollama":
            logger.info(
                "Using Ollama backend for model '%s' via %s",
                self.ollama_model,
                self.ollama_base_url,
            )
        else:
            self._init_local_model()

    def build_prompt(
        self,
        agent: Agent,
        history: Iterable[Dict[str, str]],
        user_message: str,
    ) -> str:
        sections: List[str] = []
        sections.append(f"System:\n{agent.system_prompt.strip()}")
        if agent.markdown_context.strip():
            sections.append(f"Context:\n{agent.markdown_context.strip()}")
        if history:
            history_lines = []
            for turn in history:
                role = turn.get("role", "user").upper()
                content = turn.get("content", "").strip()
                history_lines.append(f"{role}: {content}")
            sections.append("Conversation History:\n" + "\n".join(history_lines))
        sections.append(f"USER: {user_message.strip()}\nASSISTANT:")
        return "\n\n".join(sections)

    def stream(
        self,
        prompt: str,
        max_new_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
    ) -> Generator[str, None, None]:
        if self.provider == "ollama":
            yield from self._stream_from_ollama(prompt, max_new_tokens, temperature)
            return

        if self.torch is None or self.model is None or self.tokenizer is None:
            raise RuntimeError("Local Transformers backend is not initialized")

        torch = self.torch
        max_tokens = max_new_tokens or self.settings.max_new_tokens
        with torch.no_grad():
            input_ids = self.tokenizer(
                prompt,
                return_tensors="pt",
            ).input_ids.to(self.device)
            past_key_values = None
            if self.kv_cache is not None:
                space_needed = input_ids.shape[1] + max_tokens
                past_key_values = self.kv_cache.evict_for_space(None, space_needed)
            outputs = self.model(
                input_ids=input_ids,
                past_key_values=past_key_values,
                use_cache=True,
            )
            past_key_values = outputs.past_key_values
            generated_ids: List[int] = []
            prev_text = ""
            next_token = None
            for _ in range(max_tokens):
                logits = outputs.logits[:, -1, :]
                next_token = self._sample_next_token(logits, temperature)
                generated_ids.append(next_token.item())
                decoded_text = self.tokenizer.decode(
                    generated_ids,
                    skip_special_tokens=True,
                    clean_up_tokenization_spaces=True,
                )
                delta = decoded_text[len(prev_text) :]
                if delta:
                    prev_text = decoded_text
                    yield delta
                if next_token.item() == self.eos_token_id:
                    break
                outputs = self.model(
                    input_ids=next_token.to(self.device),
                    past_key_values=past_key_values,
                    use_cache=True,
                )
                past_key_values = outputs.past_key_values

    def _stream_from_ollama(
        self,
        prompt: str,
        max_new_tokens: Optional[int],
        temperature: Optional[float],
    ) -> Generator[str, None, None]:
        limit = max_new_tokens or self.settings.max_new_tokens
        payload: Dict[str, object] = {
            "model": self.ollama_model,
            "prompt": prompt,
            "stream": True,
        }
        options: Dict[str, object] = {}
        if limit:
            options["num_predict"] = limit
        if temperature is not None:
            options["temperature"] = temperature
        if options:
            payload["options"] = options
        url = f"{self.ollama_base_url}/api/generate"
        try:
            with httpx.Client(timeout=None) as client:
                with client.stream("POST", url, json=payload) as response:
                    response.raise_for_status()
                    for line in response.iter_lines():
                        if not line:
                            continue
                        if isinstance(line, bytes):
                            line = line.decode("utf-8")
                        line = line.strip()
                        if not line:
                            continue
                        chunk = json.loads(line)
                        error = chunk.get("error")
                        if error:
                            raise RuntimeError(f"Ollama error: {error}")
                        token = chunk.get("response") or ""
                        if token:
                            yield token
                        if chunk.get("done"):
                            break
        except httpx.HTTPError as exc:
            raise RuntimeError(f"Ollama request failed: {exc}") from exc

    def _sample_next_token(self, logits: Any, temperature: Optional[float]):
        if self.torch is None:
            raise RuntimeError("PyTorch is required for local Transformer sampling")
        torch = self.torch
        if temperature is None or temperature <= 0:
            return logits.argmax(dim=-1).unsqueeze(1)
        scaled = logits / temperature
        probs = torch.softmax(scaled, dim=-1)
        return torch.multinomial(probs, num_samples=1)

    def _init_local_model(self) -> None:
        import torch
        from streaming_llm.enable_streaming_llm import enable_streaming_llm
        from streaming_llm.utils import load

        self.torch = torch
        self.model, self.tokenizer = load(self.settings.model_name_or_path)
        if self.settings.enable_streaming:
            try:
                self.kv_cache = enable_streaming_llm(
                    self.model,
                    start_size=self.settings.start_size,
                    recent_size=self.settings.recent_size,
                )
            except ValueError as exc:
                model_type = getattr(self.model.config, "model_type", "unknown")
                logger.warning(
                    "Streaming KV cache disabled: model '%s' (type=%s) is not supported (%s)",
                    self.settings.model_name_or_path,
                    model_type,
                    exc,
                )
            except Exception:
                logger.exception(
                    "Streaming KV cache disabled due to unexpected error while enabling optimizations",
                )
        try:
            self.device = next(self.model.parameters()).device
        except StopIteration:
            self.device = torch.device("cpu")
        self.eos_token_id = self.tokenizer.eos_token_id or self.tokenizer.pad_token_id

    def _detect_provider(self, model_name: str) -> Tuple[str, str]:
        clean = (model_name or "").strip()
        if not clean:
            raise ValueError("Model name cannot be empty")
        if clean.startswith("ollama:"):
            candidate = clean.split(":", 1)[1].strip()
            if not candidate:
                raise ValueError("Ollama model id cannot be empty")
            return "ollama", candidate
        if ":" in clean and "/" not in clean:
            return "ollama", clean
        return "hf", clean
