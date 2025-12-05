import { PersistenceContext, PersistenceModule, Timestamp } from '../database'

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

export type AgentRunInput = {
  id?: string
  workflowStepId?: string | null
  projectId: string
  branch: string
  type: string
  status?: AgentRunStatus
  logsPath?: string | null
}

export type AgentRunsRepository = {
  create: (input: AgentRunInput) => AgentRunRecord
  update: (id: string, patch: Partial<Pick<AgentRunRecord, 'status' | 'finishedAt' | 'logsPath'>>) => void
  listByWorkflow: (workflowId: string) => AgentRunRecord[]
}

export type AgentRunsBindings = {
  agentRuns: AgentRunsRepository
}

export const agentRunsPersistence: PersistenceModule<AgentRunsBindings> = {
  name: 'agentRuns',
  applySchema: (db) => {
    ensureAgentRunsTable(db)
  },
  createBindings: ({ db }: PersistenceContext) => ({
    agentRuns: createAgentRunsRepository(db)
  })
}

function ensureAgentRunsTable(db: PersistenceContext['db']): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      workflow_step_id TEXT REFERENCES workflow_steps(id),
      project_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      logs_path TEXT
    );
  `)
  const foreignKeys = db.prepare("PRAGMA foreign_key_list('agent_runs')").all() as Array<{ table: string }>
  const referencesProjects = foreignKeys.some((fk) => fk.table === 'projects')
  if (referencesProjects) {
    migrateAgentRunsTableWithoutProjectFk(db)
  }
}

function migrateAgentRunsTableWithoutProjectFk(db: PersistenceContext['db']): void {
  const foreignKeysEnabled = Boolean(db.pragma('foreign_keys', { simple: true }))
  if (foreignKeysEnabled) {
    db.pragma('foreign_keys = OFF')
  }
  const migrate = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS agent_runs_migration')
    db.exec(`
      CREATE TABLE agent_runs_migration (
        id TEXT PRIMARY KEY,
        workflow_step_id TEXT REFERENCES workflow_steps(id),
        project_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        logs_path TEXT
      );
    `)
    db.exec(`
      INSERT INTO agent_runs_migration (id, workflow_step_id, project_id, branch, type, status, started_at, finished_at, logs_path)
      SELECT id, workflow_step_id, project_id, branch, type, status, started_at, finished_at, logs_path FROM agent_runs;
    `)
    db.exec('DROP TABLE agent_runs')
    db.exec('ALTER TABLE agent_runs_migration RENAME TO agent_runs')
  })
  migrate()
  if (foreignKeysEnabled) {
    db.pragma('foreign_keys = ON')
  }
}

function createAgentRunsRepository(db: PersistenceContext['db']): AgentRunsRepository {
  return {
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
      ).run(
        patch.status ?? record.status,
        patch.finishedAt ?? record.finished_at,
        patch.logsPath ?? record.logs_path,
        id
      )
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
}

function mapAgentRun(row: any): AgentRunRecord {
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
