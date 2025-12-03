import { execFile } from 'child_process'
import type { Dirent } from 'fs'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { safeParseJson } from './json'

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

type SnapshotStage = 'start' | 'finish' | 'unknown'
type SnapshotActor = 'worker' | 'verifier'

type SnapshotResolver = {
  extractStepText: (input: {
    snapshotHash: string
    workspacePath?: string | null
    stage: SnapshotStage
    actor?: SnapshotActor | null
  }) => Promise<string | null>
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
  snapshotResolver?: SnapshotResolver | null
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
  path?: {
    root?: string
    cwd?: string
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
  const snapshotRoot = path.join(rootDir, 'snapshot')
  const snapshotResolver = options.snapshotResolver ?? createSnapshotResolver(snapshotRoot)

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
    const messages = await readMessages(meta)
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

  async function readMessages(meta: SessionMeta): Promise<OpencodeMessage[]> {
    const dir = path.join(messageDir, meta.id)
    const entries = await readDirSafe(dir)
    const messages: OpencodeMessage[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const filePath = path.join(dir, entry.name)
      try {
        const raw = await fileReader(filePath, 'utf-8')
        const parsed = JSON.parse(raw) as MessageJson
        if (!parsed.id || parsed.sessionID !== meta.id || !parsed.role) continue
        const parts = await readParts(parsed, meta)
        // Prefer structured `parts` over any flat fallback text; do not construct a fallback summary.
        // Only include messages that contain structured parts.
        if (!parts || parts.length === 0) continue
        messages.push({
          id: parsed.id,
          role: parsed.role,
          createdAt: coerceIso(parsed.time?.created),
          completedAt: coerceIsoOrNull(parsed.time?.completed),
          modelId: parsed.modelID ?? parsed.model?.modelID ?? null,
          providerId: parsed.providerID ?? parsed.model?.providerID ?? null,
          text: '',
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

  async function readParts(message: MessageJson, meta: SessionMeta): Promise<OpencodeMessagePart[]> {
    if (!message.id) return []
    const dir = path.join(partDir, message.id)
    const entries = await readDirSafe(dir)
    const parts: OpencodeMessagePart[] = []
    const normalizationContext: PartNormalizationContext = {
      snapshotResolver,
      workspacePath: resolveMessageWorkspacePath(message, meta),
      actor: normalizeActorRole(message.role)
    }
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
        await normalizeStepLikePart(partObj, parsed, normalizationContext)
        parts.push(partObj)
      } catch (error: any) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
    }
    parts.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))
    return parts
  }

  function resolveMessageWorkspacePath(message: MessageJson, meta: SessionMeta): string | null {
    const fromMessage = coerceString(message.path?.root) ?? coerceString(message.path?.cwd)
    return fromMessage ?? meta.workspacePath ?? null
  }

  type RawPartJson = PartJson & Record<string, any>

  type PartNormalizationContext = {
    snapshotResolver: SnapshotResolver | null
    workspacePath?: string | null
    actor?: SnapshotActor | null
  }

  async function normalizeStepLikePart(part: OpencodeMessagePart, raw: RawPartJson, ctx: PartNormalizationContext) {
    const immediatePayload = buildPayloadFromRaw(raw)
    if (immediatePayload) {
      applyStepEventFields(part, immediatePayload)
      await hydratePartFromSnapshot(part, raw, ctx, immediatePayload.snapshot)
      return
    }

    const payload = findEmbeddedStepEvent(part, raw)
    if (payload) {
      applyStepEventFields(part, payload)
      await hydratePartFromSnapshot(part, raw, ctx, payload.snapshot)
      return
    }

    const normalizedType = normalizeStepType(part.type)
    if (normalizedType) {
      part.type = normalizedType
      const fallbackText = buildStepFallbackText(raw)
      if (fallbackText) part.text = fallbackText
    }

    await hydratePartFromSnapshot(part, raw, ctx, extractSnapshotHash(raw))
  }

  function buildPayloadFromRaw(raw: RawPartJson): StepEventPayload | null {
    const normalizedType = normalizeStepType(raw.type)
    if (!normalizedType) return null
    const text = extractStepEventText(raw) ?? buildStepFallbackText(raw)
    const start = coerceIsoOrNull(raw.time?.start ?? raw.startedAt ?? raw.timestamp)
    const end = coerceIsoOrNull(raw.time?.end ?? raw.completedAt ?? raw.timestamp)
    const snapshot = extractSnapshotHash(raw)
    return { type: normalizedType, text, start, end, snapshot }
  }

  function findEmbeddedStepEvent(part: OpencodeMessagePart, raw: RawPartJson): StepEventPayload | null {
    const candidates: string[] = []
    if (typeof part.text === 'string') candidates.push(part.text)
    if (typeof raw.text === 'string') candidates.push(raw.text)
    const stateOutput = raw?.state?.output ?? raw?.state?.message
    if (typeof stateOutput === 'string') candidates.push(stateOutput)
    if (typeof raw.output === 'string') candidates.push(raw.output)
    if (typeof raw.payload === 'string') candidates.push(raw.payload)

    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || !candidate.trim()) continue
      const payload = parseStepEventEnvelope(candidate)
      if (payload) return payload
    }
    return null
  }

  async function hydratePartFromSnapshot(
    part: OpencodeMessagePart,
    raw: RawPartJson,
    ctx: PartNormalizationContext,
    snapshotOverride?: string | null
  ) {
    if (!ctx.snapshotResolver) return
    const snapshotHash =
      coerceSnapshotHash(snapshotOverride) ??
      coerceSnapshotHash(raw.snapshot) ??
      coerceSnapshotHash((raw as any)?.part?.snapshot) ??
      coerceSnapshotHash((raw as any)?.payload?.snapshot) ??
      coerceSnapshotHash((raw as any)?.data?.snapshot) ??
      coerceSnapshotHash((raw as any)?.state?.snapshot) ??
      coerceSnapshotHash((raw as any)?.event?.snapshot) ??
      extractSnapshotHash(raw)
    if (!snapshotHash) return
    if (hasMeaningfulStepText(part.text, snapshotHash)) return
    const stage: SnapshotStage =
      part.type === 'step-start' ? 'start' : part.type === 'step-finish' ? 'finish' : 'unknown'
    const actor =
      ctx.actor ??
      normalizeActorRole((raw as any)?.role) ??
      normalizeActorRole((raw as any)?.actor) ??
      normalizeActorRole((raw as any)?.agent)
    try {
      const text = await ctx.snapshotResolver.extractStepText({
        snapshotHash,
        workspacePath: ctx.workspacePath,
        stage,
        actor
      })
      if (text && text.trim().length) {
        part.text = text.trim()
      }
    } catch {
      // snapshot resolution is best-effort; fall back silently
    }
  }

  function hasMeaningfulStepText(text: unknown, snapshotHash?: string): boolean {
    if (typeof text !== 'string') return false
    const trimmed = text.trim()
    if (!trimmed.length) return false
    const normalizedText = trimmed.toLowerCase()
    if (!snapshotHash) {
      return !normalizedText.startsWith('snapshot:')
    }
    const normalizedHash = snapshotHash.toLowerCase()
    const placeholderA = `snapshot: ${normalizedHash}`
    const placeholderB = `snapshot ${normalizedHash}`
    if (normalizedText === placeholderA || normalizedText === placeholderB) {
      return false
    }
    if (normalizedText.startsWith('snapshot:')) {
      return false
    }
    return true
  }

  type StepEventPayload = {
    type: 'step-start' | 'step-finish'
    text: string | null
    start?: string | null
    end?: string | null
    snapshot?: string | null
  }

  function applyStepEventFields(part: OpencodeMessagePart, payload: StepEventPayload) {
    part.type = payload.type
    if (payload.text !== null) part.text = payload.text
    if (payload.start) part.start = payload.start
    if (payload.end) part.end = payload.end
  }

  function normalizeStepType(value: unknown): StepEventPayload['type'] | null {
    if (typeof value !== 'string') return null
    const normalized = value.trim().toLowerCase().replace(/_/g, '-').replace(/\s+/g, '-')
    if (normalized === 'step-start' || normalized === 'step-finish') return normalized
    return null
  }

  function parseStepEventEnvelope(raw: string): StepEventPayload | null {
    const parsed = safeParseJson<Record<string, any>>(raw)
    if (!parsed) return null
    const normalizedType = normalizeStepType(parsed.type ?? parsed.event ?? parsed.kind ?? parsed.name)
    if (!normalizedType) return null
    const text = extractStepEventText(parsed) ?? buildStepFallbackText(parsed)
    const start = coerceIsoOrNull(
      parsed.time?.start ??
        parsed.startedAt ??
        parsed.timestamp ??
        parsed.time ??
        parsed.part?.time?.start ??
        parsed.part?.start
    )
    const end = coerceIsoOrNull(
      parsed.time?.end ??
        parsed.completedAt ??
        parsed.timestamp ??
        parsed.time ??
        parsed.part?.time?.end ??
        parsed.part?.end
    )
    const snapshot = extractSnapshotHash(parsed)
    return { type: normalizedType, text, start, end, snapshot }
  }

  const STEP_TEXT_KEYS = [
    'text',
    'message',
    'summary',
    'details',
    'output',
    'content',
    'description',
    'label',
    'title',
    'name',
    'note',
    'notes',
    'instruction',
    'instructions',
    'command',
    'action',
    'result',
    'status'
  ]
  const STEP_NESTED_KEYS = ['part', 'payload', 'data', 'state', 'event', 'body', 'context']

  function extractStepEventText(payload: unknown): string | null {
    if (!payload) return null
    if (typeof payload === 'string') {
      const trimmed = payload.trim()
      return trimmed.length ? trimmed : null
    }
    if (Array.isArray(payload)) {
      for (const entry of payload) {
        const text = extractStepEventText(entry)
        if (text) return text
      }
      return null
    }
    if (typeof payload !== 'object') return null
    for (const key of STEP_TEXT_KEYS) {
      const value = (payload as any)[key]
      if (typeof value === 'string') {
        const trimmed = value.trim()
        if (trimmed.length) return trimmed
      }
    }
    for (const key of STEP_NESTED_KEYS) {
      const nested = extractStepEventText((payload as any)[key])
      if (nested) return nested
    }
    return null
  }

  function extractSnapshotHash(source: unknown): string | null {
    if (!source || typeof source !== 'object') return null
    const visited = new Set<unknown>()
    const queue: Array<{ value: any; depth: number }> = [{ value: source, depth: 0 }]
    const MAX_DEPTH = 6
    while (queue.length) {
      const { value, depth } = queue.shift()!
      if (!value || typeof value !== 'object') continue
      if (visited.has(value)) continue
      visited.add(value)
      const snapshot = coerceSnapshotHash((value as any).snapshot)
      if (snapshot) return snapshot
      if (depth >= MAX_DEPTH) continue
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry && typeof entry === 'object') {
            queue.push({ value: entry, depth: depth + 1 })
          }
        }
      } else {
        for (const key of Object.keys(value)) {
          const child = (value as any)[key]
          if (child && typeof child === 'object') {
            queue.push({ value: child, depth: depth + 1 })
          }
        }
      }
    }
    return null
  }

  function coerceSnapshotHash(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length ? trimmed : null
  }

  type StepFieldDef = { label: string; paths: string[][]; formatter?: (value: string) => string }

  const STEP_FIELD_DEFS: StepFieldDef[] = [
    { label: 'Title', paths: [['title'], ['part', 'title'], ['state', 'title']] },
    { label: 'Summary', paths: [['summary'], ['part', 'summary'], ['details'], ['part', 'details']] },
    { label: 'Description', paths: [['description'], ['part', 'description']] },
    { label: 'Message', paths: [['message'], ['part', 'message'], ['state', 'message']] },
    { label: 'Instructions', paths: [['instructions'], ['instruction'], ['state', 'instructions']] },
    { label: 'Command', paths: [['command'], ['part', 'command']] },
    { label: 'Action', paths: [['action'], ['part', 'action']] },
    { label: 'Status', paths: [['status'], ['state', 'status']] },
    { label: 'Result', paths: [['result'], ['state', 'result']] },
    { label: 'Snapshot', paths: [['snapshot'], ['part', 'snapshot']] }
  ]

  const STEP_FALLBACK_IGNORED_KEYS = new Set([
    'id',
    'sessionID',
    'messageID',
    'type',
    'time',
    'timestamp',
    'startedAt',
    'completedAt',
    'part',
    'payload',
    'data',
    'state',
    'event',
    'body',
    'provider',
    'model',
    'modelID',
    'providerID'
  ])

  function buildStepFallbackText(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') return null
    const lines: string[] = []
    for (const def of STEP_FIELD_DEFS) {
      const value = readNestedString(payload, def.paths)
      if (value) {
        lines.push(def.formatter ? def.formatter(value) : `${def.label}: ${value}`)
      }
    }
    if (lines.length) return lines.join('\n')

    const extras: string[] = []
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (STEP_FALLBACK_IGNORED_KEYS.has(key)) continue
      const formatted = formatStepValue(value)
      if (!formatted) continue
      extras.push(`${key}: ${formatted}`)
      if (extras.length >= 3) break
    }
    return extras.length ? extras.join('\n') : null
  }

  function readNestedString(source: any, paths: string[][]): string | null {
    for (const path of paths) {
      let current = source
      let valid = true
      for (const segment of path) {
        if (!current || typeof current !== 'object') {
          valid = false
          break
        }
        current = current[segment]
      }
      if (!valid) continue
      if (typeof current === 'string') {
        const trimmed = current.trim()
        if (trimmed.length) return trimmed
      }
    }
    return null
  }

  function formatStepValue(value: unknown): string | null {
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (!trimmed.length) return null
      return trimmed.length > 180 ? `${trimmed.slice(0, 177)}…` : trimmed
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value)
    }
    if (Array.isArray(value)) {
      const joined = value
        .map((entry) => formatStepValue(entry))
        .filter((entry): entry is string => Boolean(entry))
        .join(', ')
      return joined.length ? joined : null
    }
    if (value && typeof value === 'object') {
      try {
        const json = JSON.stringify(value)
        if (!json || json === '{}') return null
        return json.length > 180 ? `${json.slice(0, 177)}…` : json
      } catch {
        return null
      }
    }
    return null
  }

  function stripMetaPath(meta: SessionMeta): OpencodeSessionSummary {
    const { metaPath: _metaPath, ...rest } = meta
    void _metaPath
    return rest
  }

  return {
    rootDir,
    listSessions,
    getSession
  }
}

