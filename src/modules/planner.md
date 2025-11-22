Below is a concrete design you can implement as a new module (e.g. `src/modules/planner.ts`), compatible with your existing “agents call LLMs with roles and prompts” setup.

I’ll break it into:

1. Responsibilities and outputs
2. Data model (types you can lift into your code)
3. Planning agents and their prompts/roles
4. Orchestration flow (including human-in-the-loop vs fully autonomous)
5. How to feed outputs into your existing coding agents
6. Extensions for existing projects / repo-aware planning

---

## 1. Responsibilities and outputs

New module: “Planning/Architecture Multi-Agent” (call it `planner`).

Input:

* One or more user artifacts: ADR(s), PRD, project plan, or free-form idea.
* Architectural principles: e.g. `["modular", "composable", "declarative functional", "event-driven", "CQRS", …]`.
* Mode: `interactive` (ask user questions) or `autonomous`.
* Optional: context about existing codebase (files list, key modules, tech stack).

Output:

* Normalised problem spec (what we’re trying to build/change).
* Architecture overview:

  * Context diagram (high-level).
  * Logical components (services, modules, data stores, boundaries).
  * Interface contracts (public APIs, events, data models).
  * Non-functionals relevant to architecture (perf, security, etc).
* Task DAG:

  * Nodes = tasks with detailed description, acceptance criteria, scope of code changes.
  * Edges = explicit dependencies (“B depends on A’s API”, “Migrate schema before update code”, etc).
* Implementation guidance package:

  * Coding guidelines tailored to the project + principles (patterns, anti-patterns).
  * File/module layout suggestions.
  * “Design decisions log” that coding agents must respect.

Everything should be serialisable to JSON and easy to feed into your existing instructor/worker pipeline.

---

## 2. Data model

You can refine, but this gives you a concrete starting point.

```ts
// High-level module API
export type PlanningMode = "interactive" | "autonomous";

export interface PlanningRequest {
  id: string;
  userArtifacts: {
    type: "ADR" | "PRD" | "PLAN" | "IDEA";
    title?: string;
    content: string;
  }[];
  architecturalPrinciples: ArchitecturalPrinciple[];
  mode: PlanningMode;
  // For existing projects
  codebaseContext?: CodebaseContext;
  // User-provided constraints
  constraints?: {
    techStack?: string[];
    deadline?: string;
    maxParallelTasks?: number;
  };
}

export interface ArchitecturalPrinciple {
  id: string;             // e.g. "modularity"
  name: string;           // "Modularity"
  description: string;    // “Prefer small, independently deployable services…”
  priority?: "must" | "should" | "nice-to-have";
}

export interface CodebaseContext {
  repoUrl?: string;
  summary?: string;       // output of a summariser over the repo
  keyModules?: string[];  // e.g. ["web/api", "core/domain", "infra/db"]
  techStack?: string[];   // e.g. ["Next.js", "Node", "Postgres", "Redis"]
}

export interface PlanningOutput {
  requestId: string;
  normalizedSpec: NormalizedSpec;
  questionsForUser?: PlannerQuestion[];
  architecture: ArchitectureOverview;
  taskGraph: TaskGraph;
  implementationGuides: ImplementationGuides;
}

export interface NormalizedSpec {
  projectName: string;
  summary: string;
  goals: string[];
  nonGoals: string[];
  stakeholders: string[];
  constraints: {
    techStack?: string[];
    performance?: string;
    security?: string;
    compliance?: string;
    other?: string[];
  };
  inputArtifactsTrace: {
    sourceType: "ADR" | "PRD" | "PLAN" | "IDEA";
    title?: string;
    importantExcerpts: string[];
  }[];
}

export interface PlannerQuestion {
  id: string;
  question: string;
  rationale: string;
  // optional set of suggested answers to make UI easier
  options?: string[];
  required: boolean;
}

// Architecture representation
export interface ArchitectureOverview {
  contextDiagram: string;       // text description + maybe pseudo-ASCII diagram
  components: ComponentSpec[];
  dataModels: DataModelSpec[];
  flows: FlowSpec[];            // end-to-end flows / sequence diagrams in text
  nonFunctionalNotes: string[];
}

export interface ComponentSpec {
  id: string;
  name: string;
  responsibility: string;
  type: "service" | "module" | "package" | "library" | "job" | "ui-feature" | "other";
  inboundInterfaces: InterfaceSpec[];
  outboundInterfaces: InterfaceSpec[];
  principlesApplied: string[];  // IDs from ArchitecturalPrinciple
  notes?: string;
}

export interface InterfaceSpec {
  id: string;
  name: string;
  kind: "http" | "rpc" | "event" | "db" | "internal-function" | "cli" | "other";
  direction: "inbound" | "outbound";
  description: string;
  payloadShape?: string;        // pseudo-schema
}

export interface DataModelSpec {
  name: string;
  description: string;
  fields: { name: string; type: string; description?: string }[];
  invariants?: string[];
}

export interface FlowSpec {
  name: string;
  description: string;
  steps: string[];              // sequence of high-level steps
}

// Task DAG
export type TaskId = string;

export interface TaskGraph {
  tasks: TaskNode[];
  edges: TaskEdge[];            // each edge: from -> to
}

export interface TaskNode {
  id: TaskId;
  title: string;
  description: string;

  // For coding agents
  acceptanceCriteria: string[];
  implementationHints: string[];
  principlesToEmphasise: string[];   // e.g. ["modularity", "functional"]

  // Scope and impact
  kind: "architecture" | "scaffolding" | "feature" | "refactor" | "test" | "infra" | "documentation";
  touchesFiles?: string[];          // suggestions: "web/src/routes/*", "core/domain/user.ts"
  producesArtifacts?: string[];     // e.g. ["Design Decision: API shape of /v1/orders", "Migration script"]

  // For scheduling
  estimatedEffort?: "XS" | "S" | "M" | "L";
  canRunInParallel?: boolean;
}

export interface TaskEdge {
  from: TaskId;
  to: TaskId;                       // "to" depends on "from"
  rationale?: string;
}

export interface ImplementationGuides {
  codingGuidelines: string;         // patterns & anti-patterns
  fileLayoutSuggestions: string;
  testingStrategy: string;
  reviewChecklist: string;          // for your instructor/verifier
  glossary: { term: string; meaning: string }[];
}
```

