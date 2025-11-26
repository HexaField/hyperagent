import { fetchJson } from './http'

export type CodeServerSession = {
  id: string
  projectId: string
  branch: string
  workspacePath: string
  url: string
  authToken: string
  processId: number | null
  status: 'running' | 'stopped'
  startedAt: string
  stoppedAt: string | null
}

export async function listCodeServerSessions(): Promise<CodeServerSession[]> {
  const payload = await fetchJson<{ sessions: CodeServerSession[] }>('/api/code-server/sessions')
  return payload.sessions
}