const execFileAsync = promisify(execFile)

function createSnapshotResolver(snapshotRoot: string): SnapshotResolver | null {
  if (!snapshotRoot || !pathExists(snapshotRoot)) return null
  return new SnapshotGitResolver(snapshotRoot)
}

type SnapshotRepoMeta = {
  name: string
  repoPath: string
  worktree?: string | null
}

type SnapshotTreeEntry = {
  type: 'blob' | 'tree'
  objectId: string
  name: string
}

type SnapshotHydratedData = Partial<Record<SnapshotActor, SnapshotLogSummary>>

type SnapshotLogSummary = {
  startText?: string | null
  finishText?: string | null
  anyText?: string | null
}

type SnapshotRequest = {
  snapshotHash: string
  workspacePath?: string | null
  stage: SnapshotStage
  actor?: SnapshotActor | null
}

class SnapshotGitResolver implements SnapshotResolver {
  private repoNamesPromise: Promise<string[]> | null = null
  private repoMetaCache = new Map<string, SnapshotRepoMeta | null>()
  private worktreeIndex = new Map<string, SnapshotRepoMeta[]>()
  private treeCache = new Map<string, SnapshotHydratedData | null>()

  constructor(private readonly root: string) {}

  async extractStepText(input: SnapshotRequest): Promise<string | null> {
    const hash = input.snapshotHash?.trim()
    if (!hash) return null
    const repo = await this.resolveRepo({ ...input, snapshotHash: hash })
    if (!repo) return null
    const data = await this.loadSnapshotData(repo, hash)
    if (!data) return null
    const stage = input.stage ?? 'unknown'
    const preferredOrder = this.buildActorPreference(input.actor)
    const candidate =
      this.pickSnapshotText(data, stage, preferredOrder) ??
      this.pickSnapshotText(data, stage === 'start' ? 'finish' : 'start', preferredOrder) ??
      this.pickSnapshotText(data, 'unknown', preferredOrder)
    return candidate ?? null
  }