You can hide a lot of this behind a smaller public API, but having explicit types will keep the module stable and useful for other agents.

---

## 3. Planning agents and their roles

Implement each “agent” as a specialised call to your model backend, using your existing abstraction (whatever you use in `agent.ts` for instructor vs worker).

Suggested set for this module:

1. **Spec Normaliser Agent**

   * Input: raw user artifacts + principles.
   * Output: `NormalizedSpec`.
   * Prompt role:

     * Extract goals, non-goals, constraints.
     * Merge multiple docs.
     * Explicitly record tradeoffs implied by principles (e.g. “modularity” vs “latency”).

2. **Clarifier Agent** (only active in interactive mode)

   * Input: `NormalizedSpec` and principles.
   * Output: list of `PlannerQuestion`s.
   * Prompt role:

     * Ask only questions that materially affect architecture/plan.
     * Prefer multiple-choice suggestions where possible.
     * Tag questions `required = true` if impossible to proceed without.

   Your orchestrator then returns these questions to the caller. Once user answers, you re-run the Spec Normaliser with the additional answers as another input artifact.

3. **Architect Agent**

   * Input: `NormalizedSpec`, architectural principles, and optional codebase context.
   * Output: `ArchitectureOverview`.
   * Prompt role:

     * Propose components and boundaries respecting principles.
     * Explicitly flag where principles conflict and what tradeoff is chosen.
     * Generate interface contracts and core data models.
     * Produce a few canonical flows from user persona through system.

4. **Task Decomposer Agent**

   * Input: `NormalizedSpec`, `ArchitectureOverview`, and principles.
   * Output: initial `TaskGraph` (tasks + edges).
   * Prompt role:

     * Decompose into smallest reasonably independent tasks.
     * Tag tasks with type (`refactor`, `feature`, `infra`, etc).
     * Explicitly mark tasks that unblock many others (roots) and tasks at the leaves.
     * Provide acceptance criteria geared to your coding agent style (tests, doc, invariants).

5. **DAG Refiner / Verifier Agent**

   * Input: candidate `TaskGraph` + architecture + principles.
   * Output: revised `TaskGraph` plus notes (or diff-like suggestions).
   * Prompt role:

     * Check for missing prerequisites (e.g. migrations before code changes).
     * Merge or split tasks that are too coarse/fine.
     * Ensure each task has explicit acceptance criteria.
     * Ensure all key requirements/goals are covered by at least one task.

   You can reuse the same “instructor/verifier” pattern you use for coding here: Task Decomposer as “worker”, DAG Refiner as “instructor”. That keeps your mental model consistent.

