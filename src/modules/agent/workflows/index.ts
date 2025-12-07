import { configureWorkflowParsers } from '../agent'
import type { AgentWorkflowResult } from '../agent-orchestrator'
import {
  workflowDefinitionSchema,
  workflowParserSchemaToZod,
  type AgentWorkflowDefinition,
  type AgentWorkflowDefinitionDraft,
  type WorkflowParserJsonSchema
} from '../workflow-schema'
import { singleAgentWorkflowDocument } from './single-agent.workflow'
import { verifierWorkerWorkflowDocument } from './verifier-worker.workflow'

type UnionToIntersection<U> = (U extends any ? (arg: U) => void : never) extends (arg: infer I) => void ? I : never

type ParserSchemasOf<T extends AgentWorkflowDefinition> =
  NonNullable<T['parsers']> extends Record<
    string,
    WorkflowParserJsonSchema
  >
    ? {
        [K in keyof NonNullable<T['parsers']>]: ReturnType<typeof workflowParserSchemaToZod<NonNullable<T['parsers']>[K]>>
      }
    : {}

type MergedParserSchemas<TDefs extends readonly AgentWorkflowDefinition[]> = {
  [K in keyof UnionToIntersection<ParserSchemasOf<TDefs[number]>>]: UnionToIntersection<
    ParserSchemasOf<TDefs[number]>
  >[K]
}

export const collectParserSchemasFromDefinitions = <const TDefs extends readonly AgentWorkflowDefinition[]>(
  ...definitions: TDefs
) => {
  const registry = {} as MergedParserSchemas<TDefs>
  definitions.forEach((definition) => {
    const parsers = definition.parsers ?? {}
    Object.entries(parsers).forEach(([name, schema]) => {
      ;(registry as Record<string, unknown>)[name] = workflowParserSchemaToZod(schema as WorkflowParserJsonSchema)
    })
  })
  return registry
}

export const registeredWorkflowParserSchemas = configureWorkflowParsers(
  collectParserSchemasFromDefinitions(singleAgentWorkflowDocument, verifierWorkerWorkflowDocument)
)

export type RegisteredWorkflowParserSchemas = typeof registeredWorkflowParserSchemas

export function hydrateWorkflowDefinition<const TSource extends AgentWorkflowDefinition>(source: TSource): TSource {
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
