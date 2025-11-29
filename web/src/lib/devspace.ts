import { fetchJson } from '../shared/api/httpClient'

export type DevspaceSession = {
  projectId: string
  sessionId: string
  codeServerUrl: string
  workspacePath: string
  branch: string
}

export async function ensureWorkspaceDevspace(projectId: string): Promise<DevspaceSession> {
  const trimmed = projectId?.trim()
  if (!trimmed) {
    throw new Error('workspaceId is required to launch code-server')
  }
  return await fetchJson<DevspaceSession>(`/api/projects/${encodeURIComponent(trimmed)}/devspace`, {
    method: 'POST'
  })
}