6. **Guidance Generator Agent**

   * Input: `ArchitectureOverview`, final `TaskGraph`, `NormalizedSpec`, principles.
   * Output: `ImplementationGuides`.
   * Prompt role:

     * Produce short, actionable guidelines for coding agents.
     * Generate a checklist that your instructor can use per task.
     * Generate a glossary for domain terms to avoid inconsistent naming.

---

## 4. Orchestration flow

Design the planner as a single orchestrator function that coordinates those agents.

### 4.1. Entry point

```ts
export async function runPlanningModule(
  req: PlanningRequest,
  options?: { maxIterations?: number }
): Promise<PlanningOutput> {
  // skeleton, see steps below
}
```

### 4.2. Core steps

Assuming you have some generic `runAgent`/`callModel` utilities already:

1. **Normalise input**

   * Concatenate/summarise user artifacts into a model-friendly context (or chunk and summarise first, if large).
   * Call **Spec Normaliser Agent** → `normalizedSpec`.

2. **Interactive clarification (if mode = "interactive")**

   * Call **Clarifier Agent** → `questions`.

   * If `questions` contains any `required: true`:

     * Return early to the caller with `PlanningOutput` where:

       * `questionsForUser = questions`
       * `architecture`, `taskGraph`, `implementationGuides` are either omitted or placeholder.
     * Your front-end collects answers and calls `runPlanningModule` again, treating answers as another `userArtifact` of type `"IDEA"` (or `"PLAN"`) titled `“Clarification answers <timestamp>”`.

   * If mode = "autonomous": skip this and instruct Spec Normaliser + Architect to make reasonable assumptions and explicitly document them in `normalizedSpec.nonGoals` and notes.

3. **Architecture synthesis**

   * Call **Architect Agent** with:

     * `normalizedSpec`
     * `architecturalPrinciples`
     * `codebaseContext` (if any).
   * Receive `architecture`.

4. **Task decomposition**

   * Call **Task Decomposer Agent** → `initialTaskGraph`.

5. **DAG refinement / verification**

   * Call **DAG Refiner Agent** with `normalizedSpec`, `architecture`, `initialTaskGraph`.
   * It can output:

     * `finalTaskGraph` (possibly same as input) and
     * `notes` (you may embed in `ImplementationGuides.reviewChecklist` or attach to tasks).
   * Optionally run a small deterministic post-processor in code:

     * Validate no cycles.
     * Topologically sort tasks and add `canRunInParallel` flags from structure.

6. **Implementation guidance**

   * Call **Guidance Generator Agent** → `implementationGuides`.

7. **Return assembled `PlanningOutput`**

   * Put everything into the structured format shown earlier.

Pseudo-code sketch:

```ts
export async function runPlanningModule(req: PlanningRequest): Promise<PlanningOutput> {
  const normalizedSpec = await runSpecNormaliserAgent(req);

  const questions =
    req.mode === "interactive"
      ? await runClarifierAgent(normalizedSpec, req.architecturalPrinciples)
      : [];

  if (req.mode === "interactive" && questions.some(q => q.required)) {
    return {
      requestId: req.id,
      normalizedSpec,
      questionsForUser: questions,
      architecture: null as any,
      taskGraph: { tasks: [], edges: [] },
      implementationGuides: {
        codingGuidelines: "",
        fileLayoutSuggestions: "",
        testingStrategy: "",
        reviewChecklist: "",
        glossary: [],
      },
    };
  }

  const architecture = await runArchitectAgent(normalizedSpec, req);
  const initialTaskGraph = await runTaskDecomposerAgent(normalizedSpec, architecture, req);
  const finalTaskGraph = await runDagRefinerAgent(normalizedSpec, architecture, initialTaskGraph, req);
  const implementationGuides = await runGuidanceGeneratorAgent(normalizedSpec, architecture, finalTaskGraph, req);

  return {
    requestId: req.id,
    normalizedSpec,
    architecture,
    taskGraph: finalTaskGraph,
    implementationGuides,
  };
}
```

Each `runXxxAgent` is basically a thin wrapper that:

* Assembles a system prompt summarising role and principles.
* Feeds relevant parts of `req` and previous outputs into the chat.
* Parses the model’s JSON (`zod` schema recommended) into typed objects.

---

