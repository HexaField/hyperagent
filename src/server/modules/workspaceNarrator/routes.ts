import { Router, type RequestHandler } from 'express'
import { createReadStream } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'node:crypto'
import type {
  WorkspaceNarratorEvent,
  WorkspaceNarratorFeedResponse,
  WorkspaceNarratorMessageRequest,
  WorkspaceNarratorMessageResponse
} from '../../../interfaces/widgets/workspaceNarrator'
import { streamChat } from '../../../modules/streaming-llm/ts-client/src/client'

export type WrapAsync = (handler: RequestHandler) => RequestHandler

type NarratorRelayParams = {
  workspaceId: string
  conversationId: string
  message: string
}

type NarratorRelayResult = {
  narration: string
}

export type NarratorRelay = (params: NarratorRelayParams) => Promise<NarratorRelayResult>

export type WorkspaceNarratorDeps = {
  wrapAsync: WrapAsync
  narratorRelay?: NarratorRelay
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const RELAY_TIMEOUT_MS = 45000
const ALLOWED_TYPES = new Set([
  'USER_MESSAGE',
  'NARRATION',
  'NARRATION_SUPPRESSED',
  'AGENT_UPDATE',
  'AGENT_RESULT',
  'SUMMARY_REFRESH',
  'ERROR',
  'WORKSPACE_NARRATOR_COMPLETED'
])
const FAILURE_OUTCOMES = new Set(['failed', 'failure', 'error', 'timeout', 'cancelled', 'aborted'])
const PLAYBOOK_IDS = {
  suppressed: 'narration-suppressed',
  agentFailure: 'agent-run-failed',
  narratorError: 'narrator-error'
} as const
const DEFAULT_DATA_DIR = path.resolve(__dirname, '../../../modules/streaming-llm/data')
const STREAMING_LLM_WS_URL = process.env.STREAMING_LLM_WS_URL ?? 'ws://localhost:8000/ws/chat'
const STREAMING_LLM_AGENT_ID = process.env.STREAMING_LLM_CONTROLLER_AGENT ?? 'controller'

const nodeRequire = eval('require') as NodeJS.Require
type NodeWebSocketCtor = { new (url: string): WebSocket }
let cachedWebSocketCtor: NodeWebSocketCtor | null = null

const loadNodeWebSocketCtor = (): NodeWebSocketCtor => {
  if (cachedWebSocketCtor) {
    return cachedWebSocketCtor
  }
  const candidateLoaders: Array<() => unknown> = [
    () => nodeRequire(path.resolve(process.cwd(), 'node_modules/ws/index.js')),
    () => nodeRequire('ws')
  ]
  for (const loader of candidateLoaders) {
    try {
      const module = loader() as Record<string, unknown>
      const candidate = (module['WebSocket'] ?? module['default'] ?? module) as NodeWebSocketCtor | undefined
      if (typeof candidate === 'function') {
        cachedWebSocketCtor = candidate
        return candidate
      }
    } catch {
      // try next loader
    }
  }
  throw new Error('Unable to load ws WebSocket constructor for narrator relay')
}

const createRelaySocket = (url: string): WebSocket => {
  const WebSocketCtor = loadNodeWebSocketCtor()
  return new WebSocketCtor(url)
}

const createDefaultNarratorRelay = (): NarratorRelay => {
  return async ({ conversationId, message }) => {
    const tokens: string[] = []
    let settled = false
    let resolveCompletion!: (value: NarratorRelayResult) => void
    let rejectCompletion!: (reason: Error) => void

    const completion = new Promise<NarratorRelayResult>((resolve, reject) => {
      resolveCompletion = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      rejectCompletion = (error) => {
        if (settled) return
        settled = true
        reject(error)
      }
    })

    const timeout = setTimeout(() => {
      if (!settled) {
        rejectCompletion(new Error('Narrator relay timed out'))
      }
    }, RELAY_TIMEOUT_MS)

    const handle = await streamChat({
      backendUrl: STREAMING_LLM_WS_URL,
      agentId: STREAMING_LLM_AGENT_ID,
      conversationId,
      socketFactory: (url) => createRelaySocket(url),
      onEvent: (event) => {
        if (event.type === 'token') {
          tokens.push(event.token ?? '')
        } else if (event.type === 'done') {
          resolveCompletion({ narration: tokens.join('').trim() })
        } else if (event.type === 'error') {
          rejectCompletion(new Error(event.message ?? 'Narrator relay error'))
        }
      }
    })

    try {
      handle.sendMessage({
        message,
        conversationId,
        agentId: STREAMING_LLM_AGENT_ID
      })
      return await completion
    } finally {
      clearTimeout(timeout)
      handle.stop()
    }
  }
}

export const createWorkspaceNarratorRouter = ({ wrapAsync, narratorRelay }: WorkspaceNarratorDeps) => {
  const router = Router()
  const relay = narratorRelay ?? createDefaultNarratorRelay()

  router.get(
    '/api/workspaces/:workspaceId/narrator/feed',
    wrapAsync(async (req, res) => {
      const workspaceId = parseWorkspaceId(req.params.workspaceId)
      if (!workspaceId) {
        res.status(400).json({ error: 'workspaceId is required' })
        return
      }
      const dataDir = resolveDataDir()
      const conversationId = await resolveConversationId(workspaceId, req.query.conversationId, dataDir)
      const limit = clampLimit(req.query.limit)
      const { events, summaryCandidate } = await readNarratorEvents(conversationId, dataDir)
      const payload: WorkspaceNarratorFeedResponse = {
        workspaceId,
        conversationId,
        summaryRef: summaryCandidate ? await resolveSummaryRef(summaryCandidate, dataDir) : null,
        events: events.slice(0, limit)
      }
      res.json(payload)
    })
  )

  router.get(
    '/api/workspaces/:workspaceId/narrator/raw',
    wrapAsync(async (req, res) => {
      const workspaceId = parseWorkspaceId(req.params.workspaceId)
      if (!workspaceId) {
        res.status(400).json({ error: 'workspaceId is required' })
        return
      }
      const dataDir = resolveDataDir()
      const conversationId = await resolveConversationId(workspaceId, req.query.conversationId, dataDir)
      const logPath = path.join(dataDir, 'logs', `${conversationId}.jsonl`)
      if (!(await fileExists(logPath))) {
        res.status(404).json({ error: 'Narrator log not found' })
        return
      }
      res.setHeader('Content-Type', 'application/jsonl; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      createReadStream(logPath).pipe(res)
    })
  )

  router.post(
    '/api/workspaces/:workspaceId/narrator/messages',
    wrapAsync(async (req, res) => {
      const workspaceId = parseWorkspaceId(req.params.workspaceId)
      if (!workspaceId) {
        res.status(400).json({ error: 'workspaceId is required' })
        return
      }
      const body = (req.body ?? {}) as Partial<WorkspaceNarratorMessageRequest>
      const message = typeof body.message === 'string' ? body.message.trim() : ''
      if (!message) {
        res.status(400).json({ error: 'message is required' })
        return
      }
      const dataDir = resolveDataDir()
      const conversationId = await resolveConversationId(workspaceId, req.query.conversationId, dataDir)
      await appendUserNarration(conversationId, message, dataDir)
      const task = await enqueueWorkspaceNarratorTask({ workspaceId, conversationId, message, dataDir })
      await appendRelayStatusEvent({
        conversationId,
        taskId: task.id,
        status: 'controller_enqueued',
        detail: 'Controller notified of workspace narrator message',
        dataDir
      })
      try {
        const relayResult = await relay({ workspaceId, conversationId, message })
        const narratorEvent = await appendNarratorResponse(conversationId, relayResult.narration, dataDir)
        await completeWorkspaceNarratorTask({ taskId: task.id, dataDir, narratorEventId: narratorEvent.id })
        await appendCompletionEvent({ conversationId, taskId: task.id, narratorEventId: narratorEvent.id, dataDir })
        const payload: WorkspaceNarratorMessageResponse = {
          workspaceId,
          conversationId,
          eventId: narratorEvent.id,
          taskId: task.id
        }
        res.status(202).json(payload)
      } catch (error) {
        await failWorkspaceNarratorTask({ taskId: task.id, dataDir, reason: error })
        const failureEvent = await appendRelayFailureEvent({ conversationId, taskId: task.id, dataDir, error })
        const failureDetail =
          typeof failureEvent.payload?.['detail'] === 'string' ? (failureEvent.payload['detail'] as string) : formatError(error)
        res.status(502).json({ error: 'relay_failed', detail: failureDetail })
      }
    })
  )

  return router
}

type NormalizedEvent = {
  event: WorkspaceNarratorEvent
  summaryRefCandidate: string | null
  sortKey: number
}

type RawLogEntry = {
  id: string
  conversation_id: string
  timestamp: string
  type: string
  payload: Record<string, unknown>
}

const parseWorkspaceId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length ? trimmed : null
}

const resolveDataDir = (): string => {
  const explicit = typeof process.env.STREAMING_LLM_DATA_DIR === 'string' ? process.env.STREAMING_LLM_DATA_DIR.trim() : ''
  return explicit.length ? path.resolve(explicit) : DEFAULT_DATA_DIR
}

const clampLimit = (raw: unknown): number => {
  const candidate =
    typeof raw === 'string'
      ? Number.parseInt(raw, 10)
      : typeof raw === 'number'
        ? Math.trunc(raw)
        : Array.isArray(raw)
          ? Number.parseInt(raw[0] ?? '', 10)
          : NaN
  if (!Number.isFinite(candidate) || candidate <= 0) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, candidate)
}

