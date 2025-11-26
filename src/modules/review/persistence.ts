import type Database from 'better-sqlite3'
import crypto from 'crypto'
import type { PersistenceContext, PersistenceModule, Timestamp } from '../database'
import type {
  PullRequestCommitRecord,
  PullRequestEventKind,
  PullRequestEventRecord,
  PullRequestRecord,
  PullRequestStatus,
  ReviewCommentAuthorKind,
  ReviewCommentRecord,
  ReviewRunRecord,
  ReviewRunStatus,
  ReviewThreadRecord
} from './types'

export type PullRequestInsertInput = {
  id?: string
  projectId: string
  title: string
  description?: string | null
  sourceBranch: string
  targetBranch: string
  radiclePatchId?: string | null
  status?: PullRequestStatus
  authorUserId: string
}

export type PullRequestsRepository = {
  insert: (input: PullRequestInsertInput) => PullRequestRecord
  updateStatus: (
    id: string,
    status: PullRequestStatus,
    patch?: { mergedAt?: Timestamp | null; closedAt?: Timestamp | null }
  ) => void
  getById: (id: string) => PullRequestRecord | null
  listByProject: (projectId: string) => PullRequestRecord[]
  touch: (id: string) => void
}

export type PullRequestCommitInput = {
  id?: string
  commitHash: string
  message: string
  authorName: string
  authorEmail: string
  authoredAt: Timestamp
}

export type PullRequestCommitsRepository = {
  replaceAll: (pullRequestId: string, commits: PullRequestCommitInput[]) => PullRequestCommitRecord[]
  listByPullRequest: (pullRequestId: string) => PullRequestCommitRecord[]
}

export type PullRequestEventsRepository = {
  insert: (input: {
    id?: string
    pullRequestId: string
    kind: PullRequestEventKind
    actorUserId?: string | null
    data?: Record<string, unknown>
  }) => PullRequestEventRecord
  listByPullRequest: (pullRequestId: string) => PullRequestEventRecord[]
}

export type ReviewRunInsertInput = {
  id?: string
  pullRequestId: string
  trigger: ReviewRunRecord['trigger']
  runnerAgent?: ReviewRunRecord['runnerAgent']
  status?: ReviewRunStatus
}

export type ReviewRunsRepository = {
  insert: (input: ReviewRunInsertInput) => ReviewRunRecord
  update: (
    id: string,
    patch: Partial<Omit<ReviewRunRecord, 'id' | 'pullRequestId' | 'trigger' | 'runnerAgent'>>
  ) => void
  getById: (id: string) => ReviewRunRecord | null
  listByPullRequest: (pullRequestId: string) => ReviewRunRecord[]
  listByStatus: (status: ReviewRunStatus, limit?: number) => ReviewRunRecord[]
}

export type ReviewThreadsRepository = {
  create: (input: {
    id?: string
    pullRequestId: string
    reviewRunId?: string | null
    filePath: string
    diffStartLine: number
    diffEndLine: number
    fileLine?: number | null
  }) => ReviewThreadRecord
  listByPullRequest: (pullRequestId: string) => ReviewThreadRecord[]
  getById: (id: string) => ReviewThreadRecord | null
  markResolved: (threadId: string, resolved: boolean) => void
}

export type ReviewCommentsRepository = {
  create: (input: {
    id?: string
    threadId: string
    authorUserId?: string | null
    authorKind: ReviewCommentAuthorKind
    body: string
    suggestedPatch?: string | null
  }) => ReviewCommentRecord
  listByThreadIds: (threadIds: string[]) => ReviewCommentRecord[]
  getById: (id: string) => ReviewCommentRecord | null
}

export type ReviewBindings = {
  pullRequests: PullRequestsRepository
  pullRequestCommits: PullRequestCommitsRepository
  pullRequestEvents: PullRequestEventsRepository
  reviewRuns: ReviewRunsRepository
  reviewThreads: ReviewThreadsRepository
  reviewComments: ReviewCommentsRepository
}

