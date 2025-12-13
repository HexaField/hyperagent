# Agent Workflows

This package contains predefined agent workflows and the orchestrator function to run them. Workflows are defined as JSON Schema documents that specify roles, sessions, state, prompt templates, and transitions. The orchestrator loads, validates, and executes these workflows deterministically.

Internally, opencode is used to run coding-agent style agents with file read & write access. Zod is used for schema validation and the package supports extensible parsers for role responses.

## Provided Workflows

- `simpleWorkerWorkflowDefinition`: A single-role workflow where a worker produces content based on user instructions.
- `verifierWorkerWorkflowDefinition`: A two-role workflow where a worker generates content and a verifier reviews it for quality and adherence to instructions.
- `workflowCreateWorkflowDocument`: A meta-workflow that generates new workflow definitions based on provided requirements.

## Running Workflows

Use `runAgentWorkflow` with a validated definition. Minimal example:

```ts
import { runAgentWorkflow, verifierWorkerWorkflowDefinition } from '@hexafield/agent-workflow'

const run = await runAgentWorkflow(verifierWorkerWorkflowDefinition, {
  userInstructions: 'Create README content',
  sessionDir: '/abs/path/to/workdir',
  model: 'github-copilot/gpt-5-mini', // optional override
  maxRounds: 5, // optional override of definition
  onStream: (event) => console.log(event.step, event.round, event.parts.length)
})

const result = await run.result
console.log(result.outcome, result.reason)
```

Options: `userInstructions` (required), `sessionDir` (required), `model?`, `maxRounds?`, `onStream?`, `workflowId?`, `workflowSource?`, `workflowLabel?`.