  private buildActorPreference(actor?: SnapshotActor | null): SnapshotActor[] {
    if (actor === 'verifier') return ['verifier', 'worker']
    if (actor === 'worker') return ['worker', 'verifier']
    return ['worker', 'verifier']
  }

  private pickSnapshotText(data: SnapshotHydratedData, stage: SnapshotStage, order: SnapshotActor[]): string | null {
    for (const actor of order) {
      const summary = data[actor]
      if (!summary) continue
      const candidate = this.selectStageText(summary, stage)
      if (candidate) return candidate
    }
    return null
  }

  private selectStageText(summary: SnapshotLogSummary, stage: SnapshotStage): string | null {
    if (!summary) return null
    if (stage === 'start') return summary.startText ?? summary.anyText ?? summary.finishText ?? null
    if (stage === 'finish') return summary.finishText ?? summary.anyText ?? summary.startText ?? null
    return summary.anyText ?? summary.startText ?? summary.finishText ?? null
  }

  private async resolveRepo(input: SnapshotRequest): Promise<SnapshotRepoMeta | null> {
    if (input.workspacePath) {
      const byWorktree = await this.findRepoByWorktree(input.workspacePath)
      if (byWorktree && (await this.repoContainsObject(byWorktree, input.snapshotHash))) {
        return byWorktree
      }
    }
    return this.findRepoByObject(input.snapshotHash)
  }

