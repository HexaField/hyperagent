import type { CodeServerSessionRecord } from '../core/codeServer'

export type DevspaceSession = {
  projectId: string
  sessionId: string
  codeServerUrl: string
  workspacePath: string
  branch: string
}

export type CodeServerSession = CodeServerSessionRecord