const resolveConversationId = async (
  workspaceId: string,
  explicit: unknown,
  dataDir: string
): Promise<string> => {
  const override = normalizeString(explicit)
  if (override) return override
  const inferred = await inferConversationIdFromGraph(workspaceId, dataDir)
  return inferred ?? workspaceId
}

const inferConversationIdFromGraph = async (workspaceId: string, dataDir: string): Promise<string | null> => {
  const graphPath = path.join(dataDir, 'tasks.graph.json')
  const graph = await readJsonFile(graphPath)
  if (!graph) return null
  const tasks = Array.isArray(graph.tasks) ? graph.tasks : []
  const matches: Array<{ conversationId: string; sortKey: number }> = []
  for (const task of tasks) {
    if (!isPlainObject(task)) continue
    const taskRecord = task as Record<string, unknown>
    const metadataValue = taskRecord['metadata']
    const metadata = isPlainObject(metadataValue) ? (metadataValue as Record<string, unknown>) : {}
    const workspaceMeta = normalizeString(metadata['workspace_id'] ?? metadata['workspaceId'])
    if (workspaceMeta !== workspaceId) continue
    const conversation =
      normalizeString(metadata['conversation_id'] ?? metadata['conversationId']) ?? workspaceMeta ?? workspaceId
    matches.push({
      conversationId: conversation,
      sortKey: extractSortKey(
        taskRecord['updated_at'] ?? taskRecord['updatedAt'] ?? taskRecord['created_at'] ?? taskRecord['createdAt']
      )
    })
  }
  if (!matches.length) return null
  matches.sort((a, b) => b.sortKey - a.sortKey)
  return matches[0]?.conversationId ?? null
}