  private async listRepoNames(): Promise<string[]> {
    if (!this.repoNamesPromise) {
      this.repoNamesPromise = fs
        .readdir(this.root, { withFileTypes: true })
        .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
        .catch(() => [])
    }
    return this.repoNamesPromise
  }

  private async loadRepoMeta(name: string): Promise<SnapshotRepoMeta | null> {
    if (this.repoMetaCache.has(name)) {
      return this.repoMetaCache.get(name) ?? null
    }
    const repoPath = path.join(this.root, name)
    try {
      const stats = await fs.stat(repoPath)
      if (!stats.isDirectory()) {
        this.repoMetaCache.set(name, null)
        return null
      }
    } catch {
      this.repoMetaCache.set(name, null)
      return null
    }
    let worktree: string | null = null
    try {
      const configPath = path.join(repoPath, 'config')
      const raw = await fs.readFile(configPath, 'utf8')
      worktree = extractWorktree(raw)
    } catch {}
    const meta: SnapshotRepoMeta = { name, repoPath, worktree }
    this.repoMetaCache.set(name, meta)
    if (worktree) this.addWorktreeIndex(meta)
    return meta
  }

  private addWorktreeIndex(meta: SnapshotRepoMeta) {
    if (!meta.worktree) return
    const key = normalizePath(meta.worktree)
    const existing = this.worktreeIndex.get(key)
    if (existing) {
      if (!existing.includes(meta)) existing.push(meta)
    } else {
      this.worktreeIndex.set(key, [meta])
    }
  }

