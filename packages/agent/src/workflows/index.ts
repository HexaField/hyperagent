import type { AgentWorkflowResult } from '../agent-orchestrator'
import {
  workflowDefinitionSchema,
  type AgentWorkflowDefinition,
  type AgentWorkflowDefinitionDraft
} from '../workflow-schema'
import { singleAgentWorkflowDocument } from './single-agent.workflow'
import { verifierWorkerWorkflowDocument } from './verifier-worker.workflow'
import { workflowCreateWorkflowDocument } from './workflow-create.workflow'

export function hydrateWorkflowDefinition<const TSource extends AgentWorkflowDefinition>(source: TSource): TSource {
  workflowDefinitionSchema.parse(source as AgentWorkflowDefinitionDraft)
  return source
}

export const singleAgentWorkflowDefinition = hydrateWorkflowDefinition(singleAgentWorkflowDocument)
export type SingleAgentWorkflowDefinition = typeof singleAgentWorkflowDefinition
export type SingleAgentWorkflowResult = AgentWorkflowResult<SingleAgentWorkflowDefinition>

export const verifierWorkerWorkflowDefinition = hydrateWorkflowDefinition(verifierWorkerWorkflowDocument)
export type VerifierWorkerWorkflowDefinition = typeof verifierWorkerWorkflowDefinition
export type VerifierWorkerWorkflowResult = AgentWorkflowResult<VerifierWorkerWorkflowDefinition>

export const workflowCreateWorkflowDefinition = hydrateWorkflowDefinition(workflowCreateWorkflowDocument)
export type WorkflowCreateWorkflowDefinition = typeof workflowCreateWorkflowDefinition
export type WorkflowCreateWorkflowResult = AgentWorkflowResult<WorkflowCreateWorkflowDefinition>
