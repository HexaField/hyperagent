import type { IPty } from 'node-pty'
import { spawn } from 'node-pty'
import os from 'os'
import path from 'path'
import type { TerminalSessionCreateInput, TerminalSessionRecord, TerminalSessionsRepository } from '../persistence'

export type TerminalConfig = {
  defaultShell?: string
  defaultCwd?: string
  maxSessionsPerUser?: number
  env?: NodeJS.ProcessEnv
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
    if (
      config.maxSessionsPerUser &&
      resolveActiveSessions(userId).length >= config.maxSessionsPerUser
    ) {
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
