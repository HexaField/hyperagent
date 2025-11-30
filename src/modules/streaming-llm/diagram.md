Below is a clean **architecture + flow diagram** for the system you described, expressed as both:

1. A **logical architecture diagram** (components + responsibilities)
2. A **runtime flow diagram** (what happens when a user sends a message)

Both are written in Mermaid so you can paste them into Markdown, GitHub, or any Mermaid-enabled editor.

---

# 1. Architecture Diagram (Components)

```mermaid
flowchart TB

User["User (Web UI)"]
UI[Streaming Chat UI]
TS[TypeScript Client SDK]

User --> UI
UI --> TS

TS -->|WebSocket / HTTP| Gateway[API Gateway]

Gateway --> Orchestrator

Orchestrator --> Log[(Central Event Log)]
Orchestrator --> TaskDB[(Task Graph / State)]
Orchestrator --> Summaries[(Rolling Summaries)]

Orchestrator -->|assign tasks| Coder[Coder Agent]
Orchestrator -->|assign tasks| Search[Search Agent]
Orchestrator -->|assign tasks| RAG[RAG Agent]
Orchestrator -->|assign tasks| Other[Other Knowledge Agents]

Coder -->|updates| Log
Search -->|updates| Log
RAG -->|updates| Log
Other -->|updates| Log

Orchestrator -->|context| StreamingLLM[Streaming LLM Interface Engine]

StreamingLLM -->|narration| Orchestrator
StreamingLLM -->|instructions| Orchestrator

Orchestrator -->|stream responses| Gateway
Gateway --> UI
```

---

# 2. Runtime Flow Diagram (What happens per message)

This diagram shows the flow when a user sends something.

```mermaid
sequenceDiagram
participant User
participant UI
participant Orchestrator
participant Log
participant LLM as StreamingLLM
participant Agents as Knowledge Agents

User->>UI: Enters message
UI->>Orchestrator: USER_MESSAGE
Orchestrator->>Log: Append event

Orchestrator->>LLM: Controller Mode (user + current state)
LLM-->>Orchestrator: Actions + optional user_message

Orchestrator->>Log: Append NARRATION (if any)
Orchestrator->>Agents: Assign tasks (code, search, RAG, etc.)

loop While agents work
    Agents-->>Log: AGENT_UPDATE / AGENT_RESULT
    Orchestrator->>Log: Store updates

    Orchestrator->>LLM: Narrator Mode (new events + summaries)
    LLM-->>Orchestrator: speak_now? + message

    alt speak_now = true
        Orchestrator->>Log: Append NARRATION
        Orchestrator->>UI: Stream output
    else speak_now = false
        Note over Orchestrator: No user output
    end
end
```

---

# 3. Attention and Gating Flow

This is the diagram for **how attention + response decisions are made**:

```mermaid
flowchart TD

Event[New Event in Log] --> Orchestrator

Orchestrator --> Decide{Is this important?}

Decide -->|User message| Controller
Decide -->|Agent result| Narrator
Decide -->|Low priority| Ignore

Controller -->|Build snapshot| LLM1["StreamingLLM (Controller Mode)"]
Narrator -->|Build delta| LLM2["StreamingLLM (Narrator Mode)"]

LLM1 --> Instr[Task Instructions]
LLM1 --> OptionalUserMsg[Optional User Message]

LLM2 --> Gating{Speak now?}

Gating -->|Yes| Output[NARRATION]
Gating -->|No| Silence[(Silent)]

Output --> Log
Silence --> Log

Instr --> TaskQueue
```

---

# 4. Data ownership diagram

Shows who owns what:

```mermaid
flowchart LR

UI[Web UI] -->|"User Input"| Orchestrator
Orchestrator --> CentralLog[(Central Log)]

Agents --> CentralLog
StreamingLLM --> CentralLog

Orchestrator --> TaskGraph[(Task Graph)]
Orchestrator --> Summaries[(Summaries)]
Orchestrator --> ContextBuilder[(Context Selector)]

CentralLog --> ContextBuilder
TaskGraph --> ContextBuilder
Summaries --> ContextBuilder

ContextBuilder --> StreamingLLM
StreamingLLM --> Orchestrator
```

---

# 5. One-sentence summary diagram

High-level intuition:

```mermaid
graph LR
User -->|talks to| StreamingLLM
StreamingLLM -->|commands| Orchestrator
Orchestrator -->|assigns| Agents
Agents -->|report to| Log
Log -->|feeds| StreamingLLM
```

---

# 6. Short explanation to match the diagrams

* The **central log** is the system memory.
* The **orchestrator** is the brain that routes tasks and feeds context.
* The **StreamingLLM** is not a chatbot — it is:

  * a controller,
  * a narrator,
  * a gatekeeper.
* Knowledge agents are workers, not speakers.
* The UI only sees what the narrator chooses to surface.

---

# 7. Next if you want diagrams with control signals and data types

I can also generate:

* A formal **state machine diagram** for task lifecycle.
* A component-level **folder / process layout**.
* A protocol diagram (WebSocket messages, agent messages, log records).
* A concrete JSON schema diagram for:

  * Event log
  * Tasks
  * LLM commands

Just say which one you want next.
