import { fetchJson } from './http'

export type OpencodeSessionSummary = {
  id: string
  title: string | null
  workspacePath: string
  projectId: string | null
  createdAt: string
  updatedAt: string
  summary: {
    additions: number
    deletions: number
    files: number
  }
}

export type OpencodeMessage = {
  id: string
  role: string
  createdAt: string
  completedAt: string | null
  modelId: string | null
  providerId: string | null
  text: string
}

export type OpencodeSessionDetail = {
  session: OpencodeSessionSummary
  messages: OpencodeMessage[]
}

export type OpencodeRunRecord = {
  sessionId: string
  pid: number
  workspacePath: string
  prompt: string
  title: string | null
  model: string | null
  logFile: string
  startedAt: string
  updatedAt: string
  status: string
  exitCode: number | null
  signal: string | null
}

export async function fetchOpencodeSessions(params?: { workspacePath?: string }): Promise<OpencodeSessionSummary[]> {
  const query = params?.workspacePath ? `?workspacePath=${encodeURIComponent(params.workspacePath)}` : ''
  const payload = await fetchJson<{ sessions: OpencodeSessionSummary[] }>(`/api/opencode/sessions${query}`)
  return payload.sessions
}

export async function fetchOpencodeSessionDetail(sessionId: string): Promise<OpencodeSessionDetail> {
  return await fetchJson<OpencodeSessionDetail>(`/api/opencode/sessions/${encodeURIComponent(sessionId)}`)
}

export async function startOpencodeRun(input: {
  workspacePath: string
  prompt: string
  title?: string
  model?: string
}): Promise<OpencodeRunRecord> {
  const payload = await fetchJson<{ run: OpencodeRunRecord }>(`/api/opencode/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })
  return payload.run
}

export async function killOpencodeSession(sessionId: string): Promise<boolean> {
  const payload = await fetchJson<{ success: boolean }>(
    `/api/opencode/sessions/${encodeURIComponent(sessionId)}/kill`,
    {
      method: 'POST'
    }
  )
  return Boolean(payload.success)
}

export async function fetchOpencodeRuns(): Promise<OpencodeRunRecord[]> {
  const payload = await fetchJson<{ runs: OpencodeRunRecord[] }>(`/api/opencode/runs`)
  return payload.runs
}
