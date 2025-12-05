// provenance operates on run ids and directories; Session type not required here
import fs from 'fs'
import path from 'path'

export const META_FOLDER = '.hyperagent'

export function sanitizeSessionId(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return safe.length ? safe : 'session'
}

export function metaDirectory(directory: string): string {
  const dir = path.join(directory, META_FOLDER)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function metaFile(runId: string, directory: string) {
  const dir = metaDirectory(directory)
  const idForFile = sanitizeSessionId(path.basename(path.resolve(String(runId))))
  return path.join(dir, `${idForFile}.json`)
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

export function loadSessionMeta(runId: string, directory: string): SessionMeta {
  const file = metaFile(runId, directory)
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
    id: sanitizeSessionId(path.basename(String(runId))),
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  saveSessionMeta(blank, runId, directory)
  return blank
}

export function saveSessionMeta(meta: SessionMeta, runId: string, directory: string) {
  const file = metaFile(runId, directory)
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

export function appendLogEntry(runId: string, meta: SessionMeta, entry: LogEntryInit, directory: string) {
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
  saveSessionMeta(meta, runId, directory)
}

export function findLatestLogEntry(meta: SessionMeta, predicate: (entry: LogEntry) => boolean): LogEntry | undefined {
  const log = Array.isArray(meta.log) ? meta.log : []
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]
    if (predicate(entry)) return entry
  }
  return undefined
}
