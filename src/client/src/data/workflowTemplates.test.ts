import { workflowDefinitionSchema } from '@hexafield/agent-workflow'
import { describe, expect, it } from 'vitest'
import { workflowTemplates } from './workflowTemplates'

describe('workflow templates', () => {
  it('are valid AgentWorkflowDefinitions', () => {
    workflowTemplates.forEach((template) => {
      expect(() => workflowDefinitionSchema.parse(template.definition)).not.toThrow()
    })
  })
})
