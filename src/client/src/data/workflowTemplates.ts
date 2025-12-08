import { singleAgentWorkflowDocument } from '@hexafield/agent-workflow/workflows/single-agent.workflow'
import { verifierWorkerWorkflowDocument } from '@hexafield/agent-workflow/workflows/verifier-worker.workflow'
import type { WorkflowTemplate } from '../lib/workflows'

export const workflowTemplates: WorkflowTemplate[] = [
  {
    id: 'single-agent',
    label: 'Single agent',
    description: 'One agent executes instructions with lightweight loop and status.',
    definition: singleAgentWorkflowDocument,
    sampleInstructions: 'Implement a CLI that lists git branches and highlights the current one.'
  },
  {
    id: 'verifier-worker',
    label: 'Verifier + worker',
    description: 'Two-role loop with verifier guidance and approvals.',
    definition: verifierWorkerWorkflowDocument,
    sampleInstructions: 'Add unit tests for the workflow storage helpers and fix any failures.'
  }
]
