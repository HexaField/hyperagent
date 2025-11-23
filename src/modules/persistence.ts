import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export type Timestamp = string

export type ProjectRecord = {
  id: string
  name: string
  description: string | null
  repositoryPath: string
  repositoryProvider: string | null
  defaultBranch: string
  createdAt: Timestamp
}

export type WorkflowStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type WorkflowKind = 'new_project' | 'refactor' | 'bugfix' | 'custom'

export type WorkflowRecord = {
  id: string
  projectId: string
  plannerRunId: string | null
  kind: WorkflowKind | string
  status: WorkflowStatus
  data: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
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
  updatedAt: Timestamp
}

export type AgentRunStatus = 'running' | 'succeeded' | 'failed'

export type AgentRunRecord = {
  id: string
  workflowStepId: string | null
  projectId: string
  branch: string
  type: string
  status: AgentRunStatus
  startedAt: Timestamp
  finishedAt: Timestamp | null
  logsPath: string | null
}

export type CodeServerSessionStatus = 'running' | 'stopped'

export type CodeServerSessionRecord = {
  id: string
  projectId: string
  branch: string
  workspacePath: string
  url: string
  authToken: string
  processId: number | null
  status: CodeServerSessionStatus
  startedAt: Timestamp
  stoppedAt: Timestamp | null
}

export type RadicleRegistrationRecord = {
  repositoryPath: string
  name: string | null
  description: string | null
  visibility: 'public' | 'private' | null
  defaultBranch: string | null
  registeredAt: Timestamp
}

export type ProjectInput = {
  id?: string
  name: string
  description?: string
  repositoryPath: string
  repositoryProvider?: string
  defaultBranch?: string
}

export type WorkflowInput = {
  id?: string
  projectId: string
  plannerRunId?: string | null
  kind?: WorkflowKind | string
  status?: WorkflowStatus
  data?: Record<string, unknown>
}

export type WorkflowStepInput = {
  id?: string
  taskId?: string | null
  sequence: number
  dependsOn?: string[]
  data?: Record<string, unknown>
}

export type AgentRunInput = {
  id?: string
  workflowStepId?: string | null
  projectId: string
  branch: string
  type: string
  status?: AgentRunStatus
  logsPath?: string | null
}

export type CodeServerSessionInput = {
  id?: string
  projectId: string
  branch: string
  workspacePath: string
  url: string
  authToken: string
  processId?: number | null
}

export type RadicleRegistrationInput = {
  repositoryPath: string
  name?: string | null
  description?: string | null
  visibility?: 'public' | 'private' | null
  defaultBranch?: string | null
}

export type PersistenceOptions = {
  file?: string
}

export type ProjectsRepository = {
  upsert: (input: ProjectInput) => ProjectRecord
  getById: (id: string) => ProjectRecord | null
  list: () => ProjectRecord[]
}

export type WorkflowsRepository = {
  insert: (input: WorkflowInput) => WorkflowRecord
  updateStatus: (id: string, status: WorkflowStatus) => void
  getById: (id: string) => WorkflowRecord | null
  list: (projectId?: string) => WorkflowRecord[]
}

export type WorkflowStepsRepository = {
  insertMany: (workflowId: string, steps: WorkflowStepInput[]) => WorkflowStepRecord[]
  listByWorkflow: (workflowId: string) => WorkflowStepRecord[]
  findReady: (limit?: number) => WorkflowStepRecord[]
  claim: (stepId: string) => boolean
  update: (stepId: string, patch: Partial<Pick<WorkflowStepRecord, 'status' | 'result'>>) => void
}

export type AgentRunsRepository = {
  create: (input: AgentRunInput) => AgentRunRecord
  update: (id: string, patch: Partial<Pick<AgentRunRecord, 'status' | 'finishedAt' | 'logsPath'>>) => void
  listByWorkflow: (workflowId: string) => AgentRunRecord[]
}

export type CodeServerSessionsRepository = {
  upsert: (input: CodeServerSessionInput) => CodeServerSessionRecord
  markStopped: (id: string) => void
  findByProjectAndBranch: (projectId: string, branch: string) => CodeServerSessionRecord | null
  listActive: () => CodeServerSessionRecord[]
  resetAllRunning: () => void
}

export type RadicleRegistrationsRepository = {
  upsert: (input: RadicleRegistrationInput) => RadicleRegistrationRecord
  list: () => RadicleRegistrationRecord[]
}