const readNarratorEvents = async (
  conversationId: string,
  dataDir: string
): Promise<{ events: WorkspaceNarratorEvent[]; summaryCandidate: string | null }> => {
  const logPath = path.join(dataDir, 'logs', `${conversationId}.jsonl`)
  const content = await readTextFile(logPath)
  if (!content) {
    return { events: [], summaryCandidate: null }
  }
  const candidates: NormalizedEvent[] = []
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parsed = safeParseJson(trimmed)
    if (!parsed) continue
    const normalized = normalizeEvent(parsed)
    if (normalized) candidates.push(normalized)
  }
  if (!candidates.length) {
    return { events: [], summaryCandidate: null }
  }
  candidates.sort((a, b) => {
    const diff = b.sortKey - a.sortKey
    if (diff !== 0) return diff
    return b.event.id.localeCompare(a.event.id)
  })
  const summaryCandidate = candidates.find((entry) => Boolean(entry.summaryRefCandidate))?.summaryRefCandidate ?? null
  return { events: candidates.map((entry) => entry.event), summaryCandidate }
}

const appendLogEntry = async (conversationId: string, entry: RawLogEntry, dataDir: string): Promise<RawLogEntry> => {
  const logsDir = path.join(dataDir, 'logs')
  await fs.mkdir(logsDir, { recursive: true })
  const logPath = path.join(logsDir, `${conversationId}.jsonl`)
  await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf-8')
  return entry
}

const appendUserNarration = async (conversationId: string, message: string, dataDir: string): Promise<string> => {
  const entry = buildUserNarration(conversationId, message)
  await appendLogEntry(conversationId, entry, dataDir)
  return entry.id
}

