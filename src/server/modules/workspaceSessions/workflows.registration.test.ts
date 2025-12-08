import { parseJsonPayload } from '../../../modules/agent/agent'
import { workflowDefinitionSchema } from '../../../modules/agent/workflow-schema'
import { deleteWorkflow, writeWorkflow } from './workflows'

import { describe, expect, it } from 'vitest'

const testDef = {
  $schema: 'https://hyperagent.dev/schemas/agent-workflow.json',
  id: 'test-registration.v1',
  description: 'Test registration of parser schemas',
  model: 'github-copilot/gpt-5-mini',
  sessions: { roles: [{ role: 'tester', nameTemplate: '{{runId}}-tester' }] },
  parsers: {
    sample: {
      type: 'object',
      properties: {
        foo: { type: 'string' }
      },
      required: ['foo']
    }
  },
  roles: {
    tester: {
      systemPrompt: 'Respond with {"foo": "bar"}',
      parser: 'sample'
    }
  },
  flow: {
    round: {
      start: 'tester',
      steps: [
        {
          key: 'tester',
          role: 'tester',
          prompt: ['Do the thing']
        }
      ],
      defaultOutcome: { outcome: 'done', reason: 'done' }
    }
  }
}

describe('workflow parser registration', () => {
  it('registers parsers after writing a workflow', async () => {
    const def = workflowDefinitionSchema.parse(testDef)
    const { id } = await writeWorkflow(def)
    try {
      const parser = parseJsonPayload('tester', 'sample')
      const parsed = parser('tester', '{"foo":"ok"}')
      expect((parsed as any).foo).toBe('ok')
    } finally {
      await deleteWorkflow(id)
    }
  })
})
