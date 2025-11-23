# Hyperagent Planner Integration Roadmap

## Phase 1 – Planner Foundations

Establish the dedicated planner module so strategic architecture artifacts can be generated consistently. This phase focuses on implementing the orchestrator, agent prompts, and persistence contracts described in `planner.md`, giving us a structured way to transform user inputs into normalized specs, architecture overviews, task DAGs, and implementation guides that downstream systems can trust.

- [ ] Define planner types (requests, outputs, task graphs) and persistence repositories
- [ ] Implement Spec Normaliser, Clarifier, Architect, Task Decomposer, DAG Refiner, and Guidance agent wrappers
- [ ] Build the orchestrator flow with interactive-mode branching and schema validation
- [ ] Add planner storage migrations plus API endpoints for submitting requests and fetching results
- [ ] Write backend tests covering agent orchestration and persistence

## Phase 2 – Workflow & Runtime Integration

With planner outputs available, align the workflow runtime so planned tasks become executable units that carry architectural intent. This phase wires planner task nodes into workflow creation, enriches the executor prompts with implementation guides, and updates repository/workflow views so Hyperagent-generated commits remain traceable to planning decisions.

- [ ] Extend workflow creation API to accept planner task envelopes and metadata
- [ ] Map task DAG nodes into workflow definitions (steps, acceptance criteria, hints)
- [ ] Pass planner guidelines into agent executor prompts and logs
- [ ] Update repository graph + workflow detail views to show planner provenance and guidance links
- [ ] Add integration tests ensuring planner-to-workflow roundtrips succeed

## Phase 3 – Experience Layer & Governance

Surface planning UX in the front end and connect it to governance controls so users can collaborate on plans, answer clarifying questions, and enforce policies. This phase introduces planner pages/modals, visualization of architecture/task DAGs, and policy hooks for approval, while laying groundwork for future meta-agents and template reuse.

- [ ] Create UI flows for submitting planner requests, uploading artifacts, and selecting principles
- [ ] Implement clarifier question handling with conversational and form-based responses
- [ ] Visualize architecture overview (components, flows) and task DAG, with launch actions per task
- [ ] Attach governance metadata (principles, approvals) to planner outputs and enforce via policy engine
- [ ] Document planner usage and update onboarding/training materials