  private async findRepoByWorktree(worktree: string): Promise<SnapshotRepoMeta | null> {
    const key = normalizePath(worktree)
    const cached = this.worktreeIndex.get(key)
    if (cached && cached.length) return cached[0]
    const names = await this.listRepoNames()
    for (const name of names) {
      const meta = await this.loadRepoMeta(name)
      if (meta?.worktree && normalizePath(meta.worktree) === key) {
        return meta
      }
    }
    return null
  }

  private async findRepoByObject(hash: string): Promise<SnapshotRepoMeta | null> {
    const names = await this.listRepoNames()
    for (const name of names) {
      const meta = await this.loadRepoMeta(name)
      if (!meta) continue
      if (await this.repoContainsObject(meta, hash)) return meta
    }
    return null
  }

  private async repoContainsObject(meta: SnapshotRepoMeta, hash: string): Promise<boolean> {
    try {
      await this.runGit(meta.repoPath, ['cat-file', '-t', hash])
      return true
    } catch {
      return false
    }
  }

  private async loadSnapshotData(meta: SnapshotRepoMeta, objectHash: string): Promise<SnapshotHydratedData | null> {
    if (this.treeCache.has(objectHash)) {
      return this.treeCache.get(objectHash) ?? null
    }
    try {
      const treeHash = await this.resolveTreeHash(meta, objectHash)
      if (!treeHash) {
        this.treeCache.set(objectHash, null)
        return null
      }
      const { logTreeHash, prefix } = await this.resolveLogTree(meta, treeHash)
      const entries = await this.listTree(meta, logTreeHash)
      if (!entries.length) {
        this.treeCache.set(objectHash, null)
        return null
      }
      const workerEntries = entries.filter((entry) => entry.type === 'blob' && isWorkerLog(entry.name))
      const verifierEntries = entries.filter((entry) => entry.type === 'blob' && isVerifierLog(entry.name))
      const workerLogs = await this.readLogEntries(meta, treeHash, workerEntries, prefix)
      const verifierLogs = await this.readLogEntries(meta, treeHash, verifierEntries, prefix)
      const data: SnapshotHydratedData = {
        worker: buildLogSummary(workerLogs, formatWorkerEntry),
        verifier: buildLogSummary(verifierLogs, formatVerifierEntry)
      }
      this.treeCache.set(objectHash, data)
      return data
    } catch {
      this.treeCache.set(objectHash, null)
      return null
    }
  }

