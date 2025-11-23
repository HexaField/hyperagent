import type { ChildProcessWithoutNullStreams } from 'child_process'
import { spawn } from 'child_process'
import crypto from 'crypto'
import path from 'path'
import type { PersistenceContext, PersistenceModule, Timestamp } from './database'

export type CodeServerOptions = {
  host?: string
  port?: number
  repoRoot?: string
  binary?: string
  env?: NodeJS.ProcessEnv
  publicBasePath?: string
}

export type CodeServerHandle = {
  child: ChildProcessWithoutNullStreams
  running: boolean
  publicUrl: string
}

export type CodeServerController = {
  ensure: () => Promise<CodeServerHandle | null>
  shutdown: () => Promise<void>
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 13337
const DEFAULT_BINARY = 'code-server'
const DEFAULT_PUBLIC_BASE = '/code-server'

export function createCodeServerController(rawOptions: CodeServerOptions = {}): CodeServerController {
  const options = normalizeOptions(rawOptions)
  let codeServerPromise: Promise<CodeServerHandle | null> | null = null

  const ensure = async () => {
    if (!codeServerPromise) {
      codeServerPromise = startCodeServer(options, () => {
        codeServerPromise = null
      }).catch((error) => {
        console.warn('Unable to launch code-server:', error.message)
        codeServerPromise = null
        return null
      })
    }
    return codeServerPromise
  }

  const shutdown = async () => {
    const handle = codeServerPromise && (await codeServerPromise)
    if (!handle) return
    handle.child.kill('SIGTERM')
    codeServerPromise = null
  }

  return { ensure, shutdown }
}

function normalizeOptions(options: CodeServerOptions): Required<CodeServerOptions> {
  const host = options.host || process.env.CODE_SERVER_HOST || DEFAULT_HOST
  const port = options.port || Number(process.env.CODE_SERVER_PORT || DEFAULT_PORT)
  const repoRoot = options.repoRoot || process.env.CODE_SERVER_ROOT || path.resolve(process.cwd())
  const binary = options.binary || process.env.CODE_SERVER_BIN || DEFAULT_BINARY
  const env = { ...process.env, ...options.env }
  const publicBasePath = options.publicBasePath || DEFAULT_PUBLIC_BASE
  return { host, port, repoRoot, binary, env, publicBasePath }
}

function startCodeServer(options: Required<CodeServerOptions>, onExit: () => void): Promise<CodeServerHandle> {
  return new Promise((resolve, reject) => {
    const args = [
      '--bind-addr',
      `${options.host}:${options.port}`,
      '--auth',
      'none',
      '--disable-update-check',
      options.repoRoot
    ]

    const child = spawn(options.binary, args, {
      cwd: options.repoRoot,
      env: options.env
    })

    let resolved = false

    const ready = () => {
      if (resolved) return
      resolved = true
      resolve({
        child,
        running: true,
        publicUrl: buildPublicUrl(options.publicBasePath, options.repoRoot)
      })
    }

    child.stdout.on('data', (data) => {
      const text = data.toString()
      process.stdout.write(`[code-server] ${text}`)
      if (text.includes('HTTP server listening')) {
        ready()
      }
    })

    child.stderr.on('data', (data) => {
      const text = data.toString()
      process.stderr.write(`[code-server] ${text}`)
    })

    child.on('error', (error) => {
      if (resolved) return
      resolved = true
      reject(error)
    })

    child.on('exit', (code) => {
      if (!resolved) {
        reject(new Error(`code-server exited with code ${code}`))
      }
      onExit()
    })

    setTimeout(() => {
      if (!resolved) {
        ready()
      }
    }, 2000)
  })
}

function buildPublicUrl(basePath: string, repoRoot: string): string {
  const normalized = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
  return `${normalized}/?folder=${encodeURIComponent(repoRoot)}`
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

export type CodeServerSessionInput = {
  id?: string
  projectId: string
  branch: string
  workspacePath: string
  url: string
  authToken: string
  processId?: number | null
}

export type CodeServerSessionsRepository = {
  upsert: (input: CodeServerSessionInput) => CodeServerSessionRecord
  markStopped: (id: string) => void
  findByProjectAndBranch: (projectId: string, branch: string) => CodeServerSessionRecord | null
  listActive: () => CodeServerSessionRecord[]
  resetAllRunning: () => void
}

export type CodeServerSessionsBindings = {
  codeServerSessions: CodeServerSessionsRepository
}

export const codeServerSessionsPersistence: PersistenceModule<CodeServerSessionsBindings> = {
  name: 'codeServerSessions',
  applySchema: (db) => {
    db.exec(`
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
    `)
  },
  createBindings: ({ db }: PersistenceContext) => ({
    codeServerSessions: createCodeServerSessionsRepository(db)
  })
}

function createCodeServerSessionsRepository(db: PersistenceContext['db']): CodeServerSessionsRepository {
  return {
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
}

function mapCodeServerSession(row: any): CodeServerSessionRecord {
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
