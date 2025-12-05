import type { LogEntry, RunMeta } from '../../../modules/provenance/provenance'
import { fetchJson } from '../shared/api/httpClient'

export type { LogEntry, RunMeta }


export async function fetchCodingAgentSessions(params?: {
  workspacePath?: string
}): Promise<RunMeta[]> {
  const query = params?.workspacePath ? `?workspacePath=${encodeURIComponent(params.workspacePath)}` : ''
  const payload = await fetchJson<{ runs: RunMeta[] }>(`/api/coding-agent/sessions${query}`)
  return payload.runs ?? []
}

export async function startCodingAgentRun(input: {
  workspacePath: string
  prompt: string
  title?: string
  model?: string
  personaId?: string
}): Promise<RunMeta> {
  // Keep payload backward-compatible: include personaId when provided
  const body: Record<string, unknown> = {
    workspacePath: input.workspacePath,
    prompt: input.prompt
  }
  if (input.title) body.title = input.title
  if (input.model) body.model = input.model
  if (input.personaId) body.personaId = input.personaId

  const payload = await fetchJson<{ run: RunMeta }>(`/api/coding-agent/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return payload.run
}

// Persona management helpers
export type PersonaSummary = {
  id: string
  label?: string
  description?: string
  model?: string
  mode?: string
  tools?: Record<string, unknown>
  permission?: Record<string, unknown>
  updatedAt: string
}
export type PersonaDetail = {
  id: string
  markdown: string
  frontmatter: Record<string, unknown>
  body: string
  updatedAt: string
}

export async function fetchCodingAgentPersonas(): Promise<PersonaSummary[]> {
  try {
    const payload = await fetchJson<{ personas: PersonaSummary[] }>(`/api/coding-agent/personas`)
    return Array.isArray(payload?.personas) ? payload.personas : []
  } catch (err) {
    console.error('Failed to fetch personas', err)
    return []
  }
}

export async function getCodingAgentPersona(id: string): Promise<PersonaDetail | null> {
  try {
    const payload = await fetchJson<PersonaDetail>(`/api/coding-agent/personas/${encodeURIComponent(id)}`)
    return payload ?? null
  } catch (err) {
    console.error('Failed to fetch persona', id, err)
    return null
  }
}

export async function createCodingAgentPersona(markdown: string): Promise<{ id: string } | null> {
  try {
    const payload = await fetchJson<{ id: string }>(`/api/coding-agent/personas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown })
    })
    return payload ?? null
  } catch (err) {
    console.error('Failed to create persona', err)
    return null
  }
}

export async function updateCodingAgentPersona(id: string, markdown: string): Promise<boolean> {
  try {
    await fetchJson(`/api/coding-agent/personas/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown })
    })
    return true
  } catch (err) {
    console.error('Failed to update persona', id, err)
    return false
  }
}

export async function deleteCodingAgentPersona(id: string): Promise<boolean> {
  try {
    await fetchJson(`/api/coding-agent/personas/${encodeURIComponent(id)}`, { method: 'DELETE' })
    return true
  } catch (err) {
    console.error('Failed to delete persona', id, err)
    return false
  }
}

export async function killCodingAgentSession(sessionId: string): Promise<boolean> {
  const payload = await fetchJson<{ success: boolean }>(
    `/api/coding-agent/sessions/${encodeURIComponent(sessionId)}/kill`,
    {
      method: 'POST'
    }
  )
  return Boolean(payload.success)
}

export async function postCodingAgentMessage(
  sessionId: string,
  input: { role?: string; text: string; modelId?: string }
): Promise<RunMeta | null> {
  const payload = await fetchJson<{ run: RunMeta | null }>(
    `/api/coding-agent/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: input.role ?? 'user', text: input.text, modelId: input.modelId })
    }
  )
  return payload.run ?? null
}
