// Provider concepts removed — model selection is handled in the UI module

import { Part } from '@opencode-ai/sdk'

export type CodingAgentSessionSummary = {
  id: string
  title: string | null
  workspacePath: string
  projectId: string | null
  createdAt: string
  updatedAt: string
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
  parts: Part[]
}

export type CodingAgentSessionDetail = {
  session: CodingAgentSessionSummary
  messages: CodingAgentMessage[]
}

// Simplified run meta shape used by agent flows (mirrors provenance RunMeta)
export type RunMeta = {
  id: string
  agents: Array<{ role: string; sessionId: string }>
  log: Array<{ entryId: string; model?: string; role?: string; payload: any; createdAt: string }>
  createdAt: string
  updatedAt: string
}

export type CodingAgentSessionListResponse = {
  sessions: CodingAgentSessionSummary[]
}

export type CodingAgentRunListResponse = {
  runs: RunMeta[]
}