const appendNarratorResponse = async (
  conversationId: string,
  narration: string,
  dataDir: string
): Promise<RawLogEntry> => {
  const entry: RawLogEntry = {
    id: `narrator-${randomUUID()}`,
    conversation_id: conversationId,
    timestamp: new Date().toISOString(),
    type: 'NARRATION',
    payload: {
      headline: 'Narrator reply',
      text: narration
    }
  }
  return appendLogEntry(conversationId, entry, dataDir)
}

const appendCompletionEvent = async ({
  conversationId,
  taskId,
  narratorEventId,
  dataDir
}: {
  conversationId: string
  taskId: string
  narratorEventId: string
  dataDir: string
}): Promise<RawLogEntry> => {
  const entry: RawLogEntry = {
    id: `completion-${randomUUID()}`,
    conversation_id: conversationId,
    timestamp: new Date().toISOString(),
    type: 'WORKSPACE_NARRATOR_COMPLETED',
    payload: {
      headline: 'Workspace narrator relay completed',
      narrator_event_id: narratorEventId,
      task_id: taskId
    }
  }
  return appendLogEntry(conversationId, entry, dataDir)
}

const appendRelayFailureEvent = async ({
  conversationId,
  taskId,
  dataDir,
  error
}: {
  conversationId: string
  taskId: string
  dataDir: string
  error: unknown
}): Promise<RawLogEntry> => {
  const entry: RawLogEntry = {
    id: `error-${randomUUID()}`,
    conversation_id: conversationId,
    timestamp: new Date().toISOString(),
    type: 'ERROR',
    payload: {
      headline: 'Narrator relay failed',
      detail: formatError(error),
      task_id: taskId
    }
  }
  return appendLogEntry(conversationId, entry, dataDir)
}

const appendRelayStatusEvent = async ({
  conversationId,
  taskId,
  status,
  detail,
  dataDir
}: {
  conversationId: string
  taskId: string
  status: string
  detail?: string
  dataDir: string
}): Promise<RawLogEntry> => {
  const entry: RawLogEntry = {
    id: `agent-update-${randomUUID()}`,
    conversation_id: conversationId,
    timestamp: new Date().toISOString(),
    type: 'AGENT_UPDATE',
    payload: {
      status,
      detail: detail ?? null,
      task_id: taskId
    }
  }
  return appendLogEntry(conversationId, entry, dataDir)
}

type WorkspaceTaskRecord = Record<string, any> & {
  id: string
}

type TaskGraphPayload = {
  tasks: WorkspaceTaskRecord[]
  [key: string]: any
}

const buildUserNarration = (conversationId: string, message: string): RawLogEntry => {
  return {
    id: `user-${randomUUID()}`,
    conversation_id: conversationId,
    timestamp: new Date().toISOString(),
    type: 'USER_MESSAGE',
    payload: {
      headline: 'User message',
      text: message
    }
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string') {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  try {
    return JSON.stringify(error)
  } catch {
    return 'Unknown error'
  }
}

const enqueueWorkspaceNarratorTask = async ({
  workspaceId,
  conversationId,
  message,
  dataDir
}: {
  workspaceId: string
  conversationId: string
  message: string
  dataDir: string
}): Promise<WorkspaceTaskRecord> => {
  const graph = await readTaskGraphFile(dataDir)
  const now = new Date().toISOString()
  const task: WorkspaceTaskRecord = {
    id: `task-${randomUUID()}`,
    type: 'controller',
    status: 'PENDING',
    owner: null,
    inputs: {
      user_message: message,
      workspace_id: workspaceId,
      conversation_id: conversationId
    },
    outputs: {},
    context: {},
    metadata: {
      workspace_id: workspaceId,
      conversation_id: conversationId,
      source: 'workspace-narrator'
    },
    priority: 0,
    attempt: 0,
    created_at: now,
    updated_at: now,
    dependency_ids: []
  }
  graph.tasks.push(task)
  await writeTaskGraphFile(dataDir, graph)
  return task
}

const completeWorkspaceNarratorTask = async ({
  taskId,
  narratorEventId,
  dataDir
}: {
  taskId: string
  narratorEventId: string
  dataDir: string
}): Promise<WorkspaceTaskRecord | null> => {
  return updateTaskGraphTask(dataDir, taskId, (task) => {
    task.status = 'COMPLETED'
    const outputs = isPlainObject(task.outputs) ? (task.outputs as Record<string, unknown>) : {}
    outputs['narrator_event_id'] = narratorEventId
    task.outputs = outputs
    const metadata = isPlainObject(task.metadata) ? (task.metadata as Record<string, unknown>) : {}
    metadata['last_completed_event_id'] = narratorEventId
    task.metadata = metadata
  })
}

