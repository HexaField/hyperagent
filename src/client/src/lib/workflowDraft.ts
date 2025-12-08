import { workflowDefinitionSchema, type AgentWorkflowDefinition } from '../../../modules/agent/workflow-schema'
import { fetchJson } from '../shared/api/httpClient'
import type { WorkflowTemplate } from './workflows'

const DRAFT_ENDPOINT = '/api/workflows/draft'

export type DraftWorkflowResult = {
  definition: AgentWorkflowDefinition
  rawText: string
  source: 'workflow-create'
}

const buildPrompt = (instructions: string, template?: WorkflowTemplate | null): string => {
  const base = template?.definition
  const summary = base
    ? `Base template id: ${base.id}. Roles: ${Object.keys(base.roles ?? {}).join(', ')}`
    : 'Base template: none provided.'
  return `Author a Hyperagent workflow as strict JSON that satisfies the AgentWorkflowDefinition schema.\n${summary}\nUser instructions to encode: ${instructions}\nRules: start the reply with { and end with }. No markdown fences. Prefer github-copilot models. Include concise descriptions.`
}

const requestWorkflowCreateDraft = async (
  prompt: string,
  template?: AgentWorkflowDefinition
): Promise<DraftWorkflowResult> => {
  if (typeof fetch === 'undefined') {
    throw new Error('Draft endpoint unavailable: fetch is not defined')
  }
  const endpoint =
    typeof window !== 'undefined' && typeof window.location?.origin === 'string'
      ? new URL(DRAFT_ENDPOINT, window.location.origin).toString()
      : null
  if (!endpoint) {
    throw new Error('Draft endpoint unavailable: window origin not detected')
  }

  const payload = await fetchJson<{ definition: AgentWorkflowDefinition; rawText: string }>(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instructions: prompt, template })
  })
  const definition = workflowDefinitionSchema.parse(payload.definition)
  return { definition, rawText: payload.rawText, source: 'workflow-create' }
}

export async function draftWorkflowFromPrompt(input: {
  instructions: string
  template?: WorkflowTemplate | null
}): Promise<DraftWorkflowResult> {
  const prompt = buildPrompt(input.instructions, input.template)
  try {
    return await requestWorkflowCreateDraft(prompt, input.template?.definition)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Workflow draft failed: ${message}`)
  }
}
