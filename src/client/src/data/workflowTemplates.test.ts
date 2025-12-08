import { describe, expect, it } from 'vitest'
import { workflowDefinitionSchema } from '../../../modules/agent/workflow-schema'
import { workflowTemplates } from './workflowTemplates'

describe('workflow templates', () => {
  it('are valid AgentWorkflowDefinitions', () => {
    workflowTemplates.forEach((template) => {
      expect(() => workflowDefinitionSchema.parse(template.definition)).not.toThrow()
    })
  })
})
