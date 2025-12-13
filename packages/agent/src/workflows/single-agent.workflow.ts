import type { AgentWorkflowDefinition } from '../workflow-schema'

export const singleAgentWorkflowDocument = {
  $schema: 'https://hyperagent.dev/schemas/agent-workflow.json',
  id: 'single-agent.v1',
  description: 'Single role workflow that streams user instructions directly to one agent.',
  model: 'github-copilot/gpt-5-mini',
  sessions: {
    roles: [{ role: 'agent' as const, nameTemplate: '{{runId}}-solo' }]
  },
  parsers: {
    passthrough: { type: 'unknown' as const }
  },
  roles: {
    agent: {
      systemPrompt:
        'You are a helpful engineering agent responding with valid JSON object {"status": string, "summary": string} summarizing your work.',
      parser: 'passthrough'
    }
  },
  state: {
    initial: {}
  },
  user: {
    instructions: { type: 'string', default: '' }
  },
  flow: {
    round: {
      start: 'agent',
      steps: [
        {
          key: 'agent',
          role: 'agent' as const,
          prompt: ['Primary task:\n{{user.instructions}}'],
          exits: [
            {
              condition: 'always',
              outcome: 'completed',
              reason: 'Agent returned a response'
            }
          ]
        }
      ],
      maxRounds: 1,
      defaultOutcome: {
        outcome: 'completed',
        reason: 'Agent completed single-step workflow'
      }
    }
  }
} as const satisfies AgentWorkflowDefinition