export type Persistence = {
  db: Database.Database
  projects: ProjectsRepository
  workflows: WorkflowsRepository
  workflowSteps: WorkflowStepsRepository
  agentRuns: AgentRunsRepository
  codeServerSessions: CodeServerSessionsRepository
  radicleRegistrations: RadicleRegistrationsRepository
}

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'hyperagent.db')

export function createPersistence (options: PersistenceOptions = {}): Persistence {
  const file = options.file ?? DEFAULT_DB_PATH
  ensureParentDir(file)
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  applyMigrations(db)

  const projects: ProjectsRepository = {
    upsert: (input) => {
      const now = new Date().toISOString()
      const id = input.id ?? crypto.randomUUID()
      const stmt = db.prepare(
        `INSERT INTO projects (id, name, description, repository_path, repository_provider, default_branch, created_at)
         VALUES (@id, @name, @description, @repositoryPath, @repositoryProvider, @defaultBranch, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name,
           description=excluded.description,
           repository_path=excluded.repository_path,
           repository_provider=excluded.repository_provider,
           default_branch=excluded.default_branch`
      )
      stmt.run({
        id,
        name: input.name,
        description: input.description ?? null,
        repositoryPath: input.repositoryPath,
        repositoryProvider: input.repositoryProvider ?? null,
        defaultBranch: input.defaultBranch ?? 'main',
        createdAt: now
      })
      const record = db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
      return mapProject(record)
    },
    getById: (id) => {
      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
      return row ? mapProject(row) : null
    },
    list: () => {
      const rows = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all()
      return rows.map(mapProject)
    }
  }

  const workflows: WorkflowsRepository = {
    insert: (input) => {
      const now = new Date().toISOString()
      const id = input.id ?? crypto.randomUUID()
      db.prepare(
        `INSERT INTO workflows (id, project_id, planner_run_id, kind, status, data, created_at, updated_at)
         VALUES (@id, @projectId, @plannerRunId, @kind, @status, @data, @createdAt, @updatedAt)`
      ).run({
        id,
        projectId: input.projectId,
        plannerRunId: input.plannerRunId ?? null,
        kind: input.kind ?? 'custom',
        status: input.status ?? 'pending',
        data: JSON.stringify(input.data ?? {}),
        createdAt: now,
        updatedAt: now
      })
      const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id)
      return mapWorkflow(row)
    },
    updateStatus: (id, status) => {
      db.prepare('UPDATE workflows SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id)
    },
    getById: (id) => {
      const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id)
      return row ? mapWorkflow(row) : null
    },
    list: (projectId) => {
      const rows = projectId
        ? db.prepare('SELECT * FROM workflows WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
        : db.prepare('SELECT * FROM workflows ORDER BY created_at DESC').all()
      return rows.map(mapWorkflow)
    }
  }

  const workflowSteps: WorkflowStepsRepository = {
    insertMany: (workflowId, steps) => {
      const insert = db.prepare(
        `INSERT INTO workflow_steps (id, workflow_id, task_id, status, sequence, depends_on, data, result, updated_at)
         VALUES (@id, @workflowId, @taskId, @status, @sequence, @dependsOn, @data, NULL, @updatedAt)`
      )
      const now = new Date().toISOString()
      const records: WorkflowStepRecord[] = []
      const tx = db.transaction((batch: WorkflowStepInput[]) => {
        for (const step of batch) {
          const id = step.id ?? crypto.randomUUID()
          insert.run({
            id,
            workflowId,
            taskId: step.taskId ?? null,
            status: 'pending',
            sequence: step.sequence,
            dependsOn: JSON.stringify(step.dependsOn ?? []),
            data: JSON.stringify(step.data ?? {}),
            updatedAt: now
          })
          const row = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(id)
          records.push(mapWorkflowStep(row))
        }
      })
      tx(steps)
      return records
    },
    listByWorkflow: (workflowId) => {
      const rows = db
        .prepare('SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY sequence ASC')
        .all(workflowId)
      return rows.map(mapWorkflowStep)
    },
    findReady: (limit = 10) => {
      const rows = db
        .prepare(
          `SELECT ws.*, w.status as workflow_status
           FROM workflow_steps ws
           JOIN workflows w ON ws.workflow_id = w.id
           WHERE ws.status = 'pending'
           ORDER BY ws.sequence ASC`
        )
        .all()
      const steps = (rows as Array<Record<string, unknown> & { workflow_status: WorkflowStatus }>)
        .filter(row => row.workflow_status === 'running')
        .map(mapWorkflowStep)
      const ready: WorkflowStepRecord[] = []
      for (const step of steps) {
        if (ready.length >= limit) break
        const deps = step.dependsOn
        if (!deps.length) {
          ready.push(step)
          continue
        }
        const depStatuses = db
          .prepare(
            `SELECT id, status FROM workflow_steps WHERE workflow_id = ? AND id IN (${deps.map(() => '?').join(',')})`
          )
          .all(step.workflowId, ...deps) as Array<{ status: WorkflowStepStatus }>
        const satisfied = depStatuses.every(dep => dep.status === 'completed')
        if (satisfied) {
          ready.push(step)
        }
      }
      return ready
    },
    claim: (stepId) => {
      const res = db
        .prepare(
          `UPDATE workflow_steps
           SET status = 'running', updated_at = ?
           WHERE id = ? AND status = 'pending'`
        )
        .run(new Date().toISOString(), stepId)
      return res.changes > 0
    },
    update: (stepId, patch) => {
      const current = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(stepId) as any
      if (!current) return
      const nextStatus = patch.status ?? current.status
      const nextResult = patch.result ? JSON.stringify(patch.result) : current.result
      db.prepare(
        `UPDATE workflow_steps
         SET status = ?, result = ?, updated_at = ?
         WHERE id = ?`
      ).run(nextStatus, nextResult, new Date().toISOString(), stepId)
    }
  }

  const agentRuns: AgentRunsRepository = {
    create: (input) => {
      const id = input.id ?? crypto.randomUUID()
      const startedAt = new Date().toISOString()
      db.prepare(
        `INSERT INTO agent_runs (id, workflow_step_id, project_id, branch, type, status, started_at, finished_at, logs_path)
         VALUES (@id, @workflowStepId, @projectId, @branch, @type, @status, @startedAt, NULL, @logsPath)`
      ).run({
        id,
        workflowStepId: input.workflowStepId ?? null,
        projectId: input.projectId,
        branch: input.branch,
        type: input.type,
        status: input.status ?? 'running',
        startedAt,
        logsPath: input.logsPath ?? null
      })
      const row = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id)
      return mapAgentRun(row)
    },
    update: (id, patch) => {
      const record = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as any
      if (!record) return
      db.prepare(
        `UPDATE agent_runs
         SET status = ?, finished_at = ?, logs_path = ?
         WHERE id = ?`
      ).run(patch.status ?? record.status, patch.finishedAt ?? record.finished_at, patch.logsPath ?? record.logs_path, id)
    },
    listByWorkflow: (workflowId) => {
      const rows = db
        .prepare(
          `SELECT ar.*
           FROM agent_runs ar
           JOIN workflow_steps ws ON ar.workflow_step_id = ws.id
           WHERE ws.workflow_id = ?
           ORDER BY ar.started_at DESC`
        )
        .all(workflowId)
      return rows.map(mapAgentRun)
    }
  }

  const codeServerSessions: CodeServerSessionsRepository = {
    upsert: (input) => {
      const now = new Date().toISOString()
      const id = input.id ?? crypto.randomUUID()
      db.prepare(
        `INSERT INTO code_server_sessions (id, project_id, branch, workspace_path, url, auth_token, process_id, status, started_at, stopped_at)
         VALUES (@id, @projectId, @branch, @workspacePath, @url, @authToken, @processId, 'running', @startedAt, NULL)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           branch = excluded.branch,
           workspace_path = excluded.workspace_path,
           url = excluded.url,
           auth_token = excluded.auth_token,
           process_id = excluded.process_id,
           status = excluded.status,
           started_at = excluded.started_at,
           stopped_at = excluded.stopped_at`
      ).run({
        id,
        projectId: input.projectId,
        branch: input.branch,
        workspacePath: input.workspacePath,
        url: input.url,
        authToken: input.authToken,
        processId: input.processId ?? null,
        startedAt: now
      })
      const row = db.prepare('SELECT * FROM code_server_sessions WHERE id = ?').get(id)
      return mapCodeServerSession(row)
    },
    markStopped: (id) => {
      db.prepare(
        `UPDATE code_server_sessions
         SET status = 'stopped', stopped_at = ?
         WHERE id = ?`
      ).run(new Date().toISOString(), id)
    },
    findByProjectAndBranch: (projectId, branch) => {
      const row = db
        .prepare(
          `SELECT * FROM code_server_sessions
           WHERE project_id = ? AND branch = ?
           ORDER BY started_at DESC
           LIMIT 1`
        )
        .get(projectId, branch)
      return row ? mapCodeServerSession(row) : null
    },
    listActive: () => {
      const rows = db.prepare('SELECT * FROM code_server_sessions WHERE status = ?').all('running')
      return rows.map(mapCodeServerSession)
    },
    resetAllRunning: () => {
      db.prepare(
        `UPDATE code_server_sessions
         SET status = 'stopped', stopped_at = COALESCE(stopped_at, ?)
         WHERE status = 'running'`
      ).run(new Date().toISOString())
    }
  }

  const radicleRegistrations: RadicleRegistrationsRepository = {
    upsert: (input) => {
      const now = new Date().toISOString()
      const resolvedPath = path.resolve(input.repositoryPath)
      db.prepare(
        `INSERT INTO radicle_registrations (repository_path, name, description, visibility, default_branch, registered_at)
         VALUES (@repositoryPath, @name, @description, @visibility, @defaultBranch, @registeredAt)
         ON CONFLICT(repository_path) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           visibility = excluded.visibility,
           default_branch = excluded.default_branch,
           registered_at = excluded.registered_at`
      ).run({
        repositoryPath: resolvedPath,
        name: input.name ?? null,
        description: input.description ?? null,
        visibility: input.visibility ?? null,
        defaultBranch: input.defaultBranch ?? null,
        registeredAt: now
      })
      const row = db.prepare('SELECT * FROM radicle_registrations WHERE repository_path = ?').get(resolvedPath)
      return mapRadicleRegistration(row)
    },
    list: () => {
      const rows = db.prepare('SELECT * FROM radicle_registrations ORDER BY registered_at DESC').all()
      return rows.map(mapRadicleRegistration)
    }
  }

  return {
    db,
    projects,
    workflows,
    workflowSteps,
    agentRuns,
    codeServerSessions,
    radicleRegistrations
  }
}

