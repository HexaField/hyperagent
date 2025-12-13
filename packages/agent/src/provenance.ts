import type { FileDiff } from '@opencode-ai/sdk'
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
  workflowId?: string
  workflowSource?: 'builtin' | 'user'
  workflowLabel?: string
}

export function hasRunMeta(runId: string, directory: string): boolean {
  const file = metaFile(runId, directory)
  return fs.existsSync(file)
}

export function createRunMeta(
  directory: string,
  runId: string,
  agents: Array<{ role: string; sessionId: string }>,
  extras: Partial<RunMeta> = {}
): RunMeta {
  const normalizedId = normalizeRunId(runId)
  const runMeta: RunMeta = {
    id: normalizedId,
    agents: agents,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(extras.workflowId ? { workflowId: extras.workflowId } : {}),
    ...(extras.workflowSource ? { workflowSource: extras.workflowSource } : {}),
    ...(extras.workflowLabel ? { workflowLabel: extras.workflowLabel } : {})
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
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    workflowId: typeof parsed.workflowId === 'string' ? parsed.workflowId : undefined,
    workflowSource:
      parsed.workflowSource === 'user' || parsed.workflowSource === 'builtin' ? parsed.workflowSource : undefined,
    workflowLabel: typeof parsed.workflowLabel === 'string' ? parsed.workflowLabel : undefined
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

export function recordUserMessage(
  runId: string,
  directory: string,
  message: Record<string, unknown> | undefined,
  metadata?: Record<string, unknown>
) {
  if (!message || typeof message !== 'object') return
  const payload: Record<string, unknown> = { ...message }
  if (metadata && Object.keys(metadata).length) {
    Object.assign(payload, metadata)
  }
  appendLogEntry(
    runId,
    {
      role: 'user',
      payload
    },
    directory
  )
}

export function findLatestLogEntry(meta: RunMeta, predicate: (entry: LogEntry) => boolean): LogEntry | undefined {
  const log = Array.isArray(meta.log) ? meta.log : []
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]
    if (predicate(entry)) return entry
  }
  return undefined
}

type MessagePartLike = {
  messageID?: string
  [key: string]: unknown
}

export function findLatestRoleMessageId(meta: RunMeta, role: string): string | null {
  const entry = findLatestLogEntry(meta, (log) => log.role === role && Array.isArray(log.payload?.response))
  if (!entry) return null
  const parts = Array.isArray(entry.payload?.response) ? (entry.payload.response as MessagePartLike[]) : []
  const messagePart = parts.find((part) => typeof part.messageID === 'string')
  return messagePart?.messageID ?? null
}

export function findLatestRoleDiff(meta: RunMeta, role: string): FileDiff[] | null {
  const entry = findLatestLogEntry(
    meta,
    (log) => log.role === role && Array.isArray(log.payload?.diff?.files) && log.payload.diff.files.length > 0
  )
  if (!entry) return null
  const diffPayload = entry.payload?.diff
  const files = Array.isArray(diffPayload?.files) ? (diffPayload.files as FileDiff[]) : []
  return files.length ? files : null
}
