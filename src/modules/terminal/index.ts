import crypto from 'crypto'
import type { IPty } from 'node-pty'
import { spawn } from 'node-pty'
import os from 'os'
import path from 'path'
import type { PersistenceContext, PersistenceModule, Timestamp } from '../database'

export type TerminalConfig = {
  defaultShell?: string
  defaultCwd?: string
  maxSessionsPerUser?: number
  env?: NodeJS.ProcessEnv
}

export type TerminalSessionStatus = 'active' | 'closed' | 'error'

export type TerminalSessionRecord = {
  id: string
  userId: string
  projectId: string | null
  shellCommand: string
  initialCwd: string | null
  status: TerminalSessionStatus
  createdAt: Timestamp
  closedAt: Timestamp | null
}

export type TerminalSessionCreateInput = {
  id?: string
  userId: string
  projectId?: string | null
  shellCommand: string
  initialCwd?: string | null
  status?: TerminalSessionStatus
  createdAt?: Timestamp
}

export type TerminalSessionUpdateInput = Partial<
  Pick<TerminalSessionRecord, 'projectId' | 'shellCommand' | 'initialCwd' | 'status' | 'closedAt'>
>

export type TerminalSessionsRepository = {
  create: (input: TerminalSessionCreateInput) => TerminalSessionRecord
  update: (id: string, patch: TerminalSessionUpdateInput) => void
  findById: (id: string) => TerminalSessionRecord | null
  listByUser: (userId: string) => TerminalSessionRecord[]
}

export type CreateTerminalSessionOptions = {
  cwd?: string
  shell?: string
  projectId?: string | null
}

export type AttachSessionOptions = {
  cols?: number
  rows?: number
}

export type LiveTerminalSession = {
  id: string
  userId: string
  record: TerminalSessionRecord
  pty: IPty
}

export type TerminalModule = {
  createSession: (userId: string, options?: CreateTerminalSessionOptions) => Promise<TerminalSessionRecord>
  attachSession: (sessionId: string, userId: string, options?: AttachSessionOptions) => Promise<LiveTerminalSession>
  closeSession: (sessionId: string, userId: string) => Promise<void>
  listSessions: (userId: string) => Promise<TerminalSessionRecord[]>
  getSession: (sessionId: string) => Promise<TerminalSessionRecord | null>
  cleanup: () => Promise<void>
}

export type CreateTerminalModuleOptions = {
  config?: TerminalConfig
  repository: TerminalSessionsRepository
}

export const createTerminalModule = ({ config = {}, repository }: CreateTerminalModuleOptions): TerminalModule => {
  const defaultShell = config.defaultShell ?? process.env.SHELL ?? '/bin/bash'
  const defaultCwd = config.defaultCwd ?? process.cwd()
  const env = config.env ?? process.env
  const liveSessions = new Map<string, LiveTerminalSession>()

  const resolveActiveSessions = (userId: string): TerminalSessionRecord[] => {
    return repository.listByUser(userId).filter((session) => session.status === 'active')
  }

  const createSession = async (userId: string, options?: CreateTerminalSessionOptions) => {
    if (config.maxSessionsPerUser && resolveActiveSessions(userId).length >= config.maxSessionsPerUser) {
      throw new Error('Too many active terminal sessions')
    }

    const shellCommand = options?.shell?.trim() || defaultShell
    const initialCwd = resolveCwd(options?.cwd, defaultCwd)

    const payload: TerminalSessionCreateInput = {
      userId,
      projectId: options?.projectId ?? null,
      shellCommand,
      initialCwd,
      status: 'active'
    }

    return repository.create(payload)
  }

  const attachSession = async (
    sessionId: string,
    userId: string,
    options?: AttachSessionOptions
  ): Promise<LiveTerminalSession> => {
    const record = repository.findById(sessionId)
    if (!record) {
      throw new Error('Session not found')
    }
    if (record.userId !== userId) {
      throw new Error('Unauthorized terminal session access')
    }

    const existing = liveSessions.get(sessionId)
    if (existing) {
      resizeIfRequested(existing.pty, options)
      return existing
    }

    const pty = spawn(record.shellCommand, [], {
      name: 'xterm-color',
      cols: options?.cols ?? 120,
      rows: options?.rows ?? 30,
      cwd: record.initialCwd ?? defaultCwd,
      env
    })

    const live: LiveTerminalSession = {
      id: record.id,
      userId: record.userId,
      record,
      pty
    }

    liveSessions.set(sessionId, live)

    pty.onExit(() => {
      liveSessions.delete(sessionId)
      repository.update(sessionId, {
        status: 'closed',
        closedAt: new Date().toISOString()
      })
    })

    return live
  }

  const closeSession = async (sessionId: string, userId: string) => {
    const record = repository.findById(sessionId)
    if (!record || record.userId !== userId) return

    const live = liveSessions.get(sessionId)
    if (live) {
      liveSessions.delete(sessionId)
      live.pty.kill()
    }

    repository.update(sessionId, {
      status: 'closed',
      closedAt: new Date().toISOString()
    })
  }

  const listSessions = async (userId: string) => {
    return repository.listByUser(userId)
  }

  const getSession = async (sessionId: string) => {
    return repository.findById(sessionId)
  }

  const cleanup = async () => {
    for (const live of liveSessions.values()) {
      live.pty.kill()
    }
    liveSessions.clear()
  }

  const resizeIfRequested = (ptyProcess: IPty, options?: AttachSessionOptions) => {
    if (!options?.cols && !options?.rows) return
    ptyProcess.resize(options.cols ?? ptyProcess.cols, options.rows ?? ptyProcess.rows)
  }

  const resolveCwd = (cwd: string | undefined, fallback: string) => {
    if (!cwd) return fallback
    if (cwd === '~') {
      return os.homedir()
    }
    return path.isAbsolute(cwd) ? cwd : path.resolve(process.cwd(), cwd)
  }

  return {
    createSession,
    attachSession,
    closeSession,
    listSessions,
    getSession,
    cleanup
  }
}

