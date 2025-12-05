import fs from 'fs'
import path from 'path'

export const META_FOLDER = '.hyperagent'

const normalizeRunId = (runId: string) => path.basename(path.resolve(runId))

export function metaDirectory(directory: string): string {
  const dir = path.join(directory, META_FOLDER)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function metaFile(runId: string, directory: string) {
  const dir = metaDirectory(directory)
  const idForFile = normalizeRunId(runId)
  return path.join(dir, `${idForFile}.json`)
}

export type LogEntry = {
  entryId: string
  model?: string
  role?: string
  payload: any
  createdAt: string
}

export type RunMeta = {
  id: string
  agents: Array<{ role: string; sessionId: string }>
  log: LogEntry[]
  createdAt: string
  updatedAt: string
}

export function hasRunMeta(runId: string, directory: string): boolean {
  const file = metaFile(runId, directory)
  return fs.existsSync(file)
}

export function createRunMeta(
  directory: string,
  runId: string,
  agents: Array<{ role: string; sessionId: string }>
): RunMeta {
  const normalizedId = normalizeRunId(runId)
  const runMeta: RunMeta = {
    id: normalizedId,
    agents: agents,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  saveRunMeta(runMeta, runId, directory)
  return runMeta
}

export function loadRunMeta(runId: string, directory: string): RunMeta {
  const file = metaFile(runId, directory)
  if (!fs.existsSync(file)) throw new Error(`Run meta file does not exist: ${file}`)
  const raw = fs.readFileSync(file, 'utf-8')
  const parsed = JSON.parse(raw)
  const normalizedId = typeof parsed.id === 'string' && parsed.id.length ? parsed.id : normalizeRunId(runId)
  const agents = Array.isArray(parsed.agents) ? parsed.agents : []
  return {
    id: normalizedId,
    agents,
    log: Array.isArray(parsed.log) ? parsed.log : [],
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString()
  }
}

export function saveRunMeta(meta: RunMeta, runId: string, directory: string) {
  const file = metaFile(runId, directory)
  meta.updatedAt = new Date().toISOString()
  fs.writeFileSync(file, JSON.stringify(meta, null, 2))
}

export type LogEntryInit = {
  model?: string
  role?: string
  payload: any
  entryId?: string
  createdAt?: string
}

export function appendLogEntry(runId: string, entry: LogEntryInit, directory: string) {
  const normalized: LogEntry = {
    entryId: entry.entryId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    model: entry.model,
    role: entry.role,
    payload: entry.payload,
    createdAt: entry.createdAt || new Date().toISOString()
  }
  const meta = loadRunMeta(runId, directory)
  meta.log = Array.isArray(meta.log) ? meta.log : []
  meta.log.push(normalized)
  saveRunMeta(meta, runId, directory)
}

export function findLatestLogEntry(meta: RunMeta, predicate: (entry: LogEntry) => boolean): LogEntry | undefined {
  const log = Array.isArray(meta.log) ? meta.log : []
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]
    if (predicate(entry)) return entry
  }
  return undefined
}
