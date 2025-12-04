import { Session } from '@opencode-ai/sdk'
import fs from 'fs'
import os from 'os'
import path from 'path'

export const META_FOLDER = '.hyperagent'

export function sanitizeSessionId(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return safe.length ? safe : 'session'
}

export function resolveSessionRoot(sessionId: string, baseDir?: string): string {
  return baseDir ? path.join(baseDir) : path.join(os.tmpdir(), '.sessions', sessionId)
}

export function metaDirectory(sessionId: string, baseDir?: string): string {
  const root = resolveSessionRoot(sessionId, baseDir)
  const dir = path.join(root, META_FOLDER)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function metaFile(session: Session) {
  const sessionId = session.id
  const baseDir = session.directory
  const dir = metaDirectory(sessionId, baseDir)
  return path.join(dir, `${sanitizeSessionId(sessionId)}.json`)
}

export type LogEntry = {
  entryId: string
  provider: string
  model?: string
  role?: string
  payload: any
  createdAt: string
}

export type SessionMeta = {
  id: string
  log: LogEntry[]
  createdAt: string
  updatedAt: string
}

export function loadSessionMeta(session: Session): SessionMeta {
  const file = metaFile(session)
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, 'utf-8')
      const parsed = JSON.parse(raw)
      parsed.log = Array.isArray(parsed.log) ? parsed.log : []
      return parsed
    } catch (e) {
      console.log('Failed to parse session meta json; recreating', e)
    }
  }
  const blank: SessionMeta = {
    id: session.id,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  saveSessionMeta(blank, session)
  return blank
}

export function saveSessionMeta(meta: SessionMeta, session: Session) {
  const file = metaFile(session)
  meta.updatedAt = new Date().toISOString()
  fs.writeFileSync(file, JSON.stringify(meta, null, 2))
}

export type LogEntryInit = {
  provider: string
  model?: string
  role?: string
  payload: any
  entryId?: string
  createdAt?: string
}

export function appendLogEntry(session: Session, meta: SessionMeta, entry: LogEntryInit) {
  const normalized: LogEntry = {
    entryId: entry.entryId || `${entry.provider}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    provider: entry.provider,
    model: entry.model,
    role: entry.role,
    payload: entry.payload,
    createdAt: entry.createdAt || new Date().toISOString()
  }
  meta.log = Array.isArray(meta.log) ? meta.log : []
  meta.log.push(normalized)
  saveSessionMeta(meta, session)
}

export function findLatestLogEntry(meta: SessionMeta, predicate: (entry: LogEntry) => boolean): LogEntry | undefined {
  const log = Array.isArray(meta.log) ? meta.log : []
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]
    if (predicate(entry)) return entry
  }
  return undefined
}
