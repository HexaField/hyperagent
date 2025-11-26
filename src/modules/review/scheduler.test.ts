import Database from 'better-sqlite3'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectRecord } from '../projects'
import { reviewPersistence } from './persistence'
import { createReviewSchedulerModule } from './scheduler'
import type { PullRequestCommitRecord, PullRequestRecord, ReviewEngineResult } from './types'

type ReviewRepos = ReturnType<typeof reviewPersistence.createBindings>

type DisposableDb = {
  dbFile: string
  close: () => Promise<void>
  repos: ReviewRepos
}

const makeDb = (): DisposableDb => {
  const dbFile = path.join(os.tmpdir(), `review-scheduler-${process.pid}-${Date.now()}.db`)
  const db = new Database(dbFile)
  reviewPersistence.applySchema(db)
  const repos = reviewPersistence.createBindings({ db })
  return {
    dbFile,
    repos,
    close: async () => {
      db.close()
      await fs.rm(dbFile, { force: true })
    }
  }
}

describe('review scheduler', () => {
  let disposable: DisposableDb | null = null

  afterEach(async () => {
    if (disposable) {
      await disposable.close()
      disposable = null
    }
  })

  it('processes queued runs and persists review findings', async () => {
    disposable = makeDb()
    const { repos } = disposable

    const pullRequest: PullRequestRecord = {
      id: 'pr-123',
      projectId: 'proj-1',
      title: 'Refine scheduler',
      description: 'Adds coverage',
      sourceBranch: 'feature/review',
      targetBranch: 'main',
      radiclePatchId: null,
      status: 'open',
      authorUserId: 'user-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mergedAt: null,
      closedAt: null
    }
    const project: ProjectRecord = {
      id: pullRequest.projectId,
      name: 'Test project',
      description: null,
      repositoryPath: '/tmp/fake',
      repositoryProvider: 'git',
      defaultBranch: 'main',
      createdAt: new Date().toISOString()
    }
    const commits: PullRequestCommitRecord[] = [
      {
        id: 'commit-1',
        pullRequestId: pullRequest.id,
        commitHash: 'abc123',
        message: 'Initial work',
        authorName: 'Tester',
        authorEmail: 'tester@example.com',
        authoredAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      }
    ]

    repos.pullRequests.insert({
      id: pullRequest.id,
      projectId: pullRequest.projectId,
      title: pullRequest.title,
      description: pullRequest.description,
      sourceBranch: pullRequest.sourceBranch,
      targetBranch: pullRequest.targetBranch,
      radiclePatchId: pullRequest.radiclePatchId,
      status: pullRequest.status,
      authorUserId: pullRequest.authorUserId
    })

    const pullRequestModule = {
      getPullRequestWithCommits: vi.fn().mockResolvedValue({
        pullRequest,
        project,
        commits,
        events: []
      })
    }

    const diffModule = {
      getPullRequestDiff: vi.fn().mockResolvedValue([
        {
          path: 'src/index.ts',
          status: 'modified',
          hunks: [
            {
              header: '@@ -1,3 +1,4 @@',
              oldStart: 1,
              newStart: 1,
              oldLines: 3,
              newLines: 4,
              lines: [
                { type: 'context', content: 'const a = 1', oldLineNumber: 1, newLineNumber: 1 },
                { type: 'added', content: 'const b = 2', newLineNumber: 2 }
              ]
            }
          ]
        }
      ])
    }

    const engineResult: ReviewEngineResult = {
      summary: 'Automated summary',
      highLevelFindings: ['Potential risk area uncovered'],
      riskAssessment: 'medium',
      fileComments: [
        {
          filePath: 'src/index.ts',
          hunkComments: [
            {
              diffHunkHeader: '@@ -1,3 +1,4 @@',
              comment: 'Consider extracting helper for readability.',
              severity: 'warning',
              suggestedPatch: '--- a/src/index.ts\n+++ b/src/index.ts\n@@\n-const a = 1\n+const value = 1\n'
            }
          ]
        }
      ]
    }
    const reviewEngine = {
      reviewPullRequest: vi.fn().mockResolvedValue(engineResult)
    }

    const runnerGateway = {
      enqueue: vi.fn().mockResolvedValue(undefined)
    }

    const scheduler = createReviewSchedulerModule({
      reviewRuns: repos.reviewRuns,
      reviewThreads: repos.reviewThreads,
      reviewComments: repos.reviewComments,
      pullRequestEvents: repos.pullRequestEvents,
      pullRequestModule: pullRequestModule as any,
      diffModule: diffModule as any,
      reviewEngine: reviewEngine as any,
      runnerGateway: runnerGateway as any,
      pollIntervalMs: 5
    })

    const run = await scheduler.requestReview(pullRequest.id, 'manual')
    expect(run.status).toBe('queued')
    expect(runnerGateway.enqueue).toHaveBeenCalledTimes(1)
    const enqueuePayload = runnerGateway.enqueue.mock.calls[0][0]
    expect(enqueuePayload.run.id).toBe(run.id)
    expect(enqueuePayload.pullRequest.id).toBe(pullRequest.id)
    expect(enqueuePayload.project.id).toBe(project.id)

    await scheduler.processPendingRuns()
    expect(runnerGateway.enqueue).toHaveBeenCalledTimes(1)

    await scheduler.runRunById(run.id)

    const storedRun = repos.reviewRuns.getById(run.id)
    expect(storedRun?.status).toBe('completed')
    expect(storedRun?.summary).toBe('Automated summary')
    expect(storedRun?.highLevelFindings).toContain('Potential risk area uncovered')

    const threads = repos.reviewThreads.listByPullRequest(pullRequest.id)
    expect(threads).toHaveLength(1)
    expect(threads[0].diffStartLine).toBe(1)
    expect(threads[0].diffEndLine).toBe(4)

    const comments = repos.reviewComments.listByThreadIds([threads[0].id])
    expect(comments).toHaveLength(1)
    expect(comments[0].body).toContain('Consider extracting helper')
    expect(comments[0].suggestedPatch).toContain('src/index.ts')

    const eventKinds = repos.pullRequestEvents.listByPullRequest(pullRequest.id).map((event) => event.kind)
    expect(eventKinds).toEqual(['review_requested', 'review_run_started', 'comment_added', 'review_run_completed'])

    expect(pullRequestModule.getPullRequestWithCommits).toHaveBeenCalledWith(pullRequest.id)
    expect(diffModule.getPullRequestDiff).toHaveBeenCalledTimes(1)
    expect(reviewEngine.reviewPullRequest).toHaveBeenCalledTimes(1)
  })
})
