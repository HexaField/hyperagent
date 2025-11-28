export type ConversationPart = {
  id: string
  type: string
  text?: string
  start?: string | null
  end?: string | null
  [key: string]: unknown
}

export type ConversationMessage = {
  id: string
  role: string
  createdAt: string
  completedAt: string | null
  modelId: string | null
  providerId: string | null
  text: string
  parts: ConversationPart[]
}

export type SessionSummary = {
  id: string
  title: string | null
  workspacePath: string
  projectId: string | null
  createdAt: string
  updatedAt: string
  providerId?: string | null
  modelId?: string | null
  summary: { additions: number; deletions: number; files: number }
}

export type SessionDetail = {
  session: SessionSummary
  messages: ConversationMessage[]
}

export default {}
