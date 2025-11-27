import type { Dirent } from 'fs'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

export type OpencodeSessionSummary = {
  id: string
  title: string | null
  workspacePath: string
  projectId: string | null
  createdAt: string
  updatedAt: string
  providerId?: string | null
  modelId?: string | null
  summary: {
    additions: number
    deletions: number
    files: number
  }
}

export type OpencodeMessagePart = {
  id: string
  type: string
  text?: string
  start?: string | null
  end?: string | null
  // preserve any extra metadata the agent may include, e.g. cost, tokens, reason
  [key: string]: unknown
}

export type OpencodeMessage = {
  id: string
  role: string
  createdAt: string
  completedAt: string | null
  modelId: string | null
  providerId: string | null
  // The text field will be a convenience concatenation for simple clients, but UIs
  // should prefer the structured `parts` array when present.
  text: string
  parts: OpencodeMessagePart[]
}

export type OpencodeSessionDetail = {
  session: OpencodeSessionSummary
  messages: OpencodeMessage[]
}

export type ListSessionsOptions = {
  workspacePath?: string | null
  limit?: number
}

export type OpencodeStorage = {
  rootDir: string
  listSessions: (options?: ListSessionsOptions) => Promise<OpencodeSessionSummary[]>
  getSession: (sessionId: string) => Promise<OpencodeSessionDetail | null>
}

type FileReader = typeof fs.readFile

type StorageOptions = {
  rootDir?: string
  fileReader?: FileReader
}

type SessionMeta = OpencodeSessionSummary & { metaPath: string }

type SessionJson = {
  id?: string
  directory?: string
  projectID?: string
  title?: string
  time?: {
    created?: number | string
    updated?: number | string
  }
  summary?: {
    additions?: number
    deletions?: number
    files?: number
  }
}

type MessageJson = {
  id?: string
  sessionID?: string
  role?: string
  time?: {
    created?: number | string
    completed?: number | string
  }
  modelID?: string
  providerID?: string
  model?: {
    providerID?: string
    modelID?: string
  }
}

type PartJson = {
  id?: string
  type?: string
  text?: string
  time?: {
    start?: number | string
    end?: number | string
  }
}

