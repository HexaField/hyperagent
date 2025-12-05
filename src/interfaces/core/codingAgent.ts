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

export type CodingAgentProviderListResponse = {
  providers?: CodingAgentProvider[]
}

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

export type CodingAgentMessagePart = {
  id: string
  type: string
  text?: string
  start?: string | null
  end?: string | null
  [key: string]: unknown
}

export type CodingAgentMessage = {
  id: string
  role: string
  createdAt: string
  completedAt: string | null
  modelId: string | null
  text: string
  parts: CodingAgentMessagePart[]
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
