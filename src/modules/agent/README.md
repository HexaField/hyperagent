# Agent Workflow Definitions

This package hosts the runtime and schemas that power Hyperagent's declarative agent workflows. Workflows are described as JSON (or JSON-compatible `as const` objects) that the orchestrator can load, validate with Zod, and execute deterministically. Each document describes the roles involved, how sessions are created, shared state, prompt templates, and the transitions that determine when a run should advance, exit, or emit a final outcome.

---

## Workflow Document Structure

Every workflow document must satisfy `workflowDefinitionSchema` in `workflow-schema.ts`. These are the top-level fields:

| Field | Required | Description |
| --- | --- | --- |
| `$schema` | optional | Reference to the JSON Schema URL for tooling. |
| `id` | required | Unique identifier string, typically `<name>.<version>`. |
| `description` | optional | Human-readable summary of the workflow's intent. |
| `model` | optional | Default LLM model; callers can override per run. |
| `sessions.roles` | required | Array of role entries describing how to create per-role Opencode sessions. |
| `roles` | required | Map of role name → role definition (system prompt + parser). Must include all role names referenced elsewhere. |
| `state` | optional | Initial key/value store with template-aware values. |
| `flow.bootstrap` | optional | A single verifier step that runs before round 1. |
| `flow.round` | required | Definition of the repeating round (steps array + transitions + default outcome). |

### Sessions

`sessions.roles` defines Opencode sessions that will be created or reused for each run:

```jsonc
{
  "role": "worker",
  "nameTemplate": "{{runId}}-worker"
}
```

* `role` must match a key in the `roles` map.
* `nameTemplate` is optional and can include `{{runId}}` replacements via the same template engine used elsewhere.

### Roles & Parsers

Each entry in `roles` looks like:

```jsonc
{
  "systemPrompt": "You are a meticulous engineer...",
  "parser": "worker" | "verifier" | "passthrough"
}
```

* `systemPrompt` is fed directly to the LLM whenever the role executes a step.
* `parser` selects how responses are coerced:
  * `worker`: expects `{ status, plan, work, requests }` and normalizes missing fields.
  * `verifier`: expects `{ verdict, critique, instructions, priority }`.
  * `passthrough`: leaves the raw JSON payload intact.

### Shared State

`state.initial` is an object whose values are template strings rendered once at run start. Rendered values are stored in the state bag and can be retrieved inside prompts or transitions via `{{state.key}}`.

### Flow Definition

`flow` contains an optional `bootstrap` step and a required `round` object.

#### Bootstrap

* Executes exactly once before the first round.
* Has the same shape as any step (`key`, `role`, `prompt`, optional `stateUpdates`).
* Useful for initial verifier instructions or seeding state.

#### Round

```jsonc
{
  "start": "worker",
  "steps": [ /* ordered workflow steps */ ],
  "maxRounds": 10,
  "defaultOutcome": { "outcome": "max-rounds", "reason": "..." }
}
```

* `start`: the `key` of the first step in each round (defaults to the first step if omitted).
* `steps`: ordered array of step definitions. Each step includes:
  * `key`: unique identifier inside the round.
  * `role`: must map to `roles[role]`.
  * `prompt`: array of template strings rendered and concatenated with double newlines.
  * `next`: hard-coded fallback step key (optional).
  * `stateUpdates`: object of template strings rendered after the step finishes.
  * `transitions` / `exits`: arrays of conditional transitions (see below).
* `maxRounds`: optional numeric cap; callers can also override when starting a run.
* `defaultOutcome`: fallback outcome when the round never triggers an exit.

### Template Rendering

Prompt sections, state initializers, `stateUpdates`, and transition `reason` fields all support handlebars-style expressions:

* `{{user.instructions}}`, `{{run.id}}`, `{{round}}`, `{{maxRounds}}` reference built-in scope values.
* `{{steps.worker.raw}}` accesses the raw JSON emitted by a prior step within the same round.
* `{{parsed.instructions}}` refers to the parsed payload of the current step.
* Literal strings can provide fallbacks using `||`, e.g. `{{parsed.instructions||state.pendingInstructions}}`.

### Transitions & Exits

Transitions determine whether a step loops, advances, or finishes the run.

```jsonc
{
  "condition": { "field": "parsed.status", "equals": "blocked" },
  "outcome": "failed",
  "reason": "{{parsed.requests}}",
  "stateUpdates": { "latestCritique": "{{parsed.requests}}" }
}
```

* `condition` can be:
  * `'always'`
  * A field comparison (`field` + comparators such as `equals`, `notEquals`, `includes`, `matches`, `in`, `exists`, etc.).
  * Logical combinators: `{ any: [ ...conditions ] }` or `{ all: [ ...conditions ] }`.
  * `field` values prefixed with `@` read from the global scope instead of the current step (e.g. `@state.pendingInstructions`).
* A transition must specify either `nextStep` or `outcome`.
* If `outcome` is set, `reason` becomes mandatory and is template-rendered.
* `stateUpdates` borrow the same templating rules; they run only when the transition fires.
* `transitions`: evaluated first; if none match, the orchestrator falls back to `next` or step order.
* `exits`: evaluated after transitions and typically used to emit final outcomes.

### Parsers & Typed Results

The orchestrator infers the shape of each turn's `parsed` payload from the `parser` declared on that role. For example, a `worker` role yields:

```jsonc
{
  "status": "working" | "done" | "blocked",
  "plan": string,
  "work": string,
  "requests": string
}
```

When defining workflows in TypeScript (`*.workflow.ts`), use `as const` on the document and export it as `satisfies AgentWorkflowDefinition`. The orchestrator will then compile with full literal types, enabling consumers to strongly type rounds and turns without casting.

### Validation & Tooling

* Validation is performed via Zod (`workflowDefinitionSchema.parse`). Hydration will throw if any structural rule is violated (duplicate step keys, invalid references, missing reasons, etc.).
* Keep workflow sources JSON-compatible so they can be serialized into configuration bundles or runtime assets.
* Use `runAgentWorkflow` with the validated definition to execute real runs, and `getWorkflowRunDiff` to inspect resulting file diffs for a specific role.

### Reference Example

```json
{
  "id": "verifier-worker.v1",
  "sessions": { "roles": [{ "role": "worker" }, { "role": "verifier" }] },
  "roles": {
    "worker": { "systemPrompt": "...", "parser": "worker" },
    "verifier": { "systemPrompt": "...", "parser": "verifier" }
  },
  "state": {
    "initial": {
      "pendingInstructions": "{{user.instructions}}",
      "latestCritique": ""
    }
  },
  "flow": {
    "bootstrap": { "key": "bootstrap", "role": "verifier", "prompt": ["..."] },
    "round": {
      "start": "worker",
      "steps": [ /* worker + verifier definitions */ ],
      "maxRounds": 10,
      "defaultOutcome": {
        "outcome": "max-rounds",
        "reason": "Verifier never approved within {{maxRounds}} rounds"
      }
    }
  }
}
```

### Authoring Checklist

1. Pick a stable `id` and version suffix.
2. Enumerate every role and ensure prompts + parsers are accurate.
3. Define session templates for each role.
4. Seed any shared state needed across steps.
5. Lay out bootstrap and round steps with clear prompts and `stateUpdates`.
6. Encode transitions/exits for every completion or failure path.
7. Validate with `workflowDefinitionSchema` (or run `hydration` via `workflows/index.ts`).
8. Ship alongside integration tests that exercise the orchestrator with realistic instructions.

By adhering to this structure, you can describe new agent collaborations purely through JSON without writing bespoke orchestration code, keeping behavior consistent and testable throughout the platform.
