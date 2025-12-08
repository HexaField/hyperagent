import fs from 'fs'
import path from 'path'
import type { AgentWorkflowDefinition } from '../workflow-schema'

// Read the workflows README.md at module load so the prompt contains the file verbatim.
const workflowsReadme = fs.readFileSync(path.resolve(__dirname, 'README.md'), 'utf8')

export const workflowCreateWorkflowDocument = {
  $schema: 'https://hyperagent.dev/schemas/agent-workflow.json',
  id: 'workflow-create.v1',
  description:
    'Single-step workflow that instructs an agent to author a new workflow file. The README.md is embedded in the prompt to provide authoring guidance.',
  model: 'github-copilot/gpt-5-mini',
  sessions: {
    roles: [{ role: 'creator' as const, nameTemplate: '{{runId}}-creator' }]
  },
  parsers: {
    createWorkflow: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' as const },
        filename: { type: 'string' as const },
        content: { type: 'string' as const }
      },
      required: ['id', 'filename', 'content']
    }
  },
  roles: {
    creator: {
      systemPrompt:
        'You are an expert workflow author. Respond with a single valid JSON object only (no markdown, no code fences, no leading text). The FIRST character of your reply must be `{` and the last must be `}`; nothing else may precede or follow. Shape: {"id": string, "filename": string, "content": string}. Use id "workflow-create.v1" and filename "workflow-create.workflow.ts". The "content" must be a TypeScript workflow file that imports AgentWorkflowDefinition, exports a const named for the file purpose, and ends with "as const satisfies AgentWorkflowDefinition". The workflow itself should be single-step and JSON-compatible. Do not include commentary or prose. Do not include the README text inside the content; use it only for guidance. Escape newlines in the content with `\n` so the JSON remains valid.',
      parser: 'createWorkflow'
    }
  },
  state: { initial: {} },
  flow: {
    round: {
      start: 'createWorkflow',
      steps: [
        {
          key: 'createWorkflow',
          role: 'creator' as const,
          prompt: [
            'You are being asked to author a new workflow file for the Hyperagent repository.',
            'Include the following README guidance verbatim (for context):',
            workflowsReadme,
            'User request: Create a workflow file named `workflow-create.workflow.ts` which itself is a single-step workflow that, when executed, will create a workflow file. For this task, return the new file contents as the `content` field of the JSON object. The output must satisfy the parser schema { id, filename, content } and the filename must be `workflow-create.workflow.ts`. Use `as const satisfies AgentWorkflowDefinition` in the file content. Keep the authored workflow concise and JSON-compatible. Respond with ONLY the JSON object—no extra text. Strict formatting: start the reply with `{` (no leading characters) and end with `}`. Do NOT paste the README into the content; only use it as guidance.'
          ],
          exits: [
            {
              condition: 'always',
              outcome: 'created',
              reason: 'Creator produced workflow file content'
            }
          ]
        }
      ],
      maxRounds: 1,
      defaultOutcome: {
        outcome: 'created',
        reason: 'Single-step authoring workflow completed'
      }
    }
  }
} as const satisfies AgentWorkflowDefinition

export default workflowCreateWorkflowDocument