const failWorkspaceNarratorTask = async ({
  taskId,
  dataDir,
  reason
}: {
  taskId: string
  dataDir: string
  reason: unknown
}): Promise<WorkspaceTaskRecord | null> => {
  return updateTaskGraphTask(dataDir, taskId, (task) => {
    task.status = 'FAILED'
    const outputs = isPlainObject(task.outputs) ? (task.outputs as Record<string, unknown>) : {}
    outputs['error'] = formatError(reason)
    task.outputs = outputs
  })
}

const updateTaskGraphTask = async (
  dataDir: string,
  taskId: string,
  apply: (task: WorkspaceTaskRecord) => void
): Promise<WorkspaceTaskRecord | null> => {
  const graph = await readTaskGraphFile(dataDir)
  const tasks = graph.tasks
  const target = tasks.find((entry) => entry.id === taskId)
  if (!target) {
    return null
  }
  apply(target)
  target.updated_at = new Date().toISOString()
  await writeTaskGraphFile(dataDir, graph)
  return target
}

const readTaskGraphFile = async (dataDir: string): Promise<TaskGraphPayload> => {
  const graphPath = path.join(dataDir, 'tasks.graph.json')
  const base = (await readJsonFile(graphPath)) ?? { tasks: [] }
  const normalized: TaskGraphPayload = {
    ...base,
    tasks: Array.isArray(base.tasks) ? (base.tasks as WorkspaceTaskRecord[]) : []
  }
  return normalized
}

