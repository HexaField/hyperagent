import type {
  WorkspaceNarratorFeedResponse,
  WorkspaceNarratorMessageResponse
} from '../../../interfaces/widgets/workspaceNarrator'
import { fetchJson } from '../shared/api/httpClient'

export async function fetchNarratorFeed(params: {
  workspaceId: string
  conversationId?: string
  limit?: number
}): Promise<WorkspaceNarratorFeedResponse> {
  const workspaceId = params.workspaceId?.trim()
  if (!workspaceId) {
    throw new Error('workspaceId is required')
  }
  const query = new URLSearchParams()
  if (params.limit && Number.isFinite(params.limit)) {
    query.set('limit', String(params.limit))
  }
  if (params.conversationId?.trim()) {
    query.set('conversationId', params.conversationId.trim())
  }
  const queryString = query.toString()
  return await fetchJson<WorkspaceNarratorFeedResponse>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/narrator/feed${queryString ? `?${queryString}` : ''}`
  )
}

export async function postNarratorMessage(params: {
  workspaceId: string
  message: string
}): Promise<WorkspaceNarratorMessageResponse> {
  const workspaceId = params.workspaceId?.trim()
  if (!workspaceId) {
    throw new Error('workspaceId is required')
  }
  const message = params.message?.trim()
  if (!message) {
    throw new Error('message is required')
  }
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/narrator/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  })
  if (!response.ok) {
    let detail = 'Failed to send narrator message'
    try {
      const payload = await response.json()
      detail = typeof payload?.detail === 'string' ? payload.detail : (payload?.error ?? detail)
    } catch {
      const fallback = await response.text()
      if (fallback.trim().length) {
        detail = fallback
      }
    }
    throw new Error(detail)
  }
  return (await response.json()) as WorkspaceNarratorMessageResponse
}

export async function fetchNarratorRawLog(params: { workspaceId: string }): Promise<string> {
  const workspaceId = params.workspaceId?.trim()
  if (!workspaceId) {
    throw new Error('workspaceId is required')
  }
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/narrator/raw`, {
    headers: { Accept: 'application/jsonl,text/plain,*/*' }
  })
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(errorText || 'Request failed')
  }
  return await response.text()
}
