import type { Timestamp } from '../database'

export type PullRequestStatus = 'open' | 'merged' | 'closed'
export type ReviewRunTrigger = 'manual' | 'auto_on_open' | 'auto_on_update'
export type ReviewRunStatus = 'queued' | 'running' | 'completed' | 'failed'
export type ReviewRunnerAgent = 'docker'
export type ReviewCommentAuthorKind = 'user' | 'agent'
export type PullRequestEventKind =
  | 'opened'
  | 'closed'
  | 'merged'
  | 'commit_added'
  | 'review_requested'
  | 'review_run_started'
  | 'review_run_completed'
  | 'comment_added'
  | 'comment_resolved'

export type PullRequestRecord = {
  id: string
  projectId: string
  title: string
  description: string | null
  sourceBranch: string
  targetBranch: string
  radiclePatchId: string | null
  status: PullRequestStatus
  authorUserId: string
  createdAt: Timestamp
  updatedAt: Timestamp
  mergedAt: Timestamp | null
  closedAt: Timestamp | null
}

export type PullRequestCommitRecord = {
  id: string
  pullRequestId: string
  commitHash: string
  message: string
  authorName: string
  authorEmail: string
  authoredAt: Timestamp
  createdAt: Timestamp
}

export type PullRequestEventRecord = {
  id: string
  pullRequestId: string
  kind: PullRequestEventKind
  actorUserId: string | null
  createdAt: Timestamp
  data: Record<string, unknown>
}

export type ReviewRunRecord = {
  id: string
  pullRequestId: string
  trigger: ReviewRunTrigger
  runnerAgent: ReviewRunnerAgent
  status: ReviewRunStatus
  createdAt: Timestamp
  completedAt: Timestamp | null
  summary: string | null
  highLevelFindings: string | null
  riskAssessment: string | null
  runnerInstanceId: string | null
  logsPath: string | null
}

export type ReviewThreadRecord = {
  id: string
  pullRequestId: string
  reviewRunId: string | null
  filePath: string
  diffStartLine: number
  diffEndLine: number
  fileLine: number | null
  resolved: boolean
  createdAt: Timestamp
  resolvedAt: Timestamp | null
}

export type ReviewCommentRecord = {
  id: string
  threadId: string
  authorUserId: string | null
  authorKind: ReviewCommentAuthorKind
  body: string
  suggestedPatch: string | null
  createdAt: Timestamp
}

export type FileDiff = {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  previousPath?: string
  hunks: DiffHunk[]
}

export type DiffHunk = {
  header: string
  oldStart: number
  newStart: number
  oldLines: number
  newLines: number
  lines: DiffLine[]
}

export type DiffLine = {
  type: 'context' | 'added' | 'removed'
  oldLineNumber?: number
  newLineNumber?: number
  content: string
}

export type ReviewEngineFileComment = {
  filePath: string
  hunkComments: Array<{
    diffHunkHeader: string
    comment: string
    severity: 'info' | 'suggestion' | 'warning' | 'critical'
    suggestedPatch?: string
  }>
}

export type ReviewEngineResult = {
  summary: string
  highLevelFindings: string[]
  riskAssessment: string
  fileComments: ReviewEngineFileComment[]
}