export const reviewPersistence: PersistenceModule<ReviewBindings> = {
  name: 'review',
  applySchema: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pull_requests (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        source_branch TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        radicle_patch_id TEXT,
        status TEXT NOT NULL,
        author_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        merged_at TEXT,
        closed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS pull_request_commits (
        id TEXT PRIMARY KEY,
        pull_request_id TEXT NOT NULL,
        commit_hash TEXT NOT NULL,
        message TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_email TEXT NOT NULL,
        authored_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(pull_request_id) REFERENCES pull_requests(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS pull_request_events (
        id TEXT PRIMARY KEY,
        pull_request_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        actor_user_id TEXT,
        data TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(pull_request_id) REFERENCES pull_requests(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS review_runs (
        id TEXT PRIMARY KEY,
        pull_request_id TEXT NOT NULL,
        trigger TEXT NOT NULL,
        runner_agent TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        summary TEXT,
        high_level_findings TEXT,
        risk_assessment TEXT,
        runner_instance_id TEXT,
        logs_path TEXT,
        FOREIGN KEY(pull_request_id) REFERENCES pull_requests(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS review_threads (
        id TEXT PRIMARY KEY,
        pull_request_id TEXT NOT NULL,
        review_run_id TEXT,
        file_path TEXT NOT NULL,
        diff_start_line INTEGER NOT NULL,
        diff_end_line INTEGER NOT NULL,
        file_line INTEGER,
        resolved INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY(pull_request_id) REFERENCES pull_requests(id) ON DELETE CASCADE,
        FOREIGN KEY(review_run_id) REFERENCES review_runs(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS review_comments (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        author_user_id TEXT,
        author_kind TEXT NOT NULL,
        body TEXT NOT NULL,
        suggested_patch TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES review_threads(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_pull_requests_project ON pull_requests(project_id);
      CREATE INDEX IF NOT EXISTS idx_pull_request_commits_pr ON pull_request_commits(pull_request_id);
      CREATE INDEX IF NOT EXISTS idx_pull_request_events_pr ON pull_request_events(pull_request_id);
      CREATE INDEX IF NOT EXISTS idx_review_runs_pr ON review_runs(pull_request_id);
      CREATE INDEX IF NOT EXISTS idx_review_runs_status ON review_runs(status);
      CREATE INDEX IF NOT EXISTS idx_review_threads_pr ON review_threads(pull_request_id);
      CREATE INDEX IF NOT EXISTS idx_review_comments_thread ON review_comments(thread_id);
    `)
  },
  createBindings: ({ db }: PersistenceContext) => ({
    pullRequests: createPullRequestsRepository(db),
    pullRequestCommits: createPullRequestCommitsRepository(db),
    pullRequestEvents: createPullRequestEventsRepository(db),
    reviewRuns: createReviewRunsRepository(db),
    reviewThreads: createReviewThreadsRepository(db),
    reviewComments: createReviewCommentsRepository(db)
  })
}

function createPullRequestsRepository(db: Database.Database): PullRequestsRepository {
  const selectById = db.prepare('SELECT * FROM pull_requests WHERE id = ?')
  const listByProject = db.prepare('SELECT * FROM pull_requests WHERE project_id = ? ORDER BY created_at DESC')
  return {
    insert: (input) => {
      const now = new Date().toISOString()
      const id = input.id ?? crypto.randomUUID()
      db.prepare(
        `INSERT INTO pull_requests (
          id, project_id, title, description, source_branch, target_branch,
          radicle_patch_id, status, author_user_id, created_at, updated_at, merged_at, closed_at
        ) VALUES (@id, @projectId, @title, @description, @sourceBranch, @targetBranch,
          @radiclePatchId, @status, @authorUserId, @createdAt, @updatedAt, NULL, NULL)
        ON CONFLICT(id) DO UPDATE SET
          title=excluded.title,
          description=excluded.description,
          source_branch=excluded.source_branch,
          target_branch=excluded.target_branch,
          radicle_patch_id=excluded.radicle_patch_id,
          status=excluded.status,
          author_user_id=excluded.author_user_id,
          updated_at=excluded.updated_at`
      ).run({
        id,
        projectId: input.projectId,
        title: input.title,
        description: input.description ?? null,
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        radiclePatchId: input.radiclePatchId ?? null,
        status: input.status ?? 'open',
        authorUserId: input.authorUserId,
        createdAt: now,
        updatedAt: now
      })
      return mapPullRequest(selectById.get(id))
    },
    updateStatus: (id, status, patch) => {
      const now = new Date().toISOString()
      db.prepare(
        `UPDATE pull_requests
         SET status = @status,
             updated_at = @updatedAt,
             merged_at = COALESCE(@mergedAt, merged_at),
             closed_at = COALESCE(@closedAt, closed_at)
         WHERE id = @id`
      ).run({
        id,
        status,
        updatedAt: now,
        mergedAt: patch?.mergedAt ?? null,
        closedAt: patch?.closedAt ?? null
      })
    },
    getById: (id) => {
      const row = selectById.get(id)
      return row ? mapPullRequest(row) : null
    },
    listByProject: (projectId) => {
      return listByProject.all(projectId).map(mapPullRequest)
    },
    touch: (id) => {
      const now = new Date().toISOString()
      db.prepare('UPDATE pull_requests SET updated_at = ? WHERE id = ?').run(now, id)
    }
  }
}

function mapPullRequest(row: any): PullRequestRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description ?? null,
    sourceBranch: row.source_branch,
    targetBranch: row.target_branch,
    radiclePatchId: row.radicle_patch_id ?? null,
    status: row.status,
    authorUserId: row.author_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    mergedAt: row.merged_at ?? null,
    closedAt: row.closed_at ?? null
  }
}

function createPullRequestCommitsRepository(db: Database.Database): PullRequestCommitsRepository {
  const deleteByPr = db.prepare('DELETE FROM pull_request_commits WHERE pull_request_id = ?')
  const insert = db.prepare(
    `INSERT INTO pull_request_commits (
      id, pull_request_id, commit_hash, message, author_name, author_email, authored_at, created_at
    ) VALUES (@id, @pullRequestId, @commitHash, @message, @authorName, @authorEmail, @authoredAt, @createdAt)`
  )
  const select = db.prepare('SELECT * FROM pull_request_commits WHERE pull_request_id = ? ORDER BY created_at ASC')
  return {
    replaceAll: (pullRequestId, commits) => {
      const now = new Date().toISOString()
      const records: PullRequestCommitRecord[] = []
      const tx = db.transaction((items: PullRequestCommitInput[]) => {
        deleteByPr.run(pullRequestId)
        for (const commit of items) {
          const id = commit.id ?? crypto.randomUUID()
          insert.run({
            id,
            pullRequestId,
            commitHash: commit.commitHash,
            message: commit.message,
            authorName: commit.authorName,
            authorEmail: commit.authorEmail,
            authoredAt: commit.authoredAt,
            createdAt: now
          })
          records.push({
            id,
            pullRequestId,
            commitHash: commit.commitHash,
            message: commit.message,
            authorName: commit.authorName,
            authorEmail: commit.authorEmail,
            authoredAt: commit.authoredAt,
            createdAt: now
          })
        }
      })
      tx(commits)
      return records
    },
    listByPullRequest: (pullRequestId) => {
      return (select.all(pullRequestId) as any[]).map((row) => ({
        id: row.id,
        pullRequestId: row.pull_request_id,
        commitHash: row.commit_hash,
        message: row.message,
        authorName: row.author_name,
        authorEmail: row.author_email,
        authoredAt: row.authored_at,
        createdAt: row.created_at
      }))
    }
  }
}

function createPullRequestEventsRepository(db: Database.Database): PullRequestEventsRepository {
  const insertStmt = db.prepare(
    `INSERT INTO pull_request_events (id, pull_request_id, kind, actor_user_id, data, created_at)
     VALUES (@id, @pullRequestId, @kind, @actorUserId, @data, @createdAt)`
  )
  const selectStmt = db.prepare('SELECT * FROM pull_request_events WHERE pull_request_id = ? ORDER BY created_at ASC')
  return {
    insert: (input) => {
      const id = input.id ?? crypto.randomUUID()
      const record: PullRequestEventRecord = {
        id,
        pullRequestId: input.pullRequestId,
        kind: input.kind,
        actorUserId: input.actorUserId ?? null,
        createdAt: new Date().toISOString(),
        data: input.data ?? {}
      }
      insertStmt.run({
        id,
        pullRequestId: record.pullRequestId,
        kind: record.kind,
        actorUserId: record.actorUserId,
        data: JSON.stringify(record.data ?? {}),
        createdAt: record.createdAt
      })
      return record
    },
    listByPullRequest: (pullRequestId) => {
      return (selectStmt.all(pullRequestId) as any[]).map((row) => ({
        id: row.id,
        pullRequestId: row.pull_request_id,
        kind: row.kind,
        actorUserId: row.actor_user_id ?? null,
        createdAt: row.created_at,
        data: row.data ? safeParse(row.data) : {}
      }))
    }
  }
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>
    }
  } catch {
    // ignore
  }
  return {}
}

function createReviewRunsRepository(db: Database.Database): ReviewRunsRepository {
  const selectById = db.prepare('SELECT * FROM review_runs WHERE id = ?')
  return {
    insert: (input) => {
      const now = new Date().toISOString()
      const id = input.id ?? crypto.randomUUID()
      db.prepare(
        `INSERT INTO review_runs (
          id, pull_request_id, trigger, runner_agent, status, created_at
        ) VALUES (@id, @pullRequestId, @trigger, @runnerAgent, @status, @createdAt)
        ON CONFLICT(id) DO NOTHING`
      ).run({
        id,
        pullRequestId: input.pullRequestId,
        trigger: input.trigger,
        runnerAgent: input.runnerAgent ?? 'docker',
        status: input.status ?? 'queued',
        createdAt: now
      })
      return mapReviewRun(selectById.get(id))
    },
    update: (id, patch) => {
      const record = selectById.get(id)
      if (!record) return
      db.prepare(
        `UPDATE review_runs SET
          status = COALESCE(@status, status),
          completed_at = COALESCE(@completedAt, completed_at),
          summary = COALESCE(@summary, summary),
          high_level_findings = COALESCE(@highLevelFindings, high_level_findings),
          risk_assessment = COALESCE(@riskAssessment, risk_assessment),
          runner_instance_id = COALESCE(@runnerInstanceId, runner_instance_id),
          logs_path = COALESCE(@logsPath, logs_path)
        WHERE id = @id`
      ).run({
        id,
        status: patch.status ?? null,
        completedAt: patch.completedAt ?? null,
        summary: patch.summary ?? null,
        highLevelFindings: patch.highLevelFindings ?? null,
        riskAssessment: patch.riskAssessment ?? null,
        runnerInstanceId: patch.runnerInstanceId ?? null,
        logsPath: patch.logsPath ?? null
      })
    },
    getById: (id) => {
      const row = selectById.get(id)
      return row ? mapReviewRun(row) : null
    },
    listByPullRequest: (pullRequestId) => {
      const rows = db
        .prepare('SELECT * FROM review_runs WHERE pull_request_id = ? ORDER BY created_at DESC')
        .all(pullRequestId)
      return rows.map(mapReviewRun)
    },
    listByStatus: (status, limit = 10) => {
      const rows = db
        .prepare('SELECT * FROM review_runs WHERE status = ? ORDER BY created_at ASC LIMIT ?')
        .all(status, limit)
      return rows.map(mapReviewRun)
    }
  }
}

function mapReviewRun(row: any): ReviewRunRecord {
  return {
    id: row.id,
    pullRequestId: row.pull_request_id,
    trigger: row.trigger,
    runnerAgent: row.runner_agent,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? null,
    summary: row.summary ?? null,
    highLevelFindings: row.high_level_findings ?? null,
    riskAssessment: row.risk_assessment ?? null,
    runnerInstanceId: row.runner_instance_id ?? null,
    logsPath: row.logs_path ?? null
  }
}

function createReviewThreadsRepository(db: Database.Database): ReviewThreadsRepository {
  const selectByPr = db.prepare('SELECT * FROM review_threads WHERE pull_request_id = ? ORDER BY created_at ASC')
  const selectById = db.prepare('SELECT * FROM review_threads WHERE id = ?')
  return {
    create: (input) => {
      const now = new Date().toISOString()
      const id = input.id ?? crypto.randomUUID()
      db.prepare(
        `INSERT INTO review_threads (
          id, pull_request_id, review_run_id, file_path, diff_start_line, diff_end_line, file_line, resolved, created_at
        ) VALUES (@id, @pullRequestId, @reviewRunId, @filePath, @diffStartLine, @diffEndLine, @fileLine, @resolved, @createdAt)`
      ).run({
        id,
        pullRequestId: input.pullRequestId,
        reviewRunId: input.reviewRunId ?? null,
        filePath: input.filePath,
        diffStartLine: input.diffStartLine,
        diffEndLine: input.diffEndLine,
        fileLine: input.fileLine ?? null,
        resolved: 0,
        createdAt: now
      })
      return {
        id,
        pullRequestId: input.pullRequestId,
        reviewRunId: input.reviewRunId ?? null,
        filePath: input.filePath,
        diffStartLine: input.diffStartLine,
        diffEndLine: input.diffEndLine,
        fileLine: input.fileLine ?? null,
        resolved: false,
        createdAt: now,
        resolvedAt: null
      }
    },
    listByPullRequest: (pullRequestId) => {
      return (selectByPr.all(pullRequestId) as any[]).map((row) => ({
        id: row.id,
        pullRequestId: row.pull_request_id,
        reviewRunId: row.review_run_id ?? null,
        filePath: row.file_path,
        diffStartLine: row.diff_start_line,
        diffEndLine: row.diff_end_line,
        fileLine: row.file_line ?? null,
        resolved: Boolean(row.resolved),
        createdAt: row.created_at,
        resolvedAt: row.resolved_at ?? null
      }))
    },
    getById: (id) => {
      const row = selectById.get(id) as any
      if (!row) return null
      return {
        id: row.id,
        pullRequestId: row.pull_request_id,
        reviewRunId: row.review_run_id ?? null,
        filePath: row.file_path,
        diffStartLine: row.diff_start_line,
        diffEndLine: row.diff_end_line,
        fileLine: row.file_line ?? null,
        resolved: Boolean(row.resolved),
        createdAt: row.created_at,
        resolvedAt: row.resolved_at ?? null
      }
    },
    markResolved: (threadId, resolved) => {
      const now = resolved ? new Date().toISOString() : null
      db.prepare('UPDATE review_threads SET resolved = ?, resolved_at = ? WHERE id = ?').run(
        resolved ? 1 : 0,
        now,
        threadId
      )
    }
  }
}

function createReviewCommentsRepository(db: Database.Database): ReviewCommentsRepository {
  const selectById = db.prepare('SELECT * FROM review_comments WHERE id = ?')
  return {
    create: (input) => {
      const now = new Date().toISOString()
      const id = input.id ?? crypto.randomUUID()
      db.prepare(
        `INSERT INTO review_comments (id, thread_id, author_user_id, author_kind, body, suggested_patch, created_at)
         VALUES (@id, @threadId, @authorUserId, @authorKind, @body, @suggestedPatch, @createdAt)`
      ).run({
        id,
        threadId: input.threadId,
        authorUserId: input.authorUserId ?? null,
        authorKind: input.authorKind,
        body: input.body,
        suggestedPatch: input.suggestedPatch ?? null,
        createdAt: now
      })
      return {
        id,
        threadId: input.threadId,
        authorUserId: input.authorUserId ?? null,
        authorKind: input.authorKind,
        body: input.body,
        suggestedPatch: input.suggestedPatch ?? null,
        createdAt: now
      }
    },
    listByThreadIds: (threadIds) => {
      if (!threadIds.length) return []
      const placeholders = threadIds.map(() => '?').join(',')
      const statement = db.prepare(
        `SELECT * FROM review_comments WHERE thread_id IN (${placeholders}) ORDER BY created_at ASC`
      )
      const rows = statement.all(...threadIds) as any[]
      return rows.map((row) => ({
        id: row.id,
        threadId: row.thread_id,
        authorUserId: row.author_user_id ?? null,
        authorKind: row.author_kind,
        body: row.body,
        suggestedPatch: row.suggested_patch ?? null,
        createdAt: row.created_at
      }))
    },
    getById: (id) => {
      const row = selectById.get(id) as any
      if (!row) return null
      return {
        id: row.id,
        threadId: row.thread_id,
        authorUserId: row.author_user_id ?? null,
        authorKind: row.author_kind,
        body: row.body,
        suggestedPatch: row.suggested_patch ?? null,
        createdAt: row.created_at
      }
    }
  }
}
