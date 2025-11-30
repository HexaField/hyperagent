from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .agent_store import AgentStore
from .conversation_manager import ConversationManager
from .model_engine import StreamingLLMEngine
from .settings import get_settings


class StreamCancelled(Exception):
    """Raised when a client disconnects during streaming."""

settings = get_settings()
agent_store = AgentStore(settings.agents_dir)
conversation_manager = ConversationManager()
engine: Optional[StreamingLLMEngine] = None


def get_engine() -> StreamingLLMEngine:
    global engine
    if engine is None:
        engine = StreamingLLMEngine(settings)
    return engine


class AgentPayload(BaseModel):
    id: str
    name: str
    system_prompt: str
    markdown_context: str


class AgentUpdateRequest(BaseModel):
    name: str
    system_prompt: str
    markdown_context: str


class AgentListResponse(BaseModel):
    agents: list[AgentPayload]


app = FastAPI(title="StreamingLLM Multi-Agent Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logger = logging.getLogger(__name__)


@app.get("/healthz")
def healthcheck() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/agents", response_model=AgentListResponse)
def list_agents() -> AgentListResponse:
    agents = [AgentPayload(**agent.to_dict()) for agent in agent_store.list_agents()]
    return AgentListResponse(agents=agents)


@app.get("/agents/{agent_id}", response_model=AgentPayload)
def get_agent(agent_id: str) -> AgentPayload:
    agent = agent_store.get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return AgentPayload(**agent.to_dict())


@app.put("/agents/{agent_id}", response_model=AgentPayload)
def upsert_agent(agent_id: str, payload: AgentUpdateRequest) -> AgentPayload:
    clean_id = agent_id.strip()
    if not clean_id:
        raise HTTPException(status_code=400, detail="Agent id cannot be blank")
    agent = agent_store.save_agent(
        agent_id=clean_id,
        name=payload.name.strip() or clean_id,
        system_prompt=payload.system_prompt.strip(),
        markdown_context=payload.markdown_context,
    )
    return AgentPayload(**agent.to_dict())


@app.delete("/agents/{agent_id}", status_code=204)
def delete_agent(agent_id: str) -> Response:
    if not agent_store.delete_agent(agent_id.strip()):
        raise HTTPException(status_code=404, detail="Agent not found")
    return Response(status_code=204)


@app.websocket("/ws/chat")
async def chat(websocket: WebSocket) -> None:
    await websocket.accept()
    loop = asyncio.get_running_loop()

    while True:
        try:
            raw = await websocket.receive_text()
        except WebSocketDisconnect:
            break

        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            await _send_ws_error(websocket, "Invalid JSON")
            await websocket.close()
            return

        required = {"agent_id", "user_message"}
        if not required.issubset(payload.keys()):
            await _send_ws_error(websocket, "Missing required fields")
            await websocket.close()
            return

        agent_id = payload["agent_id"]
        user_message = str(payload["user_message"]).strip()
        options: Dict[str, Any] = payload.get("options") or {}
        agent = agent_store.get_agent(agent_id)
        if not agent:
            await _send_ws_error(websocket, f"Agent {agent_id} not found")
            await websocket.close()
            return

        try:
            conversation_id = conversation_manager.ensure(payload.get("conversation_id"))
            history = conversation_manager.history(conversation_id)
            if user_message:
                conversation_manager.append(conversation_id, "USER", user_message)
            prompt = get_engine().build_prompt(agent, history, user_message)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to prepare chat session")
            await _send_ws_error(websocket, f"Backend error: {exc}")
            await websocket.close()
            return

        assistant_chunks: list[str] = []
        cancelled = False

        def send_event(event: Dict[str, Any]) -> None:
            event.setdefault("conversation_id", conversation_id)
            try:
                asyncio.run_coroutine_threadsafe(
                    websocket.send_text(json.dumps(event)),
                    loop,
                ).result()
            except WebSocketDisconnect as exc:
                raise StreamCancelled from exc
            except RuntimeError as exc:
                raise StreamCancelled from exc

        def run_generation() -> None:
            nonlocal cancelled
            try:
                for token in get_engine().stream(
                    prompt=prompt,
                    temperature=_safe_float(options.get("temperature")),
                    max_new_tokens=_safe_int(options.get("max_new_tokens")),
                ):
                    assistant_chunks.append(token)
                    send_event({"type": "token", "token": token})
                send_event({"type": "done"})
            except StreamCancelled:
                cancelled = True
            except Exception as exc:  # noqa: BLE001 - surface model errors
                send_event({"type": "error", "message": str(exc)})

        await loop.run_in_executor(None, run_generation)
        assistant_text = "".join(assistant_chunks).strip()
        if assistant_text and not cancelled:
            conversation_manager.append(conversation_id, "ASSISTANT", assistant_text)

        if cancelled:
            break


def _safe_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _safe_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


async def _send_ws_error(websocket: WebSocket, message: str) -> None:
    try:
        await websocket.send_text(json.dumps({"type": "error", "message": message}))
    except Exception:  # noqa: BLE001
        logger.debug("Unable to send websocket error message", exc_info=True)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("backend.server:app", host="0.0.0.0", port=8000, reload=False)
