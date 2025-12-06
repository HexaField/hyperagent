import type { AgentWorkflowResult } from '../agent-orchestrator'
import { configureWorkflowParsers } from '../agent'
import {
  workflowDefinitionSchema,
  type AgentWorkflowDefinition,
  type AgentWorkflowDefinitionDraft
} from '../workflow-schema'
import { singleAgentWorkflowDocument } from './single-agent.workflow'
import { verifierWorkerWorkflowDocument } from './verifier-worker.workflow'
import { z } from 'zod'

export const registeredWorkflowParserSchemas = configureWorkflowParsers({
  passthrough: z.unknown(),
  worker: z.object({
    status: z.enum(['working', 'done', 'blocked']),
    plan: z.string(),
    work: z.string(),
    requests: z.string().optional().default('')
  }),
  verifier: z.object({
    verdict: z.enum(['instruct', 'approve', 'fail']),
    critique: z.string(),
    instructions: z.string(),
    priority: z.number().int().min(1).max(5)
  })
})

export type RegisteredWorkflowParserSchemas = typeof registeredWorkflowParserSchemas

function hydrateWorkflowDefinition<const TSource extends AgentWorkflowDefinition>(source: TSource): TSource {
  workflowDefinitionSchema.parse(source as AgentWorkflowDefinitionDraft)
  return source
}

export const singleAgentWorkflowDefinition = hydrateWorkflowDefinition(singleAgentWorkflowDocument)
export type SingleAgentWorkflowDefinition = typeof singleAgentWorkflowDefinition
export type SingleAgentWorkflowResult = AgentWorkflowResult<
  SingleAgentWorkflowDefinition,
  RegisteredWorkflowParserSchemas
>

export const verifierWorkerWorkflowDefinition = hydrateWorkflowDefinition(verifierWorkerWorkflowDocument)
export type VerifierWorkerWorkflowDefinition = typeof verifierWorkerWorkflowDefinition
export type VerifierWorkerWorkflowResult = AgentWorkflowResult<
  VerifierWorkerWorkflowDefinition,
  RegisteredWorkflowParserSchemas
>
