import { Router, type Request, type RequestHandler } from 'express'
import type { Persistence, ProjectRecord } from '../../../src/modules/database'
import type { ReviewRunTrigger } from '../../../src/modules/review/types'

type PullRequestModule = ReturnType<typeof import('../../../src/modules/review/pullRequest').createPullRequestModule>
type ReviewSchedulerModule = ReturnType<
  typeof import('../../../src/modules/review/scheduler').createReviewSchedulerModule
>
type DiffModule = ReturnType<typeof import('../../../src/modules/review/diff').createDiffModule>

type ApplyPatchToBranch = (
  repositoryPath: string,
  branch: string,
  patch: string,
  commitMessage: string
) => Promise<string>

type AsyncWrapper = (handler: RequestHandler) => RequestHandler

type VersionControlRouterOptions = {
  wrapAsync: AsyncWrapper
  persistence: Persistence
  pullRequestModule: PullRequestModule
  reviewScheduler: ReviewSchedulerModule
  diffModule: DiffModule
  applyPatchToBranch: ApplyPatchToBranch
  resolveUserIdFromRequest: (req: Request) => string
  validateReviewRunnerToken: (req: Request) => boolean
}

const normalizeReviewTrigger = (value: unknown): ReviewRunTrigger => {
  if (value === 'auto_on_open' || value === 'auto_on_update') {
    return value
  }
  return 'manual'
}

