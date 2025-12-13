import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { AgentWorkflowDefinition } from '../workflow-schema'

// Read the workflows README.md at module load so the prompt contains the file verbatim.
const __filename__ = fileURLToPath(import.meta.url)
const __dirname__ = path.dirname(__filename__)
const workflowsReadme = fs.readFileSync(path.resolve(__dirname__, 'README.md'), 'utf8')

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
        content: { type: 'string' as const }
      },
      required: ['id', 'content']
    }
  },
  roles: {
    creator: {
      systemPrompt:
        'You are an expert workflow author. Respond with a single valid JSON object only (no markdown, no code fences, no leading text). The FIRST character of your reply must be `{` and the last must be `}`; nothing else may precede or follow. Shape: {"id": string, "content": string}. Use id "workflow-create.v1". The "content" must be a JSON string that is itself a valid AgentWorkflowDefinition (no TypeScript). Do not include commentary or prose. Do not include the README text inside the content; use it only for guidance. Escape newlines in the content with `\n` so the JSON remains valid.',
      parser: 'createWorkflow'
    }
  },
  state: { initial: {} },
  user: {
    instructions: { type: 'string', default: '' }
  },
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
            'User request: Create a workflow definition object. For this task, return the workflow definition as a JSON string in the `content` field of the JSON object. The output must satisfy the parser schema { id, content } and the id should be "workflow-create.v1". The `content` must be a JSON string that parses to a valid AgentWorkflowDefinition. Keep the authored workflow concise and JSON-compatible. Respond with ONLY the JSON object—no extra text. Strict formatting: start the reply with `{` (no leading characters) and end with `}`. Do NOT paste the README into the content; only use it as guidance.'
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