  private async resolveTreeHash(meta: SnapshotRepoMeta, hash: string): Promise<string | null> {
    try {
      const type = (await this.runGit(meta.repoPath, ['cat-file', '-t', hash])).trim()
      if (type === 'tree') return hash
      if (type === 'commit') {
        const tree = (await this.runGit(meta.repoPath, ['show', '-s', '--format=%T', hash])).trim()
        return tree || null
      }
    } catch {}
    return null
  }

  private async resolveLogTree(
    meta: SnapshotRepoMeta,
    treeHash: string
  ): Promise<{ logTreeHash: string; prefix: string | null }> {
    const hyperTreeHash = await this.lookupTree(meta, treeHash, '.hyperagent')
    if (hyperTreeHash) {
      return { logTreeHash: hyperTreeHash, prefix: '.hyperagent' }
    }
    return { logTreeHash: treeHash, prefix: null }
  }

  private async lookupTree(meta: SnapshotRepoMeta, treeHash: string, subPath: string): Promise<string | null> {
    try {
      const output = await this.runGit(meta.repoPath, ['ls-tree', treeHash, subPath])
      const entry = output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)[0]
      if (!entry) return null
      const parts = entry.split(/\s+/)
      if (parts.length < 3 || parts[1] !== 'tree') return null
      return parts[2]
    } catch {
      return null
    }
  }

  private async listTree(meta: SnapshotRepoMeta, treeHash: string): Promise<SnapshotTreeEntry[]> {
    try {
      const output = await this.runGit(meta.repoPath, ['ls-tree', treeHash])
      return output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^(\d+)\s+(blob|tree)\s+([0-9a-f]{40})\t(.+)$/)
          if (!match) return null
          return { type: match[2] as 'blob' | 'tree', objectId: match[3], name: match[4] }
        })
        .filter((entry): entry is SnapshotTreeEntry => Boolean(entry))
    } catch {
      return []
    }
  }

  private async readLogEntries(
    meta: SnapshotRepoMeta,
    treeHash: string,
    entries: SnapshotTreeEntry[],
    prefix: string | null
  ) {
    const results: any[] = []
    for (const entry of entries) {
      const relPath = prefix ? path.posix.join(prefix, entry.name) : entry.name
      try {
        const spec = `${treeHash}:${relPath}`
        const raw = await this.runGit(meta.repoPath, ['show', spec])
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed?.log)) {
          results.push(...parsed.log)
        }
      } catch {}
    }
    return results
  }

  private async runGit(repoPath: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', ['--git-dir', repoPath, ...args], {
      maxBuffer: 10 * 1024 * 1024
    })
    return stdout.toString()
  }
}

