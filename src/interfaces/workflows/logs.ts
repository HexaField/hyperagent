export type WorkflowLogSource = 'runner' | 'agent'

export type WorkflowRunnerLogEntry = {
  id: string
  workflowId: string
  stepId: string
  runnerInstanceId: string | null
  source: 'runner'
  stream: 'stdout' | 'stderr'
  message: string
  timestamp: string
}

export type WorkflowAgentLogEntry = {
  id: string
  workflowId: string
  stepId: string
  runnerInstanceId: string | null
  source: 'agent'
  role: 'worker' | 'verifier'
  round: number
  attempt: number
  model: string
  chunk: string
  timestamp: string
  sessionId?: string | null
}

export type WorkflowLogEntry = WorkflowRunnerLogEntry | WorkflowAgentLogEntry

export type WorkflowLogsResponse = {
  workflowId: string
  entries: WorkflowLogEntry[]
}
