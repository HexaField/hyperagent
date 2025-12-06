import { singleAgentWorkflowDocument } from './single-agent.workflow'
import { verifierWorkerWorkflowDocument } from './verifier-worker.workflow'
import {
  workflowDefinitionSchema,
  type AgentWorkflowDefinition,
  type AgentWorkflowDefinitionDraft
} from '../workflow-schema'
import type { AgentWorkflowResult } from '../agent-orchestrator'

function hydrateWorkflowDefinition<const TSource extends AgentWorkflowDefinition>(source: TSource): TSource {
  workflowDefinitionSchema.parse(source as AgentWorkflowDefinitionDraft)
  return source
}

export const singleAgentWorkflowDefinition = hydrateWorkflowDefinition(singleAgentWorkflowDocument)
export type SingleAgentWorkflowDefinition = typeof singleAgentWorkflowDefinition
export type SingleAgentWorkflowResult = AgentWorkflowResult<SingleAgentWorkflowDefinition>

export const verifierWorkerWorkflowDefinition = hydrateWorkflowDefinition(verifierWorkerWorkflowDocument)
export type VerifierWorkerWorkflowDefinition = typeof verifierWorkerWorkflowDefinition
export type VerifierWorkerWorkflowResult = AgentWorkflowResult<VerifierWorkerWorkflowDefinition>
