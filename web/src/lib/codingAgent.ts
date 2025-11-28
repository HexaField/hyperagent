import { fetchJson } from './http'

export type CodingAgentProviderModel = {
  id: string
  label: string
}

export type CodingAgentProvider = {
  id: string
  label: string
  defaultModelId: string
  models: CodingAgentProviderModel[]
}

type CodingAgentProvidersResponse = {
  providers?: CodingAgentProvider[]
}

export async function fetchCodingAgentProviders(): Promise<CodingAgentProvider[]> {
  try {
    const payload = await fetchJson<CodingAgentProvidersResponse>('/api/coding-agent/providers')
    const providers = Array.isArray(payload?.providers) ? payload.providers : []
    return providers
  } catch (error) {
    console.error('Failed to fetch coding agent providers', error)
    return []
  }
}

export type CodingAgentSessionSummary = {
  id: string
  title: string | null
  workspacePath: string
  projectId: string | null
  createdAt: string
  updatedAt: string
  providerId?: string | null
  modelId?: string | null
  summary: {
    additions: number
    deletions: number
    files: number
  }
}

export type CodingAgentMessage = {
  id: string
  role: string
  createdAt: string
  completedAt: string | null
  modelId: string | null
  providerId: string | null
  text: string
}

export type CodingAgentSessionDetail = {
  session: CodingAgentSessionSummary
  messages: CodingAgentMessage[]
}

export type CodingAgentRunRecord = {
  sessionId: string
  pid: number
  workspacePath: string
  prompt: string
  title: string | null
  model: string | null
  providerId: string | null
  logFile: string
  startedAt: string
  updatedAt: string
  status: string
  exitCode: number | null
  signal: string | null
}

export async function fetchCodingAgentSessions(params?: {
  workspacePath?: string
}): Promise<CodingAgentSessionSummary[]> {
  const query = params?.workspacePath ? `?workspacePath=${encodeURIComponent(params.workspacePath)}` : ''
  const payload = await fetchJson<{ sessions: CodingAgentSessionSummary[] }>(`/api/coding-agent/sessions${query}`)
  return payload.sessions
}

export async function fetchCodingAgentSessionDetail(sessionId: string): Promise<CodingAgentSessionDetail> {
  return await fetchJson<CodingAgentSessionDetail>(`/api/coding-agent/sessions/${encodeURIComponent(sessionId)}`)
}

export async function startCodingAgentRun(input: {
  workspacePath: string
  prompt: string
  title?: string
  model?: string
  providerId?: string
}): Promise<CodingAgentRunRecord> {
  const payload = await fetchJson<{ run: CodingAgentRunRecord }>(`/api/coding-agent/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
  return payload.run
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

export async function fetchCodingAgentRuns(): Promise<CodingAgentRunRecord[]> {
  const payload = await fetchJson<{ runs: CodingAgentRunRecord[] }>(`/api/coding-agent/runs`)
  return payload.runs
}

export async function postCodingAgentMessage(
  sessionId: string,
  input: { role?: string; text: string; modelId?: string }
): Promise<CodingAgentSessionDetail> {
  const payload = await fetchJson<CodingAgentSessionDetail>(
    `/api/coding-agent/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: input.role ?? 'user', text: input.text, modelId: input.modelId })
    }
  )
  return payload
}
