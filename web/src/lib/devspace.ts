import type { DevspaceSession } from '../../../interfaces/widgets/workspaceCodeServer'
import { fetchJson } from '../shared/api/httpClient'

export type { DevspaceSession } from '../../../interfaces/widgets/workspaceCodeServer'

export async function ensureWorkspaceDevspace(projectId: string): Promise<DevspaceSession> {
  const trimmed = projectId?.trim()
  if (!trimmed) {
    throw new Error('workspaceId is required to launch code-server')
  }
  return await fetchJson<DevspaceSession>(`/api/projects/${encodeURIComponent(trimmed)}/devspace`, {
    method: 'POST'
  })
}