export const createVersionControlRouter = (options: VersionControlRouterOptions) => {
  const {
    wrapAsync,
    persistence,
    pullRequestModule,
    reviewScheduler,
    diffModule,
    applyPatchToBranch,
    resolveUserIdFromRequest,
    validateReviewRunnerToken
  } = options

  const router = Router()

  const listProjectPullRequestsHandler: RequestHandler = (req, res) => {
    const projectId = req.params.projectId
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' })
      return
    }
    const project = persistence.projects.getById(projectId)
    if (!project) {
      res.status(404).json({ error: 'Unknown project' })
      return
    }
    const pullRequests = pullRequestModule.listPullRequests(projectId).map((pullRequest) => {
      const runs = persistence.reviewRuns.listByPullRequest(pullRequest.id)
      return {
        ...pullRequest,
        latestReviewRun: runs.length ? runs[0] : null
      }
    })
    res.json({ project, pullRequests })
  }

  const listActiveReviewsHandler: RequestHandler = (_req, res) => {
    const projects = persistence.projects.list()
    const groups: Array<{ project: ProjectRecord; pullRequests: Array<Record<string, unknown>> }> = []
    projects.forEach((project) => {
      const pullRequests = pullRequestModule
        .listPullRequests(project.id)
        .filter((pullRequest) => pullRequest.status === 'open')
        .map((pullRequest) => {
          const runs = persistence.reviewRuns.listByPullRequest(pullRequest.id)
          return {
            ...pullRequest,
            latestReviewRun: runs.length ? runs[0] : null
          }
        })
      if (pullRequests.length) {
        groups.push({ project, pullRequests })
      }
    })
    res.json({ groups })
  }

  const createProjectPullRequestHandler: RequestHandler = async (req, res) => {
    const projectId = req.params.projectId
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' })
      return
    }
    const project = persistence.projects.getById(projectId)
    if (!project) {
      res.status(404).json({ error: 'Unknown project' })
      return
    }
    const { title, description, sourceBranch, targetBranch, radiclePatchId } = req.body ?? {}
    if (typeof title !== 'string' || !title.trim().length) {
      res.status(400).json({ error: 'title is required' })
      return
    }
    if (typeof sourceBranch !== 'string' || !sourceBranch.trim().length) {
      res.status(400).json({ error: 'sourceBranch is required' })
      return
    }
    const authorUserId = resolveUserIdFromRequest(req)
    try {
      const record = await pullRequestModule.createPullRequest({
        projectId: project.id,
        title: title.trim(),
        description: typeof description === 'string' ? description : undefined,
        sourceBranch: sourceBranch.trim(),
        targetBranch: typeof targetBranch === 'string' && targetBranch.trim().length ? targetBranch.trim() : undefined,
        radiclePatchId:
          typeof radiclePatchId === 'string' && radiclePatchId.trim().length ? radiclePatchId.trim() : undefined,
        authorUserId
      })
      res.status(201).json({ pullRequest: record })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create pull request'
      res.status(500).json({ error: message })
    }
  }

  const pullRequestDetailHandler: RequestHandler = async (req, res) => {
    const prId = req.params.prId
    if (!prId) {
      res.status(400).json({ error: 'pull request id is required' })
      return
    }
    const detail = await pullRequestModule.getPullRequestWithCommits(prId)
    if (!detail) {
      res.status(404).json({ error: 'Unknown pull request' })
      return
    }
    const reviewRuns = persistence.reviewRuns.listByPullRequest(prId)
    res.json({
      project: detail.project,
      pullRequest: detail.pullRequest,
      commits: detail.commits,
      events: detail.events,
      reviewRuns
    })
  }

  const pullRequestDiffHandler: RequestHandler = async (req, res) => {
    const prId = req.params.prId
    if (!prId) {
      res.status(400).json({ error: 'pull request id is required' })
      return
    }
    const detail = await pullRequestModule.getPullRequestWithCommits(prId)
    if (!detail) {
      res.status(404).json({ error: 'Unknown pull request' })
      return
    }
    try {
      const diff = await diffModule.getPullRequestDiff(detail.pullRequest, detail.project)
      res.json({ pullRequestId: prId, diff })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to compute diff'
      res.status(500).json({ error: message })
    }
  }

  const pullRequestThreadsHandler: RequestHandler = (req, res) => {
    const prId = req.params.prId
    if (!prId) {
      res.status(400).json({ error: 'pull request id is required' })
      return
    }
    const pullRequest = persistence.pullRequests.getById(prId)
    if (!pullRequest) {
      res.status(404).json({ error: 'Unknown pull request' })
      return
    }
    const threads = persistence.reviewThreads.listByPullRequest(prId)
    const comments = persistence.reviewComments.listByThreadIds(threads.map((thread) => thread.id))
    const commentMap = new Map<string, typeof comments>()
    comments.forEach((comment) => {
      const existing = commentMap.get(comment.threadId) ?? []
      existing.push(comment)
      commentMap.set(comment.threadId, existing)
    })
    res.json({
      pullRequest,
      threads: threads.map((thread) => ({
        ...thread,
        comments: commentMap.get(thread.id) ?? []
      }))
    })
  }

  const addThreadCommentHandler: RequestHandler = (req, res) => {
    const threadId = req.params.threadId
    if (!threadId) {
      res.status(400).json({ error: 'threadId is required' })
      return
    }
    const thread = persistence.reviewThreads.getById(threadId)
    if (!thread) {
      res.status(404).json({ error: 'Unknown review thread' })
      return
    }
    const bodyText = typeof req.body?.body === 'string' ? req.body.body.trim() : ''
    if (!bodyText.length) {
      res.status(400).json({ error: 'body is required' })
      return
    }
    const authorKind = req.body?.authorKind === 'agent' ? 'agent' : 'user'
    const authorUserId = authorKind === 'agent' ? null : resolveUserIdFromRequest(req)
    const suggestedPatch =
      typeof req.body?.suggestedPatch === 'string' && req.body.suggestedPatch.trim().length
        ? req.body.suggestedPatch
        : null
    const comment = persistence.reviewComments.create({
      threadId,
      authorKind,
      authorUserId,
      body: bodyText,
      suggestedPatch
    })
    persistence.pullRequestEvents.insert({
      pullRequestId: thread.pullRequestId,
      kind: 'comment_added',
      actorUserId: authorUserId,
      data: { threadId, commentId: comment.id }
    })
    res.status(201).json({ comment })
  }

  const resolveThreadHandler: RequestHandler = (req, res) => {
    const threadId = req.params.threadId
    if (!threadId) {
      res.status(400).json({ error: 'threadId is required' })
      return
    }
    const thread = persistence.reviewThreads.getById(threadId)
    if (!thread) {
      res.status(404).json({ error: 'Unknown review thread' })
      return
    }
    const resolvedState = typeof req.body?.resolved === 'boolean' ? req.body.resolved : true
    persistence.reviewThreads.markResolved(threadId, resolvedState)
    const actorUserId = resolveUserIdFromRequest(req)
    persistence.pullRequestEvents.insert({
      pullRequestId: thread.pullRequestId,
      kind: 'comment_resolved',
      actorUserId,
      data: { threadId, resolved: resolvedState }
    })
    res.json({ threadId, resolved: resolvedState })
  }

  const triggerPullRequestReviewHandler: RequestHandler = async (req, res) => {
    const prId = req.params.prId
    if (!prId) {
      res.status(400).json({ error: 'pull request id is required' })
      return
    }
    const pullRequest = persistence.pullRequests.getById(prId)
    if (!pullRequest) {
      res.status(404).json({ error: 'Unknown pull request' })
      return
    }
    const trigger = normalizeReviewTrigger(req.body?.trigger)
    try {
      const run = await reviewScheduler.requestReview(prId, trigger)
      res.status(202).json({ run })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to request review'
      res.status(500).json({ error: message })
    }
  }

  const mergePullRequestHandler: RequestHandler = async (req, res) => {
    const prId = req.params.prId
    if (!prId) {
      res.status(400).json({ error: 'pull request id is required' })
      return
    }
    const pullRequest = persistence.pullRequests.getById(prId)
    if (!pullRequest) {
      res.status(404).json({ error: 'Unknown pull request' })
      return
    }
    const actorUserId = resolveUserIdFromRequest(req)
    try {
      await pullRequestModule.mergePullRequest(prId, actorUserId)
      res.json({ pullRequestId: prId, status: 'merged' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to merge pull request'
      res.status(500).json({ error: message })
    }
  }

  const closePullRequestHandler: RequestHandler = async (req, res) => {
    const prId = req.params.prId
    if (!prId) {
      res.status(400).json({ error: 'pull request id is required' })
      return
    }
    const pullRequest = persistence.pullRequests.getById(prId)
    if (!pullRequest) {
      res.status(404).json({ error: 'Unknown pull request' })
      return
    }
    const actorUserId = resolveUserIdFromRequest(req)
    try {
      await pullRequestModule.closePullRequest(prId, actorUserId)
      res.json({ pullRequestId: prId, status: 'closed' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to close pull request'
      res.status(500).json({ error: message })
    }
  }

  const applySuggestionHandler: RequestHandler = async (req, res) => {
    const prId = req.params.prId
    if (!prId) {
      res.status(400).json({ error: 'pull request id is required' })
      return
    }
    const commentId = typeof req.body?.commentId === 'string' ? req.body.commentId.trim() : ''
    if (!commentId.length) {
      res.status(400).json({ error: 'commentId is required' })
      return
    }
    const detail = await pullRequestModule.getPullRequestWithCommits(prId)
    if (!detail) {
      res.status(404).json({ error: 'Unknown pull request' })
      return
    }
    const comment = persistence.reviewComments.getById(commentId)
    if (!comment || !comment.suggestedPatch) {
      res.status(404).json({ error: 'Review comment does not contain a suggestion' })
      return
    }
    const thread = persistence.reviewThreads.getById(comment.threadId)
    if (!thread || thread.pullRequestId !== prId) {
      res.status(400).json({ error: 'Comment does not belong to this pull request' })
      return
    }
    const commitMessage =
      typeof req.body?.commitMessage === 'string' && req.body.commitMessage.trim().length
        ? req.body.commitMessage.trim()
        : `Apply suggestion from review comment ${comment.id}`
    try {
      const commitHash = await applyPatchToBranch(
        detail.project.repositoryPath,
        detail.pullRequest.sourceBranch,
        comment.suggestedPatch,
        commitMessage
      )
      await pullRequestModule.updatePullRequestCommits(prId)
      res.json({ pullRequestId: prId, commitHash })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to apply suggestion'
      res.status(500).json({ error: message })
    }
  }

  const reviewRunCallbackHandler: RequestHandler = async (req, res) => {
    const runId = req.params.runId
    if (!runId) {
      res.status(400).json({ error: 'runId is required' })
      return
    }
    if (!validateReviewRunnerToken(req)) {
      res.status(401).json({ error: 'Invalid runner token' })
      return
    }
    const run = persistence.reviewRuns.getById(runId)
    if (!run) {
      res.status(404).json({ error: 'Unknown review run' })
      return
    }
    const status = typeof req.body?.status === 'string' ? req.body.status : 'completed'
    if (status === 'failed') {
      const summary =
        typeof req.body?.error === 'string' && req.body.error.trim().length
          ? req.body.error.trim()
          : 'Review runner reported failure'
      persistence.reviewRuns.update(runId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        summary,
        logsPath: typeof req.body?.logsPath === 'string' ? req.body.logsPath : undefined
      })
      persistence.pullRequestEvents.insert({
        pullRequestId: run.pullRequestId,
        kind: 'review_run_completed',
        actorUserId: null,
        data: { runId, status: 'failed' }
      })
      res.json({ ok: true })
      return
    }
    await reviewScheduler.runRunById(runId)
    if (typeof req.body?.logsPath === 'string' && req.body.logsPath.trim().length) {
      persistence.reviewRuns.update(runId, { logsPath: req.body.logsPath.trim() })
    }
    res.json({ ok: true })
  }

  router.get('/api/projects/:projectId/pull-requests', wrapAsync(listProjectPullRequestsHandler))
  router.get('/api/reviews/active', wrapAsync(listActiveReviewsHandler))
  router.post('/api/projects/:projectId/pull-requests', wrapAsync(createProjectPullRequestHandler))
  router.get('/api/pull-requests/:prId', wrapAsync(pullRequestDetailHandler))
  router.get('/api/pull-requests/:prId/diff', wrapAsync(pullRequestDiffHandler))
  router.get('/api/pull-requests/:prId/threads', wrapAsync(pullRequestThreadsHandler))
  router.post('/api/threads/:threadId/comments', wrapAsync(addThreadCommentHandler))
  router.post('/api/threads/:threadId/resolve', wrapAsync(resolveThreadHandler))
  router.post('/api/pull-requests/:prId/reviews', wrapAsync(triggerPullRequestReviewHandler))
  router.post('/api/pull-requests/:prId/merge', wrapAsync(mergePullRequestHandler))
  router.post('/api/pull-requests/:prId/close', wrapAsync(closePullRequestHandler))
  router.post('/api/pull-requests/:prId/apply-suggestion', wrapAsync(applySuggestionHandler))
  router.post('/api/review-runs/:runId/callback', wrapAsync(reviewRunCallbackHandler))

  return router
}