export function createOpencodeStorage(options: StorageOptions = {}): OpencodeStorage {
  const rootDir = options.rootDir ?? resolveDefaultOpencodeRoot()
  const fileReader = options.fileReader ?? fs.readFile
  const storageDir = path.join(rootDir, 'storage')
  const sessionDir = path.join(storageDir, 'session')
  const messageDir = path.join(storageDir, 'message')
  const partDir = path.join(storageDir, 'part')
  const sessionIndex = new Map<string, string>()

  const listSessions = async (opts?: ListSessionsOptions): Promise<OpencodeSessionSummary[]> => {
    const summaries = await scanSessionDirectory()
    let filtered = summaries
    if (opts?.workspacePath) {
      const target = normalizePath(opts.workspacePath)
      filtered = summaries.filter((entry) => normalizePath(entry.workspacePath) === target)
    }
    if (opts?.limit && opts.limit > 0 && filtered.length > opts.limit) {
      filtered = filtered.slice(0, opts.limit)
    }
    return filtered.map(stripMetaPath)
  }

  const getSession = async (sessionId: string): Promise<OpencodeSessionDetail | null> => {
    const meta = await findSessionMeta(sessionId)
    if (!meta) return null
    const messages = await readMessages(sessionId)
    return {
      session: stripMetaPath(meta),
      messages
    }
  }

  async function scanSessionDirectory(): Promise<SessionMeta[]> {
    const summaries: SessionMeta[] = []
    const buckets = await readDirSafe(sessionDir)
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue
      const bucketPath = path.join(sessionDir, bucket.name)
      const files = await readDirSafe(bucketPath)
      for (const entry of files) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const fullPath = path.join(bucketPath, entry.name)
        const meta = await readSessionMeta(fullPath)
        if (!meta) continue
        sessionIndex.set(meta.id, fullPath)
        summaries.push(meta)
      }
    }
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return summaries
  }

  async function findSessionMeta(sessionId: string): Promise<SessionMeta | null> {
    const existingPath = sessionIndex.get(sessionId)
    if (existingPath) {
      const meta = await readSessionMeta(existingPath)
      if (meta) return meta
    }
    const buckets = await readDirSafe(sessionDir)
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue
      const bucketPath = path.join(sessionDir, bucket.name)
      const candidate = path.join(bucketPath, `${sessionId}.json`)
      const meta = await readSessionMeta(candidate)
      if (meta) {
        sessionIndex.set(sessionId, candidate)
        return meta
      }
    }
    return null
  }

  async function readSessionMeta(filePath: string): Promise<SessionMeta | null> {
    try {
      const raw = await fileReader(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as SessionJson
      if (!parsed.id || !parsed.directory) {
        return null
      }
      return {
        id: parsed.id,
        title: coerceString(parsed.title),
        workspacePath: parsed.directory,
        projectId: coerceString(parsed.projectID),
        createdAt: coerceIso(parsed.time?.created),
        updatedAt: coerceIso(parsed.time?.updated),
        summary: {
          additions: coerceNumber(parsed.summary?.additions),
          deletions: coerceNumber(parsed.summary?.deletions),
          files: coerceNumber(parsed.summary?.files)
        },
        metaPath: filePath
      }
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  async function readMessages(sessionId: string): Promise<OpencodeMessage[]> {
    const dir = path.join(messageDir, sessionId)
    const entries = await readDirSafe(dir)
    const messages: OpencodeMessage[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const filePath = path.join(dir, entry.name)
      try {
        const raw = await fileReader(filePath, 'utf-8')
        const parsed = JSON.parse(raw) as MessageJson
        if (!parsed.id || parsed.sessionID !== sessionId || !parsed.role) continue
        const parts = await readParts(parsed.id)
        // Build a fallback flat text for older clients, but keep the structured parts
        const fallbackLines: string[] = []
        for (const part of parts) {
          const timeParts: string[] = []
          if (part.start) timeParts.push(`start: ${part.start}`)
          if (part.end) timeParts.push(`end: ${part.end}`)
          const meta = timeParts.length ? ` (${timeParts.join(', ')})` : ''

          if (part.type === 'text' && typeof part.text === 'string') {
            fallbackLines.push(part.text.trim())
            continue
          }
          if (part.type === 'tool') {
            const desc = typeof part.text === 'string' && part.text.trim().length ? part.text.trim() : 'Executing tool'
            fallbackLines.push(`🔧 Tool: ${desc}${meta}`)
            continue
          }
          if (part.type === 'step-start') {
            const desc = typeof part.text === 'string' && part.text.trim().length ? part.text.trim() : 'Starting step'
            fallbackLines.push(`▶️ Step: ${desc}${meta}`)
            continue
          }
          if (part.type === 'step-finish') {
            const desc = typeof part.text === 'string' && part.text.trim().length ? part.text.trim() : 'Step completed'
            fallbackLines.push(`✅ Step: ${desc}${meta}`)
            continue
          }
          if (part.type === 'file-diff' || part.type === 'diff') {
            fallbackLines.push(`🧾 Diff: ${typeof part.text === 'string' ? part.text : ''}`)
            continue
          }
          if (typeof part.text === 'string' && part.text.trim().length) {
            fallbackLines.push(part.text.trim())
            continue
          }
        }
        const text = fallbackLines.filter(Boolean).join('\n')
        // Only include the message if it has at least some meaningful structured parts or text
        if (!text && parts.length === 0) continue
        messages.push({
          id: parsed.id,
          role: parsed.role,
          createdAt: coerceIso(parsed.time?.created),
          completedAt: coerceIsoOrNull(parsed.time?.completed),
          modelId: parsed.modelID ?? parsed.model?.modelID ?? null,
          providerId: parsed.providerID ?? parsed.model?.providerID ?? null,
          text,
          parts
        })
      } catch (error: any) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
    }
    messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return messages
  }

  async function readParts(messageId: string): Promise<OpencodeMessagePart[]> {
    const dir = path.join(partDir, messageId)
    const entries = await readDirSafe(dir)
    const parts: OpencodeMessagePart[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const filePath = path.join(dir, entry.name)
      try {
        const raw = await fileReader(filePath, 'utf-8')
        const parsed = JSON.parse(raw) as PartJson
        if (!parsed.id || !parsed.type) continue
        // preserve raw part fields and coerce time fields to ISO if present
        const partObj: OpencodeMessagePart = {
          id: parsed.id,
          type: parsed.type ?? 'unknown',
          text: typeof parsed.text === 'string' ? parsed.text : undefined,
          start: coerceIsoOrNull(parsed.time?.start),
          end: coerceIsoOrNull(parsed.time?.end)
        }
        // copy over any additional keys on the parsed object to preserve metadata
        for (const key of Object.keys(parsed)) {
          if (key === 'id' || key === 'type' || key === 'text' || key === 'time') continue
          // @ts-ignore allow copying unknown props
          partObj[key] = (parsed as any)[key]
        }
        parts.push(partObj)
      } catch (error: any) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
    }
    parts.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))
    return parts
  }

  function stripMetaPath(meta: SessionMeta): OpencodeSessionSummary {
    const { metaPath: _metaPath, ...rest } = meta
    return rest
  }

  return {
    rootDir,
    listSessions,
    getSession
  }
}

function coerceString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length ? trimmed : null
}

function coerceNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function coerceIso(value: unknown): string {
  const iso = coerceIsoOrNull(value)
  return iso ?? new Date(0).toISOString()
}

function coerceIsoOrNull(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString()
    }
    const date = new Date(value)
    if (!isNaN(date.getTime())) return date.toISOString()
  }
  return null
}

function normalizePath(value: string): string {
  try {
    return path.resolve(value)
  } catch {
    return value
  }
}

async function readDirSafe(dirPath: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true })
  } catch (error: any) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

export function resolveDefaultOpencodeRoot(): string {
  const envOverride =
    process.env.OPENCODE_STORAGE_ROOT ?? process.env.OPENCODE_DATA_DIR ?? process.env.OPENCODE_DATA_ROOT
  if (envOverride) {
    return path.resolve(envOverride)
  }
  const home = os.homedir()
  const candidates: string[] = []
  // Prefer local share and fallback to platform-specific directories
  candidates.push(path.join(home, '.local', 'share', 'opencode'))
  if (process.platform === 'darwin') {
    candidates.push(path.join(home, 'Library', 'Application Support', 'opencode'))
  }
  if (process.platform === 'win32') {
    candidates.push(path.join(home, 'AppData', 'Roaming', 'opencode'))
  }
  candidates.push(path.join(home, '.opencode'))

  for (const candidate of candidates) {
    if (candidate && candidate.trim().length && pathExists(candidate)) {
      return candidate
    }
  }
  return candidates[0] ?? path.join(home, '.opencode')
}

function pathExists(candidate: string): boolean {
  try {
    return existsSync(candidate)
  } catch {
    return false
  }
}
