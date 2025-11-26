import type { DiffModule } from './diff'
import type { ReviewEngineModule } from './engine'
import type {
  PullRequestEventsRepository,
  ReviewCommentsRepository,
  ReviewRunsRepository,
  ReviewThreadsRepository
} from './persistence'
import type { PullRequestModule } from './pullRequest'
import type { ReviewRunnerGateway } from './runnerGateway'
import type { ReviewEngineResult, ReviewRunRecord, ReviewRunTrigger } from './types'

export type ReviewScheduler = ReturnType<typeof createReviewSchedulerModule>

export function createReviewSchedulerModule(deps: {
  reviewRuns: ReviewRunsRepository
  reviewThreads: ReviewThreadsRepository
  reviewComments: ReviewCommentsRepository
  pullRequestEvents: PullRequestEventsRepository
  pullRequestModule: PullRequestModule
  diffModule: DiffModule
  reviewEngine: ReviewEngineModule
  runnerGateway: ReviewRunnerGateway
  pollIntervalMs?: number
}) {
  const pollInterval = deps.pollIntervalMs ?? 2000
  let workerRunning = false
  let workerPromise: Promise<void> | null = null

  const startWorker = () => {
    if (workerRunning) return
    workerRunning = true
    workerPromise = runWorker()
  }

  const stopWorker = async () => {
    workerRunning = false
    if (workerPromise) {
      await workerPromise
      workerPromise = null
    }
  }

  return {
    requestReview,
    listRuns: (pullRequestId: string) => deps.reviewRuns.listByPullRequest(pullRequestId),
    processPendingRuns,
    runRunById,
    startWorker,
    stopWorker
  }

  async function requestReview(pullRequestId: string, trigger: ReviewRunTrigger): Promise<ReviewRunRecord> {
    const run = deps.reviewRuns.insert({ pullRequestId, trigger, runnerAgent: 'docker', status: 'queued' })
    deps.pullRequestEvents.insert({
      pullRequestId,
      kind: 'review_requested',
      actorUserId: null,
      data: { runId: run.id, trigger }
    })
    await enqueueRun(run)
    return run
  }

  async function runWorker() {
    while (workerRunning) {
      await processPendingRuns()
      await delay(pollInterval)
    }
  }

  async function processPendingRuns(limit = 2): Promise<void> {
    const queued = deps.reviewRuns.listByStatus('queued', limit)
    for (const run of queued) {
      await enqueueRun(run)
    }
  }

  async function runRunById(runId: string): Promise<void> {
    const run = deps.reviewRuns.getById(runId)
    if (!run) {
      throw new Error('Unknown review run')
    }
    if (run.status !== 'queued') {
      return
    }
    await executeRun(run)
  }

  async function enqueueRun(run: ReviewRunRecord): Promise<void> {
    if (run.status !== 'queued') return
    if (run.runnerInstanceId) return
    try {
      const detail = await deps.pullRequestModule.getPullRequestWithCommits(run.pullRequestId)
      if (!detail) {
        throw new Error('Unknown pull request for review run')
      }
      const runnerInstanceId = `runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      deps.reviewRuns.update(run.id, { runnerInstanceId })
      run.runnerInstanceId = runnerInstanceId
      await deps.runnerGateway.enqueue({ run, pullRequest: detail.pullRequest, project: detail.project })
    } catch (error) {
      deps.reviewRuns.update(run.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        summary: error instanceof Error ? error.message : 'Failed to enqueue review runner',
        runnerInstanceId: null
      })
      run.runnerInstanceId = null
      deps.pullRequestEvents.insert({
        pullRequestId: run.pullRequestId,
        kind: 'review_run_completed',
        actorUserId: null,
        data: { runId: run.id, status: 'failed' }
      })
    }
  }

  async function executeRun(run: ReviewRunRecord): Promise<void> {
    deps.reviewRuns.update(run.id, { status: 'running' })
    deps.pullRequestEvents.insert({
      pullRequestId: run.pullRequestId,
      kind: 'review_run_started',
      actorUserId: null,
      data: { runId: run.id }
    })
    try {
      const detail = await deps.pullRequestModule.getPullRequestWithCommits(run.pullRequestId)
      if (!detail) {
        throw new Error('Unknown pull request for review run')
      }
      const diff = await deps.diffModule.getPullRequestDiff(detail.pullRequest, detail.project)
      const engineResult = await deps.reviewEngine.reviewPullRequest({
        pullRequest: detail.pullRequest,
        diff,
        commits: detail.commits
      })
      await persistEngineResult(run, detail.pullRequest.id, engineResult)
    } catch (error) {
      deps.reviewRuns.update(run.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        summary: error instanceof Error ? error.message : 'Review failed'
      })
      deps.pullRequestEvents.insert({
        pullRequestId: run.pullRequestId,
        kind: 'review_run_completed',
        actorUserId: null,
        data: { runId: run.id, status: 'failed' }
      })
      return
    }
  }

  async function persistEngineResult(
    run: ReviewRunRecord,
    pullRequestId: string,
    engineResult: ReviewEngineResult
  ): Promise<void> {
    deps.reviewRuns.update(run.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      summary: engineResult.summary,
      highLevelFindings: engineResult.highLevelFindings.join('\n'),
      riskAssessment: engineResult.riskAssessment
    })

    for (const file of engineResult.fileComments) {
      for (const comment of file.hunkComments) {
        const range = deriveRangeFromHeader(comment.diffHunkHeader)
        const thread = deps.reviewThreads.create({
          pullRequestId,
          reviewRunId: run.id,
          filePath: file.filePath,
          diffStartLine: range.start,
          diffEndLine: range.end,
          fileLine: range.start
        })
        deps.reviewComments.create({
          threadId: thread.id,
          authorKind: 'agent',
          body: comment.comment,
          suggestedPatch: comment.suggestedPatch ?? null
        })
        deps.pullRequestEvents.insert({
          pullRequestId,
          kind: 'comment_added',
          actorUserId: null,
          data: { threadId: thread.id, runId: run.id }
        })
      }
    }

    deps.pullRequestEvents.insert({
      pullRequestId,
      kind: 'review_run_completed',
      actorUserId: null,
      data: { runId: run.id, status: 'completed' }
    })
  }
}

function deriveRangeFromHeader(header: string): { start: number; end: number } {
  const match = header.match(/\+(\d+)(?:,(\d+))?/) // use the added segment
  if (!match) {
    return { start: 0, end: 0 }
  }
  const start = Number(match[1])
  const span = match[2] ? Number(match[2]) : 1
  return {
    start,
    end: start + Math.max(span - 1, 0)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