function ensureParentDir (file: string): void {
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function applyMigrations (db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      repository_path TEXT NOT NULL,
      repository_provider TEXT,
      default_branch TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      planner_run_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_steps (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id),
      task_id TEXT,
      status TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      depends_on TEXT NOT NULL,
      data TEXT NOT NULL,
      result TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      workflow_step_id TEXT REFERENCES workflow_steps(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      branch TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      logs_path TEXT
    );

    CREATE TABLE IF NOT EXISTS code_server_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      branch TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      url TEXT NOT NULL,
      auth_token TEXT NOT NULL,
      process_id INTEGER,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      stopped_at TEXT
    );

    CREATE TABLE IF NOT EXISTS radicle_registrations (
      repository_path TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      visibility TEXT,
      default_branch TEXT,
      registered_at TEXT NOT NULL
    );
  `)
}

function mapProject (row: any): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    repositoryPath: row.repository_path,
    repositoryProvider: row.repository_provider ?? null,
    defaultBranch: row.default_branch,
    createdAt: row.created_at
  }
}

function mapWorkflow (row: any): WorkflowRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    plannerRunId: row.planner_run_id ?? null,
    kind: row.kind,
    status: row.status,
    data: parseJsonField(row.data),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapWorkflowStep (row: any): WorkflowStepRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    taskId: row.task_id ?? null,
    status: row.status,
    sequence: row.sequence,
    dependsOn: parseJsonField(row.depends_on),
    data: parseJsonField(row.data),
    result: row.result ? parseJsonField(row.result) : null,
    updatedAt: row.updated_at
  }
}

function mapAgentRun (row: any): AgentRunRecord {
  return {
    id: row.id,
    workflowStepId: row.workflow_step_id ?? null,
    projectId: row.project_id,
    branch: row.branch,
    type: row.type,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    logsPath: row.logs_path ?? null
  }
}

function mapCodeServerSession (row: any): CodeServerSessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    branch: row.branch,
    workspacePath: row.workspace_path,
    url: row.url,
    authToken: row.auth_token,
    processId: typeof row.process_id === 'number' ? row.process_id : null,
    status: row.status,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at ?? null
  }
}

function mapRadicleRegistration (row: any): RadicleRegistrationRecord {
  return {
    repositoryPath: row.repository_path,
    name: row.name ?? null,
    description: row.description ?? null,
    visibility: row.visibility === 'public' || row.visibility === 'private' ? row.visibility : null,
    defaultBranch: row.default_branch ?? null,
    registeredAt: row.registered_at
  }
}

function parseJsonField<T = any> (value: string | null): T {
  if (!value) return {} as T
  try {
    return JSON.parse(value)
  } catch {
    return {} as T
  }
}
