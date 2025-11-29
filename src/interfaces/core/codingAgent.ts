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
  providerId?: string | null
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
  providerId: string | null
  text: string
  parts: CodingAgentMessagePart[]
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

export type CodingAgentSessionListResponse = {
  sessions: CodingAgentSessionSummary[]
}

export type CodingAgentRunListResponse = {
  runs: CodingAgentRunRecord[]
}
