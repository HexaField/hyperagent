## 1. Core vision

A shared, infinite workspace where:

- Users and AI agents coexist as first-class collaborators.
- Any tool, API, or data source can be “plugged in” on the fly.
- Work is expressed as a living graph of agents, data, and workflows.
- You can create, edit, and run that graph via natural language and direct manipulation.

Think of it as: “Figma + Zapier + GitHub Copilot + Notion + Replit” sitting on top of a dynamic AI runtime that can spawn and orchestrate arbitrarily many agents.

The key tie-in to hyperproductivity: the system is designed so that the _main work_ is improving the graph (automation, coordination, reuse) rather than executing individual tasks.

---

## 2. Conceptual architecture

### 2.1 Substrate: the “infinite workspace”

- A 2D (or 3D) canvas where:
  - Nodes = agents, tools, data objects, workflows, documents.
  - Edges = data flows, triggers, constraints, dependencies.

- Time dimension:
  - The workspace is versioned over time; you can rewind, branch, and compare past graphs.
  - Each run of a workflow is a trace layered on the graph.

This is the primary object of collaboration: the graph itself.

### 2.2 Pluggable agents

Treat every “capability” as an agent:

- Atomic agents:
  - Call a single API (Slack, GitHub, Notion, internal service).
  - Run a function (code execution, query DB, transform data).
  - Use a specific foundation model or tool (vision, speech, code, planning).

- Composite agents:
  - A saved subgraph (a reusable workflow or “macro”).
  - A “role” (e.g., “Research Assistant”, “QA Reviewer”) backed by one or more models and tools.

- Meta-agents:
  - Agents whose job is to inspect, modify, and improve the graph itself (optimize, refactor, benchmark).

Everything is interchangeable: you should be able to swap a model, data source, or tool without changing the entire system.

### 2.3 Integrations as adapters

Each external system is exposed as a set of typed capabilities:

- “Blocks” for:
  - CRUD on resources (e.g., GitHub issues, tickets, CRM contacts).
  - Queries (search, list, filter).
  - Actions (post message, run deployment, create PR).

- Standard contract:
  - Input/Output schemas, cost/time hints, safety tags (e.g., “read-only”, “high-impact”, “requires approval”).

Agents use these adapters rather than talking to APIs directly. The graph editor exposes them visually; the language interface exposes them semantically (“Connect to our Jira project and show me all P1 issues from the last week”).

### 2.4 Orchestration & runtime

A scheduler that:

- Executes the graph:
  - Event-driven (on triggers, webhooks).
  - On demand (user click, chat command).
  - On schedule (CRON-like).

- Manages state:
  - Short-term: per-run context.
  - Long-term: memory objects on the canvas (documents, vectors, logs, metrics).

- Handles parallelism:
  - Run agents concurrently where dependencies allow.
  - Fan-out/fan-in patterns (e.g., 50 research agents, then a synthesizer).

This is where “hyperproductivity” emerges: the same graph can run many times, with continuous improvement.

---

## 3. Interaction model: language + graph

### 3.1 Natural language as the primary “compiler”

You describe what you want; the system drafts a graph.

Examples:

- “Set up a daily report that pulls yesterday’s sales, correlates with support tickets, and posts a summary in #ops.”
- “Create a workflow that watches our GitHub repo and comments on PRs that lack tests.”

The system:

1. Parses the request.
2. Proposes a draft graph:
   - Nodes: “Fetch sales from X”, “Fetch tickets from Y”, “Join”, “Summarize”, “Post to Slack”.

3. Shows it visually for confirmation/editing.
4. Asks for missing config only when necessary (auth, rate limits, specific filters).

Language becomes the UX for “program synthesis” of the graph.

### 3.2 The graph as the source of truth

The workspace is always consistent with the conversational interface:

- Edits in the graph update what the agents do.
- Edits in chat (e.g., “split this step into two”, “add a reviewer”) update the graph.
- You can say “explain this workflow” and get a narrative of the nodes and edges.

This avoids a common failure mode where “chat” and “actual configuration” drift apart.

---

## 4. Collaboration

### 4.1 Multi-user

- Multiple users can see and edit the graph in real time (like a whiteboard).
- Presence: see who is editing which part.
- Comments on nodes, edges, runs.
- Permissions:
  - Per-node: “this node can only be edited by SRE”.
  - Per-capability: “only owners can add nodes that deploy to production”.

### 4.2 Human roles as nodes too

Treat humans as special agents:

- “Alice” node:
  - Capabilities: approve deployment, review legal text, sign off financial changes.

- Workflows can explicitly route to human nodes:
  - “If the change is > $X, route to CFO node for approval.”
  - “If summary confidence < threshold, route to human editor.”

This binds hyper-automation to real accountability.

---

## 5. Hyperproductivity as a system property

### 5.1 Compounding automation

Every time you solve a problem, you have the opportunity to:

- Capture it as a reusable subgraph.
- Generalize it and parameterize it.
- Expose it as a new “agent” or “template” in a library.

So over time:

- The “unit cost” of a new workflow drops.
- The “time from idea to automation” shrinks.
- Teams spend more cycles improving existing graphs than executing manual workflows.

### 5.2 Meta-optimization loops

Build in agents whose sole job is to improve the graph:

- Performance optimizer:
  - Analyzes logs, identifies bottlenecks, suggests parallelization or caching.

- Cost optimizer:
  - Proposes swapping models, batching calls, pruning unnecessary steps.

- Robustness checker:
  - Simulates failures, proposes error-handling steps.

These agents propose changes as PRs to the graph:

- You see diffs of the workflow, not just code:
  - Added retries.
  - Split a large monolithic node into smaller ones.
  - Replaced 10 serial calls with a fan-out.

This is the hyperproductivity pattern generalized: the system improves itself, with humans in the loop.

---

## 6. Safety, governance, and policy

To make “infinite agents + infinite integrations” sane:

- Policy engine:
  - `who` can use `what` capability, `where`, and `with what limits`.
  - E.g. “No agent can move money without approval from a human node.”

- Sandboxes:
  - New or untrusted workflows run in a safe environment with read-only access or synthetic data.

- Audit trail:
  - Every run has a trace:
    - Inputs, outputs, decisions, approvals, errors, rollbacks.

  - Viewable on the graph as a path highlight.

This allows very aggressive automation without losing control.

---

## 7. Practical roadmap (high level)

If you were to build toward this:

1. Start narrow:
   - One workspace, one team, a handful of high-value agents/integrations.
   - Graph editor + chat interface that stay in sync.

2. Nail the “graph synthesis from language” loop:
   - Let users describe workflows and iteratively refine the generated graph.

3. Add persistence and reuse:
   - Subgraphs as reusable components.
   - Template library.

4. Introduce meta-agents:
   - Start with simple suggestions: “this step can be parallelized”, “this API call is failing often”.

5. Layer in collaboration and governance:
   - Multi-user editing, permissions, approvals.

6. Scale integrations and agent types:
   - Make it easy for 3rd parties (or internal teams) to publish new agents into the ecosystem.

---

## 8. Local HTTPS setup

- Run `npm run certs:generate` once to create `certs/hyperagent.cert.pem` and `certs/hyperagent.key.pem`. The directory is gitignored so every developer manages their own keys.
- `UI_TLS_CERT_PATH` / `UI_TLS_KEY_PATH` override the UI server certificates; `VITE_TLS_CERT_PATH` / `VITE_TLS_KEY_PATH` do the same for the Vite dev server (both default to the generated files).
- When running workflows or proxies via Docker, mount or copy the certificate bundle so other services can trust the HTTPS-only UI endpoints.