export type TerminalSessionsBindings = {
  terminalSessions: TerminalSessionsRepository
}

export const terminalSessionsPersistence: PersistenceModule<TerminalSessionsBindings> = {
  name: 'terminalSessions',
  applySchema: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS terminal_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_id TEXT,
        shell_command TEXT NOT NULL,
        initial_cwd TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        closed_at TEXT
      );
    `)
  },
  createBindings: ({ db }: PersistenceContext) => ({
    terminalSessions: createTerminalSessionsRepository(db)
  })
}

function createTerminalSessionsRepository(db: PersistenceContext['db']): TerminalSessionsRepository {
  return {
    create: (input) => {
      const id = input.id ?? crypto.randomUUID()
      const createdAt = input.createdAt ?? new Date().toISOString()
      db.prepare(
        `INSERT INTO terminal_sessions (id, user_id, project_id, shell_command, initial_cwd, status, created_at, closed_at)
         VALUES (@id, @userId, @projectId, @shellCommand, @initialCwd, @status, @createdAt, NULL)`
      ).run({
        id,
        userId: input.userId,
        projectId: input.projectId ?? null,
        shellCommand: input.shellCommand,
        initialCwd: input.initialCwd ?? null,
        status: input.status ?? 'active',
        createdAt
      })
      const row = db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get(id)
      return mapTerminalSession(row)
    },
    update: (id, patch) => {
      const record = db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get(id)
      if (!record) return
      db.prepare(
        `UPDATE terminal_sessions
         SET project_id = COALESCE(@projectId, project_id),
             shell_command = COALESCE(@shellCommand, shell_command),
             initial_cwd = COALESCE(@initialCwd, initial_cwd),
             status = COALESCE(@status, status),
             closed_at = COALESCE(@closedAt, closed_at)
         WHERE id = @id`
      ).run({
        id,
        projectId: patch.projectId ?? null,
        shellCommand: patch.shellCommand ?? null,
        initialCwd: patch.initialCwd ?? null,
        status: patch.status ?? null,
        closedAt: patch.closedAt ?? null
      })
    },
    findById: (id) => {
      const row = db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get(id)
      return row ? mapTerminalSession(row) : null
    },
    listByUser: (userId) => {
      const rows = db.prepare('SELECT * FROM terminal_sessions WHERE user_id = ? ORDER BY created_at DESC').all(userId)
      return rows.map(mapTerminalSession)
    }
  }
}

function mapTerminalSession(row: any): TerminalSessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id ?? null,
    shellCommand: row.shell_command,
    initialCwd: row.initial_cwd ?? null,
    status: row.status as TerminalSessionStatus,
    createdAt: row.created_at,
    closedAt: row.closed_at ?? null
  }
}
