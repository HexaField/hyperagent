export type WorkflowStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

export type WorkflowKind = 'new_project' | 'refactor' | 'bugfix' | 'custom' | string

export type WorkflowRecord = {
  id: string
  projectId: string
  plannerRunId: string | null
  kind: WorkflowKind
  status: WorkflowStatus
  data: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type WorkflowStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export type WorkflowStepRecord = {
  id: string
  workflowId: string
  taskId: string | null
  status: WorkflowStepStatus
  sequence: number
  dependsOn: string[]
  data: Record<string, unknown>
  result: Record<string, unknown> | null
  runnerInstanceId: string | null
  updatedAt: string
}

export type AgentRunStatus = 'running' | 'succeeded' | 'failed'

export type AgentRunRecord = {
  id: string
  workflowStepId: string | null
  projectId: string
  branch: string
  type: string
  status: AgentRunStatus
  startedAt: string
  finishedAt: string | null
  logsPath: string | null
}

export type WorkflowDetail = {
  workflow: WorkflowRecord
  steps: WorkflowStepRecord[]
  runs: AgentRunRecord[]
}
