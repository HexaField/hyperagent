export type WorkspaceNarratorEventType =
  | 'narration'
  | 'agent-update'
  | 'agent-result'
  | 'suppressed'
  | 'summary'
  | 'error'

export type WorkspaceNarratorEvent = {
  id: string
  timestamp: string
  type: WorkspaceNarratorEventType
  headline: string
  detail: string | null
  severity: 'info' | 'warning' | 'error'
  source: 'narrator' | 'agent' | 'system' | 'user'
  playbookId?: string
}

export type WorkspaceNarratorFeedResponse = {
  workspaceId: string
  conversationId: string
  summaryRef?: string | null
  events: WorkspaceNarratorEvent[]
}

export type WorkspaceNarratorMessageRequest = {
  message: string
}

export type WorkspaceNarratorMessageResponse = {
  workspaceId: string
  conversationId: string
  eventId: string
  taskId?: string
}
