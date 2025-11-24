import Database from 'better-sqlite3'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { reviewPersistence } from './persistence'

const now = () => new Date().toISOString()

describe('review persistence layer', () => {
  const dbFile = path.join(os.tmpdir(), `hyperagent-review-persistence-${Date.now()}.db`)
  const db = new Database(dbFile)
  reviewPersistence.applySchema(db)
  const bindings = reviewPersistence.createBindings({ db })

  afterAll(async () => {
    db.close()
    await fs.rm(dbFile, { force: true })
  })

  it('persists pull requests, commits, events, runs, threads, and comments cohesively', () => {
    const pullRequest = bindings.pullRequests.insert({
      projectId: 'proj-1',
      title: 'Improve diff parser',
      description: 'Adds safety checks',
      sourceBranch: 'feature/diff-parser',
      targetBranch: 'main',
      radiclePatchId: null,
      authorUserId: 'user-123'
    })

    const listed = bindings.pullRequests.listByProject('proj-1')
    expect(listed).toHaveLength(1)

    const beforeTouch = bindings.pullRequests.getById(pullRequest.id)
    bindings.pullRequests.touch(pullRequest.id)
    const afterTouch = bindings.pullRequests.getById(pullRequest.id)
    expect(beforeTouch?.updatedAt).not.toBe(afterTouch?.updatedAt)

    const mergedAt = now()
    bindings.pullRequests.updateStatus(pullRequest.id, 'merged', { mergedAt })
    const mergedRecord = bindings.pullRequests.getById(pullRequest.id)
    expect(mergedRecord?.status).toBe('merged')
    expect(mergedRecord?.mergedAt).toBe(mergedAt)

    const commits = bindings.pullRequestCommits.replaceAll(pullRequest.id, [
      {
        commitHash: 'abc123',
        message: 'Initial diff parser',
        authorName: 'Reviewer',
        authorEmail: 'reviewer@example.com',
        authoredAt: now()
      },
      {
        commitHash: 'def456',
        message: 'Tighten parsing',
        authorName: 'Reviewer',
        authorEmail: 'reviewer@example.com',
        authoredAt: now()
      }
    ])
    expect(commits.map((entry) => entry.commitHash)).toEqual(['abc123', 'def456'])

    const storedCommits = bindings.pullRequestCommits.listByPullRequest(pullRequest.id)
    expect(storedCommits).toHaveLength(2)
    expect(storedCommits[1].message).toBe('Tighten parsing')

    bindings.pullRequestEvents.insert({
      pullRequestId: pullRequest.id,
      kind: 'opened',
      actorUserId: 'user-123',
      data: { title: pullRequest.title }
    })
    bindings.pullRequestEvents.insert({
      pullRequestId: pullRequest.id,
      kind: 'commit_added',
      actorUserId: 'user-123',
      data: { commitHash: 'def456' }
    })
    const events = bindings.pullRequestEvents.listByPullRequest(pullRequest.id)
    expect(events).toHaveLength(2)
    expect(events[1].data.commitHash).toBe('def456')

    const run = bindings.reviewRuns.insert({ pullRequestId: pullRequest.id, trigger: 'manual' })
    expect(run.status).toBe('queued')
    bindings.reviewRuns.update(run.id, {
      status: 'completed',
      summary: 'All checks passed',
      highLevelFindings: 'None',
      riskAssessment: 'low',
      completedAt: now()
    })
    const completed = bindings.reviewRuns.getById(run.id)
    expect(completed?.status).toBe('completed')
    expect(completed?.summary).toBe('All checks passed')
    expect(bindings.reviewRuns.listByStatus('completed')).toHaveLength(1)

    const thread = bindings.reviewThreads.create({
      pullRequestId: pullRequest.id,
      reviewRunId: run.id,
      filePath: 'src/index.ts',
      diffStartLine: 10,
      diffEndLine: 12,
      fileLine: 10
    })
    expect(thread.resolved).toBe(false)

    bindings.reviewThreads.markResolved(thread.id, true)
    const resolvedThread = bindings.reviewThreads.getById(thread.id)
    expect(resolvedThread?.resolved).toBe(true)
    expect(bindings.reviewThreads.listByPullRequest(pullRequest.id)).toHaveLength(1)

    const comment = bindings.reviewComments.create({
      threadId: thread.id,
      authorKind: 'agent',
      body: 'Consider using a streaming parser',
      suggestedPatch: '--- a/src/index.ts\n+++ b/src/index.ts\n@@\n-console.log("hi")\n+console.log("hello")\n'
    })
    const fetchedComment = bindings.reviewComments.getById(comment.id)
    expect(fetchedComment?.body).toContain('streaming parser')

    const comments = bindings.reviewComments.listByThreadIds([thread.id])
    expect(comments).toHaveLength(1)
    expect(comments[0].suggestedPatch).toContain('console.log')
  })
})
