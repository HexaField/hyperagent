export type CodeServerSessionStatus = 'running' | 'stopped'

export type CodeServerSessionRecord = {
  id: string
  projectId: string
  branch: string
  workspacePath: string
  url: string
  authToken: string
  processId: number | null
  status: CodeServerSessionStatus
  startedAt: string
  stoppedAt: string | null
}

export type CodeServerSessionListResponse = {
  sessions: CodeServerSessionRecord[]
}
