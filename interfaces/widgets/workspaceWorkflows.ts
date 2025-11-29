import type { WorkflowDetail, WorkflowRecord, WorkflowStepRecord } from '../core/workflows'

export type WorkflowSummary = {
  workflow: WorkflowRecord
  steps: WorkflowStepRecord[]
}

export type WorkflowSummaryListResponse = {
  workflows: WorkflowSummary[]
}

export type WorkflowDiffPayload = {
  workflowId: string
  stepId: string
  commitHash: string
  branch: string
  message: string
  diffText: string
}

export type WorkflowWorkspaceEntry = {
  name: string
  kind: 'file' | 'directory'
}

export type WorkflowProvenancePayload = {
  logsPath: string | null
  workspacePath: string | null
  content: string | null
  parsed: unknown
  workspaceEntries: WorkflowWorkspaceEntry[]
}

export type WorkflowProvenanceResponse = WorkflowProvenancePayload
export type WorkflowDiffResponse = WorkflowDiffPayload
export type WorkflowDetailResponse = WorkflowDetail
