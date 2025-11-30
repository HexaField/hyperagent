from __future__ import annotations

from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Dict, List, Optional
import yaml


DEFAULT_AGENT_DEFINITIONS = (
    {
        "id": "planner",
        "name": "Planner",
        "system_prompt": (
            "You are Planner, a meticulous senior engineer who produces concise step-by-step plans."
        ),
        "markdown_context": (
            "## Internal Notes\n"
            "- Specialize in planning multi-agent collaborations.\n"
            "- Keep answers short and focus on next actions.\n"
        ),
    },
    {
        "id": "researcher",
        "name": "Researcher",
        "system_prompt": (
            "You are Researcher, an analytical assistant who cites concrete evidence from the provided context."
        ),
        "markdown_context": (
            "### Context Guidelines\n"
            "1. Skim the context markdown before answering.\n"
            "2. Quote bullet numbers when referencing details.\n"
        ),
    },
)


@dataclass
class Agent:
    id: str
    name: str
    system_prompt: str
    markdown_context: str

    def to_dict(self) -> Dict[str, str]:
        data = asdict(self)
        return data


class AgentStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._agents: Dict[str, Agent] = {}
        self._seed_default_agents()
        self.reload()

    def reload(self) -> None:
        self._agents.clear()
        for path in self.root.glob("*.md"):
            agent = self._read_agent_file(path)
            if agent:
                self._agents[agent.id] = agent

    def list_agents(self) -> List[Agent]:
        return list(self._agents.values())

    def get_agent(self, agent_id: str) -> Optional[Agent]:
        return self._agents.get(agent_id)

    def save_agent(
        self,
        agent_id: str,
        name: str,
        system_prompt: str,
        markdown_context: str,
    ) -> Agent:
        agent = Agent(
            id=agent_id,
            name=name,
            system_prompt=system_prompt,
            markdown_context=markdown_context,
        )
        path = self.root / f"{agent_id}.md"
        frontmatter = yaml.safe_dump(
            {
                "id": agent.id,
                "name": agent.name,
                "system_prompt": agent.system_prompt,
            },
            sort_keys=False,
            allow_unicode=False,
        ).strip()
        markdown_block = agent.markdown_context.rstrip() + "\n"
        content = f"---\n{frontmatter}\n---\n\n{markdown_block}"
        path.write_text(content)
        self._agents[agent.id] = agent
        return agent

    def delete_agent(self, agent_id: str) -> bool:
        removed = False
        if agent_id in self._agents:
            self._agents.pop(agent_id, None)
            removed = True
        path = self.root / f"{agent_id}.md"
        if path.exists():
            path.unlink()
            removed = True
        return removed

    def _seed_default_agents(self) -> None:
        for definition in DEFAULT_AGENT_DEFINITIONS:
            path = self.root / f"{definition['id']}.md"
            if path.exists():
                continue
            self.save_agent(
                agent_id=definition["id"],
                name=definition["name"],
                system_prompt=definition["system_prompt"],
                markdown_context=definition["markdown_context"],
            )

    def _read_agent_file(self, path: Path) -> Optional[Agent]:
        raw_text = path.read_text()
        if not raw_text.strip():
            return None
        text = raw_text
        meta: Dict[str, str] = {}
        body = text
        if text.startswith("---"):
            parts = text.split("---", 2)
            if len(parts) == 3:
                _, fm_text, body = parts
                loaded = yaml.safe_load(fm_text) or {}
                meta = {k: str(v) for k, v in loaded.items()}
                body = body.lstrip("\n")
        agent_id = meta.get("id") or path.stem
        name = meta.get("name") or agent_id
        system_prompt = meta.get("system_prompt") or "You are a helpful agent."
        markdown_context = body
        return Agent(
            id=agent_id,
            name=name,
            system_prompt=system_prompt,
            markdown_context=markdown_context,
        )
