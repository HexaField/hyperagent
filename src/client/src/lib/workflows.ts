import { workflowDefinitionSchema, type AgentWorkflowDefinition } from '@hexafield/agent-workflow'
import { fetchJson } from '../shared/api/httpClient'

export type WorkflowSummary = {
  id: string
  description?: string
  model?: string
  roles: string[]
  updatedAt: string
}

export type WorkflowDetail = {
  id: string
  definition: AgentWorkflowDefinition
  updatedAt: string
  path: string
}

export type WorkflowValidationError = {
  message: string
  path?: (string | number)[]
}

export type WorkflowTemplate = {
  id: string
  label: string
  description: string
  definition: AgentWorkflowDefinition
  sampleInstructions?: string
}

const headers = { 'Content-Type': 'application/json' }

export async function listWorkflows(): Promise<WorkflowSummary[]> {
  const payload = await fetchJson<{ workflows: WorkflowSummary[] }>('/api/workflows')
  return Array.isArray(payload.workflows) ? payload.workflows : []
}

export async function getWorkflow(id: string): Promise<WorkflowDetail | null> {
  try {
    const payload = await fetchJson<{ workflow: WorkflowDetail }>(`/api/workflows/${encodeURIComponent(id)}`)
    return payload.workflow ?? null
  } catch (error) {
    console.error('Failed to read workflow', id, error)
    return null
  }
}

export async function createWorkflow(definition: AgentWorkflowDefinition): Promise<{ id: string; path: string }> {
  const payload = await fetchJson<{ id: string; path: string }>(`/api/workflows`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ definition })
  })
  return payload
}

export async function updateWorkflow(
  id: string,
  definition: AgentWorkflowDefinition
): Promise<{ id: string; path: string }> {
  const payload = await fetchJson<{ id: string; path: string }>(`/api/workflows/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ definition })
  })
  return payload
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  try {
    await fetchJson(`/api/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' })
    return true
  } catch (error) {
    console.error('Failed to delete workflow', id, error)
    return false
  }
}

export function validateLocally(definition: unknown): AgentWorkflowDefinition {
  return workflowDefinitionSchema.parse(definition)
}

export async function validateRemotely(definition: AgentWorkflowDefinition): Promise<AgentWorkflowDefinition> {
  const payload = await fetchJson<{ definition: AgentWorkflowDefinition }>(`/api/workflows/validate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ definition })
  })
  return payload.definition
}

export function summarizeDefinition(definition: AgentWorkflowDefinition): WorkflowSummary {
  return {
    id: definition.id,
    description: definition.description,
    model: definition.model,
    roles: Object.keys(definition.roles ?? {}),
    updatedAt: new Date().toISOString()
  }
}

export function parseWorkflowJson(input: string): AgentWorkflowDefinition {
  const parsed = JSON.parse(input)
  return validateLocally(parsed)
}
