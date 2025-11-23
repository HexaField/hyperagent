# Foundational Capabilities

## 1. Substrate Definition

The substrate is a versioned, typed graph workspace where every entity—agents, data, humans, policies—is modeled as a composable node connected through declarative, schema-driven edges. It stores:

- Immutable graph snapshots with diff history and provenance metadata.
- Typed ports describing inputs, outputs, cost/safety tags, and side-effect scopes.
- Execution traces and artifacts bound directly to their producing nodes.
- Shared memory objects (documents, embeddings, metrics) referenced as first-class graph nodes. This substrate acts as the single source of truth for intent (natural language), structure (graph), execution (runtime plans), and governance (policies).

## 2. Core Primitives

1. **Node**: Typed capability definition (agent, tool, human role, dataset, memory) with declarative IO, configuration schema, and policy tags.
2. **Edge**: Verified contract linking node ports; carries dataflow semantics, trigger conditions, fan-out/fan-in hints, and failure handling policies.
3. **Graph Snapshot**: Immutable state of all nodes/edges, versioned with lineage, supporting branching, merging, and reusable subgraph packaging.
4. **Context Object**: Structured state passed through executions (run context, shared memory references, auth handles) with deterministic replay metadata.
5. **Policy Guard**: Declarative rule evaluated against node/edge operations; enforces permissions, scopes, cost limits, and approval requirements.
6. **Trace Artifact**: Signed record of execution (inputs, outputs, latencies, approvals) anchored to the producing nodes and edges for auditability.
7. **Template/Subgraph**: Parameterized bundle of nodes/edges treated as a reusable primitive with published interfaces and governance metadata.

## 3. Foundational Capability Families

1. **Graph Authoring & Versioning**
   - Real-time canvas editing with presence overlays.
   - Natural-language-to-graph synthesis and diff explanations.
   - Branching, merging, and rollback using immutable snapshots.

2. **Type & Policy Compilation**
   - Static validation of node schemas, edge compatibility, and policy compliance.
   - Automatic propagation of safety tags and required approvals.
   - Compilation of declarative graphs into executable plans with deterministic ordering.

3. **Runtime Orchestration**
   - Event-driven scheduler supporting triggers, cron, and manual runs.
   - Parallel fan-out/fan-in execution with retries, backoff, and circuit breaking.
   - Context manager for scoped state, secrets, and shared memory hydration.

4. **Capability/Adapter Registry**
   - Manifest-driven onboarding for atomic, composite, and meta-agents.
   - Declarative adapter layer exposing CRUD/query/action blocks with typed IO.
   - Cost, latency, and safety annotations consumable by compiler and UI.

5. **Human-in-the-Loop Coordination**
   - Human role nodes with explicit permissions and approval workflows.
   - Declarative routing rules (threshold-based, confidence-based) into review queues.
   - Presence, commenting, and notification channels tied to graph elements.

6. **Observation & Memory**
   - Trace engine capturing structured logs, metrics, artifacts per execution.
   - Persistent memory nodes (documents, embeddings, datasets) with lineage links.
   - Simulation harness for replaying runs and injecting failures.

7. **Governance & Safety**
   - Policy engine enforcing attribute- and context-aware rules at compile and run time.
   - Sandboxing tiers (dry-run, read-only, isolated data) applied per node or subgraph.
   - Audit trail with tamper-evident records of edits, executions, approvals, and policy decisions.

8. **Meta-Optimization**
   - Meta-agents analyzing graphs for cost, performance, and reliability improvements.
   - Suggestion pipeline producing structured diffs that flow back into authoring tools.
   - Knowledge base of accepted optimizations and templates for future reuse.
