from collections import deque
from typing import Deque, Dict, List, Optional
from uuid import uuid4


class ConversationManager:
    def __init__(self, max_turns: int = 10):
        self._conversations: Dict[str, Deque[Dict[str, str]]] = {}
        self.max_turns = max_turns

    def ensure(self, conversation_id: Optional[str]) -> str:
        if conversation_id and conversation_id in self._conversations:
            return conversation_id
        new_id = conversation_id or str(uuid4())
        self._conversations[new_id] = deque(maxlen=self.max_turns)
        return new_id

    def append(self, conversation_id: str, role: str, content: str) -> None:
        convo = self._conversations.setdefault(
            conversation_id, deque(maxlen=self.max_turns)
        )
        convo.append({"role": role, "content": content})

    def history(self, conversation_id: str) -> List[Dict[str, str]]:
        convo = self._conversations.get(conversation_id)
        if not convo:
            return []
        return list(convo)
