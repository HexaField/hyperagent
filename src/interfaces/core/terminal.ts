export type TerminalSessionStatus = 'active' | 'closed' | 'error'

export type TerminalSessionRecord = {
  id: string
  userId: string
  projectId: string | null
  shellCommand: string
  initialCwd: string | null
  status: TerminalSessionStatus
  createdAt: string
  closedAt: string | null
}

export type TerminalSessionListResponse = {
  sessions: TerminalSessionRecord[]
}

export type TerminalSessionResponse = {
  session: TerminalSessionRecord
}