function extractWorktree(config: string): string | null {
  const match = config.match(/worktree\s*=\s*(.+)/)
  return match ? match[1].trim() : null
}

function buildLogSummary(entries: any[], formatter: (entry: any) => string | null): SnapshotLogSummary | undefined {
  if (!entries || entries.length === 0) return undefined
  const sorted = entries.slice().sort((a, b) => {
    const aTime = Date.parse(a?.createdAt ?? '') || 0
    const bTime = Date.parse(b?.createdAt ?? '') || 0
    return aTime - bTime
  })
  const startText = formatter(sorted[0])
  const finishText = formatter(sorted[sorted.length - 1])
  const anyText =
    finishText ??
    startText ??
    sorted.map((entry) => formatter(entry)).find((value): value is string => Boolean(value)) ??
    null
  return { startText, finishText, anyText }
}

function formatWorkerEntry(entry: any): string | null {
  if (!entry) return null
  const rawOutput = extractString(entry?.payload?.output)
  const structured = rawOutput ? parseJsonString(rawOutput) : null
  const lines: string[] = []
  if (structured && typeof structured === 'object') {
    if (typeof structured.status === 'string' && structured.status.trim().length) {
      lines.push(`Status: ${structured.status.trim()}`)
    }
    if (typeof structured.plan === 'string' && structured.plan.trim().length) {
      lines.push(`Plan:\n${structured.plan.trim()}`)
    }
    if (typeof structured.work === 'string' && structured.work.trim().length) {
      lines.push(`Work:\n${structured.work.trim()}`)
    }
    if (typeof structured.requests === 'string' && structured.requests.trim().length) {
      lines.push(`Requests:\n${structured.requests.trim()}`)
    }
    const text = lines.join('\n\n').trim()
    if (text.length) return text
  }
  return rawOutput ? rawOutput.trim() : null
}

function formatVerifierEntry(entry: any): string | null {
  if (!entry) return null
  const rawOutput = extractString(entry?.payload?.output)
  const structured = rawOutput ? parseJsonString(rawOutput) : null
  const lines: string[] = []
  if (structured && typeof structured === 'object') {
    if (typeof structured.verdict === 'string' && structured.verdict.trim().length) {
      const priority = typeof structured.priority === 'number' ? ` (priority ${structured.priority})` : ''
      lines.push(`Verdict: ${structured.verdict.trim()}${priority}`)
    }
    if (typeof structured.critique === 'string' && structured.critique.trim().length) {
      lines.push(`Critique:\n${structured.critique.trim()}`)
    }
    if (typeof structured.instructions === 'string' && structured.instructions.trim().length) {
      lines.push(`Instructions:\n${structured.instructions.trim()}`)
    }
    const text = lines.join('\n\n').trim()
    if (text.length) return text
  }
  return rawOutput ? rawOutput.trim() : null
}

function isWorkerLog(name: string): boolean {
  const normalized = name.toLowerCase()
  return normalized.includes('worker-')
}

function isVerifierLog(name: string): boolean {
  const normalized = name.toLowerCase()
  return normalized.includes('verifier-')
}

function extractString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return null
    }
  }
  return null
}

function parseJsonString(raw: string): any | null {
  if (!raw || !raw.trim().length || raw.trim()[0] !== '{') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function normalizeActorRole(value: unknown): SnapshotActor | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (!normalized.length) return null
  if (normalized.includes('worker')) return 'worker'
  if (normalized.includes('verifier')) return 'verifier'
  return null
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