const writeTaskGraphFile = async (dataDir: string, payload: TaskGraphPayload) => {
  const graphPath = path.join(dataDir, 'tasks.graph.json')
  await fs.mkdir(path.dirname(graphPath), { recursive: true })
  payload.tasks = Array.isArray(payload.tasks) ? payload.tasks : []
  await fs.writeFile(graphPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
}

const normalizeEvent = (input: unknown): NormalizedEvent | null => {
  if (!isPlainObject(input)) return null
  const rawType = normalizeString(input.type)
  if (!rawType) return null
  const upperType = rawType.toUpperCase()
  if (!ALLOWED_TYPES.has(upperType)) return null
  const payload = isPlainObject(input.payload) ? (input.payload as Record<string, unknown>) : {}
  const baseEvent: WorkspaceNarratorEvent = {
    id: normalizeString(input.id) ?? `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: normalizeString(input.timestamp) ?? new Date().toISOString(),
    type: 'narration',
    headline: 'Narrator update',
    detail: null,
    severity: 'info',
    source: 'narrator'
  }
  let summaryRefCandidate: string | null = null

  if (upperType === 'USER_MESSAGE') {
    baseEvent.type = 'narration'
    baseEvent.headline = normalizeString(payload['headline']) ?? 'User message'
    baseEvent.detail = normalizeString(payload['text']) ?? normalizeString(payload['detail'])
    baseEvent.source = 'user'
    baseEvent.severity = 'info'
  } else if (upperType === 'NARRATION') {
    baseEvent.type = 'narration'
    baseEvent.headline = normalizeString(payload['headline']) ?? 'Narrator update'
    baseEvent.detail = normalizeString(payload['text']) ?? normalizeString(payload['detail'])
    baseEvent.source = 'narrator'
    baseEvent.severity = 'info'
  } else if (upperType === 'NARRATION_SUPPRESSED') {
    baseEvent.type = 'suppressed'
    baseEvent.headline = normalizeString(payload['headline']) ?? 'Narration suppressed'
    baseEvent.detail = normalizeString(payload['reason']) ?? normalizeString(payload['detail'])
    baseEvent.source = 'system'
    baseEvent.severity = 'warning'
    baseEvent.playbookId = PLAYBOOK_IDS.suppressed
  } else if (upperType === 'AGENT_UPDATE') {
    baseEvent.type = 'agent-update'
    const status = normalizeString(payload['status'])
    baseEvent.headline = status ? `Agent update: ${status}` : 'Agent update'
    baseEvent.detail = normalizeString(payload['detail']) ?? normalizeString(payload['text'])
    baseEvent.source = 'agent'
    baseEvent.severity = 'info'
  } else if (upperType === 'AGENT_RESULT') {
    baseEvent.type = 'agent-result'
    const outcome = normalizeString(payload['outcome'])?.toLowerCase()
    const errorValue = (payload as Record<string, unknown>)['error']
    const errorPayload = isPlainObject(errorValue) ? (errorValue as Record<string, unknown>) : null
    const isFailure = Boolean(errorPayload) || (outcome ? FAILURE_OUTCOMES.has(outcome) : false)
    baseEvent.headline = isFailure ? 'Agent task failed' : 'Agent task completed'
    if (isFailure) {
      baseEvent.detail =
        normalizeString(errorPayload?.['reason']) ??
        normalizeString(errorPayload?.['message']) ??
        normalizeString(payload['detail']) ??
        normalizeString(payload['text'])
      baseEvent.severity = 'error'
      baseEvent.playbookId = PLAYBOOK_IDS.agentFailure
    } else {
      baseEvent.detail =
        normalizeString(payload['summary']) ?? normalizeString(payload['detail']) ?? normalizeString(payload['text'])
      baseEvent.severity = 'info'
      delete baseEvent.playbookId
    }
    baseEvent.source = 'agent'
  } else if (upperType === 'SUMMARY_REFRESH') {
    baseEvent.type = 'summary'
    baseEvent.headline = 'Summary refreshed'
    baseEvent.detail = normalizeString(payload['note']) ?? normalizeString(payload['detail'])
    baseEvent.source = 'system'
    baseEvent.severity = 'info'
    summaryRefCandidate =
      normalizeString(payload['summary_ref'] ?? payload['summaryRef'] ?? payload['summaryPath']) ?? null
  } else if (upperType === 'ERROR') {
    baseEvent.type = 'error'
    baseEvent.headline =
      normalizeString(payload['headline']) ?? normalizeString(payload['reason']) ?? 'Narrator error'
    baseEvent.detail = normalizeString(payload['detail']) ?? normalizeString(payload['message'])
    baseEvent.source = 'system'
    baseEvent.severity = 'error'
    baseEvent.playbookId = PLAYBOOK_IDS.narratorError
  } else if (upperType === 'WORKSPACE_NARRATOR_COMPLETED') {
    baseEvent.type = 'agent-result'
    baseEvent.headline = normalizeString(payload['headline']) ?? 'Workspace narrator completed'
    const narratorId = normalizeString(payload['narrator_event_id'] ?? payload['narratorEventId'])
    const taskId = normalizeString(payload['task_id'] ?? payload['taskId'])
    const detailParts = []
    if (narratorId) detailParts.push(`Narrator event ${narratorId}`)
    if (taskId) detailParts.push(`task ${taskId}`)
    baseEvent.detail = detailParts.length ? detailParts.join(' • ') : null
    baseEvent.source = 'system'
    baseEvent.severity = 'info'
  } else {
    return null
  }

  baseEvent.detail = baseEvent.detail ?? null

  return {
    event: baseEvent,
    summaryRefCandidate,
    sortKey: extractSortKey(baseEvent.timestamp)
  }
}

const resolveSummaryRef = async (candidate: string | null, dataDir: string): Promise<string | null> => {
  if (!candidate) return null
  const sanitized = candidate.replace(/^\/+/, '')
  const appended = sanitized.startsWith('summaries/') ? sanitized : path.join('summaries', sanitized)
  const absolute = path.resolve(dataDir, appended)
  if (!absolute.startsWith(path.resolve(dataDir))) return null
  try {
    const stat = await fs.stat(absolute)
    if (!stat.isFile()) return null
    return path.relative(dataDir, absolute)
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

const readJsonFile = async (filePath: string): Promise<Record<string, any> | null> => {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = safeParseJson(raw)
    return isPlainObject(parsed) ? (parsed as Record<string, any>) : null
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

const readTextFile = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

const safeParseJson = (value: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(value)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

const isPlainObject = (value: unknown): value is Record<string, any> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const normalizeString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length ? trimmed : null
}

const extractSortKey = (value: unknown): number => {
  const timestamp = normalizeString(typeof value === 'number' ? new Date(value).toISOString() : (value as string))
  if (!timestamp) return 0
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : 0
}

const isNotFound = (error: unknown): boolean => {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')
}