## 5. Feeding this into your existing coding agents

You already have instructor + worker coding agents. The planner’s output should become their “global context” plus per-task envelopes.

### 5.1. Task envelopes

Define a type:

```ts
export interface TaskExecutionEnvelope {
  requestId: string;
  taskId: TaskId;
  task: TaskNode;
  architecture: ArchitectureOverview;
  normalizedSpec: NormalizedSpec;
  implementationGuides: ImplementationGuides;
}
```

The executor for coding work will:

1. Choose the next task to run:

   * Perform a topological sort.
   * Pick tasks whose dependencies (`edges.from`) are completed.
   * Respect `maxParallelTasks` from `req.constraints`.

2. For each task, construct `TaskExecutionEnvelope` and pass it to your existing “coding module” which wraps instructor + worker:

   * Instructor prompt includes:

     * summary of architecture
     * specific task details
     * implementation guides
   * Worker prompt includes:

     * same, but with explicit “Your job is to implement X” and references to files to touch.

3. On completion or failure:

   * Mark task as done/failed in orchestrator state.
   * If task outputs additional design decisions or doc, feed them back as new artifacts for later tasks (for example, codegen tasks depending on docs tasks).

You can maintain a simple runtime state:

```ts
export interface TaskRuntimeState {
  status: "pending" | "running" | "done" | "failed";
  resultSummary?: string;
  error?: string;
}
```

And a `Record<TaskId, TaskRuntimeState>` for your executor to keep track.

### 5.2. Instructor/worker awareness of principles

* Prepend architectural principles, `ImplementationGuides.codingGuidelines`, and the `TaskNode.principlesToEmphasise` into every instructor and worker system prompt.
* The planner becomes the single source of truth for those constraints.

---

## 6. Handling existing projects and incremental changes

To support “modify an existing project”:

1. **Codebase summariser module (optional but helpful)**

   * Separate module that:

     * Crawls the repo or uses a file list.
     * Produces:

       * High-level summary (`CodebaseContext.summary`).
       * Key modules and their responsibilities.
       * Known tech stack and dependencies.
   * The summariser’s output becomes `codebaseContext` when calling the planner.

2. **Planner behaviour differences**

   * Spec Normaliser should detect “change vs greenfield”:

     * If ADR/PRD refers to existing features, tag them explicitly.
   * Architect Agent:

     * Should prefer “fit into existing architecture” over “redesign everything”.
     * Mark new components vs modified components.
   * Task Decomposer:

     * For existing code, tasks should be more `refactor`/`migration` oriented and must reference existing modules/files in `touchesFiles`.

3. **Maintaining a design decision log**

   * In addition to architecture doc, keep a simple list of decisions:

     * `Decision: “Use event-driven integration between service A and B instead of direct RPC because …”`
   * Each coding task that touches that area should have those decisions embedded into its `implementationHints` so your workers do not contradict earlier choices.

---

## 7. Human-in-the-loop vs fully autonomous

Concrete mechanics:

* In interactive mode:

  * You may run multiple rounds:

    * Round 1: Normaliser + Clarifier → questions.
    * User answers.
    * Round 2: Normaliser again (with answers as new artifact) → architecture + DAG.
  * You can optionally allow a “review architecture” step:

    * Present `ArchitectureOverview` to user.
    * Accept feedback, which you add as a new artifact `type: "ADR"` or “IDEA”.
    * Re-run only the Task Decomposer + DAG Refiner based on updated architecture.

* In autonomous mode:

  * Clarifier is disabled, or run in “self-answering” mode where the agent:

    * Poses questions.
    * Answers them with best guesses.
    * Records them in `normalizedSpec.nonGoals` or `constraints.other`.
  * This is useful for batch or headless runs where you still want clarity but no user.

Implementation detail:

* Mode is just `req.mode` and you control which steps run.
* The planner can surface “assumptions made” in `ImplementationGuides.reviewChecklist` for later human review even if it ran autonomously.

---

This design should be directly implementable as a new module in your repo:

* Define the types in a shared `types.ts`.
* Implement `runPlanningModule` in `modules/planner.ts`.
* Implement each `runXxxAgent` using the same pattern you use in `agent.ts` for instructor/worker, with role-specific system prompts.
* Wire it into your top-level flow so that:

  * For a new project or change, you first call `runPlanningModule`.
  * Then use `PlanningOutput.taskGraph` to drive your existing coding agents task-by-task.
