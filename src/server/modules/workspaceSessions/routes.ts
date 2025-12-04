import crypto from 'crypto'
import { Router, type RequestHandler } from 'express'
import fs from 'fs/promises'
import path from 'path'
import type { CodingAgentCommandRunner } from '../../../../src/modules/opencodeCommandRunner'
import type { CodingAgentRunner, CodingAgentStorage } from '../../../../src/modules/provider'
import { runProviderInvocation } from '../../../../src/modules/providerRunner'
import { getProviderAdapter, listProviders } from '../../../../src/modules/providers'
import type {
  CodingAgentMessage,
  CodingAgentProvider,
  CodingAgentProviderListResponse,
  CodingAgentRunListResponse,
  CodingAgentRunRecord,
  CodingAgentSessionDetail,
  CodingAgentSessionListResponse,
  CodingAgentSessionSummary
} from '../../../interfaces/core/codingAgent'
import {
  CODING_AGENT_PROVIDER_ID,
  DEFAULT_CODING_AGENT_MODEL,
  FALLBACK_CODING_AGENT_MODEL_IDS,
  KNOWN_CODING_AGENT_MODEL_LABELS
} from '../../core/config'

import { ensureProviderConfig } from '../../../../src/modules/workflowAgentExecutor'
import {
  runVerifierWorkerLoop,
  type AgentLoopResult,
  type VerifierStructuredResponse,
  type WorkerStructuredResponse
} from '../../../modules/agent/agent'
import { deletePersona, listPersonas, readPersona, writePersona } from './personas'

const MULTI_AGENT_PERSONA_ID = 'multi-agent'
const MULTI_AGENT_PROVIDER_ID = 'multi-agent'

type WrapAsync = (handler: RequestHandler) => RequestHandler

const dedupeSequentialMessages = (messages: CodingAgentMessage[]): CodingAgentMessage[] => {
  if (!Array.isArray(messages) || messages.length <= 1) return messages ?? []
  const result: CodingAgentMessage[] = []
  let previousSignature: string | null = null
  for (const message of messages) {
    const signature = buildMessageSignature(message)
    if (previousSignature && signature === previousSignature) {
      continue
    }
    result.push(message)
    previousSignature = signature
  }
  return result
}

const buildMessageSignature = (message: CodingAgentMessage): string => {
  try {
    return JSON.stringify({
      role: message.role,
      text: message.text,
      completedAt: message.completedAt,
      modelId: message.modelId,
      providerId: message.providerId,
      parts: simplifyPartsForSignature(message.parts)
    })
  } catch {
    return `${message.id ?? ''}:${message.role ?? ''}:${message.completedAt ?? ''}:${message.text ?? ''}:${
      message.parts?.length ?? 0
    }`
  }
}

const simplifyPartsForSignature = (parts: CodingAgentMessage['parts']): unknown[] => {
  if (!Array.isArray(parts)) return []
  return parts.map((part) => {
    if (!part || typeof part !== 'object') return part
    const { id, messageID, sessionID, ...rest } = part as Record<string, unknown>
    void id
    void messageID
    void sessionID
    return rest
  })
}

export type WorkspaceSessionsDeps = {
  wrapAsync: WrapAsync
  codingAgentRunner: CodingAgentRunner
  codingAgentStorage: CodingAgentStorage
  codingAgentCommandRunner: CodingAgentCommandRunner
  ensureWorkspaceDirectory: (dirPath: string) => Promise<void>
}

export const createWorkspaceSessionsRouter = (deps: WorkspaceSessionsDeps) => {
  const { wrapAsync, codingAgentRunner, codingAgentStorage, codingAgentCommandRunner, ensureWorkspaceDirectory } = deps
  const router = Router()

  const logSessions = (message: string, metadata?: Record<string, unknown>) => {
    if (metadata && Object.keys(metadata).length) {
      console.log(`[coding-agent] ${message}`, metadata)
      return
    }
    console.log(`[coding-agent] ${message}`)
  }

  const logSessionsError = (message: string, error: unknown, metadata?: Record<string, unknown>) => {
    const payload = {
      ...(metadata ?? {}),
      error:
        error instanceof Error
          ? { message: error.message, stack: error.stack }
          : typeof error === 'string'
            ? { message: error }
            : error
    }
    console.error(`[coding-agent] ${message}`, payload)
  }

  const startMultiAgentSession = async (options: {
    workspacePath: string
    prompt: string
    title: string | null
    model: string
    llmProviderId: string | null
    personaId: string | null
  }): Promise<CodingAgentRunRecord> => {
    const sessionId = `ses_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
    const startedAt = new Date().toISOString()
    const run = {
      sessionId,
      pid: -1,
      workspacePath: options.workspacePath,
      prompt: options.prompt,
      title: options.title,
      model: options.model,
      providerId: MULTI_AGENT_PROVIDER_ID,
      logFile: null,
      startedAt,
      updatedAt: startedAt,
      status: 'running',
      exitCode: null,
      signal: null
    } as unknown as CodingAgentRunRecord

    const storageRoot = codingAgentStorage.rootDir
    const storagePaths = storageRoot
      ? {
          storageDir: path.join(storageRoot, 'storage'),
          messageRoot: path.join(storageRoot, 'storage', 'message'),
          partRoot: path.join(storageRoot, 'storage', 'part')
        }
      : null

    const writeStructuredMessage = async (payload: {
      role: string
      text: string
      providerId?: string | null
      modelId?: string | null
    }): Promise<boolean> => {
      if (!storagePaths) return false
      try {
        const sessionMessageDir = path.join(storagePaths.messageRoot, sessionId)
        await fs.mkdir(sessionMessageDir, { recursive: true })
        await fs.mkdir(storagePaths.partRoot, { recursive: true })
        const messageId = crypto.randomUUID()
        const partId = crypto.randomUUID()
        const now = new Date().toISOString()
        const messageJson = {
          id: messageId,
          sessionID: sessionId,
          role: payload.role,
          time: { created: now, completed: now },
          modelID: payload.modelId ?? null,
          providerID: payload.providerId ?? null
        }
        await fs.writeFile(
          path.join(sessionMessageDir, `${messageId}.json`),
          JSON.stringify(messageJson, null, 2),
          'utf8'
        )
        const partDirPath = path.join(storagePaths.partRoot, messageId)
        await fs.mkdir(partDirPath, { recursive: true })
        const partJson = {
          id: partId,
          type: 'text',
          text: payload.text,
          time: { start: Date.now(), end: Date.now() }
        }
        await fs.writeFile(path.join(partDirPath, `${partId}.json`), JSON.stringify(partJson, null, 2), 'utf8')
        console.log('[coding-agent] persisted structured message', {
          sessionId,
          role: payload.role,
          messagePath: path.join(sessionMessageDir, `${messageId}.json`),
          partPath: path.join(partDirPath, `${partId}.json`)
        })
        return true
      } catch (err) {
        console.warn('[coding-agent] Failed to write agent message to storage', {
          error: (err as any)?.message ?? String(err)
        })
        return false
      }
    }

    const formatWorkerMessage = (payload: Partial<WorkerStructuredResponse>): string | null => {
      if (!payload) return null
      const sections: string[] = []
      if (payload.status) sections.push(`Status: ${payload.status}`)
      if (payload.plan) sections.push(`Plan:\n${payload.plan}`)
      if (payload.work) sections.push(`Work:\n${payload.work}`)
      if (payload.requests) sections.push(`Requests:\n${payload.requests}`)
      if (!sections.length) return null
      return sections.join('\n\n').trim()
    }

    const formatVerifierMessage = (payload: Partial<VerifierStructuredResponse>): string | null => {
      if (!payload) return null
      const sections: string[] = []
      if (payload.verdict) {
        const prioritySegment = typeof payload.priority === 'number' ? ` (priority ${payload.priority})` : ''
        sections.push(`Verdict: ${payload.verdict}${prioritySegment}`)
      }
      if (payload.critique) sections.push(`Critique:\n${payload.critique}`)
      if (payload.instructions) sections.push(`Instructions:\n${payload.instructions}`)
      if (!sections.length) return null
      return sections.join('\n\n').trim()
    }

    try {
      if (storagePaths) {
        const sessionMetaDir = path.join(storagePaths.storageDir, 'session', 'global')
        await fs.mkdir(sessionMetaDir, { recursive: true })
        const now = Date.now()
        const metaJson = {
          id: sessionId,
          directory: options.workspacePath,
          title: run.title ?? null,
          time: { created: now, updated: now },
          summary: { additions: 0, deletions: 0, files: 0 }
        }
        await fs.writeFile(path.join(sessionMetaDir, `${sessionId}.json`), JSON.stringify(metaJson, null, 2), 'utf8')
      }
    } catch (err) {
      console.warn('[coding-agent] Failed to write session meta to storage', {
        error: (err as any)?.message ?? String(err)
      })
    }

    logSessions('Coding agent run started (multi-agent persona)', {
      workspacePath: options.workspacePath,
      sessionId: run.sessionId
    })

    const logDir = path.join(options.workspacePath, '.opencode', 'agent-streams')
    await fs.mkdir(logDir, { recursive: true })
    const logPath = path.join(logDir, `${run.sessionId}.log`)

    const appendLogLine = async (entry: { role: string; content: string; round?: number }) => {
      const time = new Date().toISOString()
      const roundSegment = typeof entry.round === 'number' ? `[round:${entry.round}] ` : ''
      const line = `[${time}] [${entry.role}] ${roundSegment}${entry.content}\n`
      await fs.appendFile(logPath, line, 'utf8')
    }

    const primeUserPrompt = async () => {
      const trimmed = options.prompt.trim()
      if (!trimmed) return
      const ok = await writeStructuredMessage({
        role: 'user',
        text: trimmed,
        providerId: MULTI_AGENT_PROVIDER_ID,
        modelId: options.model ?? null
      })
      if (!ok) await appendLogLine({ role: 'user', content: trimmed })
    }

    await primeUserPrompt()

    type JsonChunkParser = {
      push: (chunk: string) => void
      flush: () => string
    }

    type StreamEntry = {
      role: string
      round: number
      rawBuffer: string
      parser: JsonChunkParser
    }

    const streamEntries = new Map<string, StreamEntry>()
    const persistedStreamKeys = new Set<string>()
    const streamKey = (role: string, round: number) => `${role}:${round}`

    const createJsonChunkParser = (onObject: (payload: unknown) => void): JsonChunkParser => {
      let buffer = ''
      let depth = 0
      let inString = false
      let escapeNext = false
      let capturing = false

      const reset = () => {
        buffer = ''
        depth = 0
        inString = false
        escapeNext = false
        capturing = false
      }

      const emitBuffer = () => {
        const payload = buffer
        reset()
        try {
          const parsed = JSON.parse(payload)
          onObject(parsed)
        } catch {
          // ignore malformed fragments; they will still be available via raw logs
        }
      }

      const pushChar = (char: string) => {
        if (!capturing) {
          if (char === '{') {
            capturing = true
            buffer = '{'
            depth = 1
          }
          return
        }
        buffer += char
        if (escapeNext) {
          escapeNext = false
          return
        }
        if (char === '\\') {
          escapeNext = true
          return
        }
        if (char === '"') {
          inString = !inString
          return
        }
        if (inString) return
        if (char === '{') {
          depth++
          return
        }
        if (char === '}') {
          depth--
          if (depth === 0) {
            emitBuffer()
          }
        }
      }

      return {
        push(chunk: string) {
          for (const char of chunk) {
            pushChar(char)
          }
        },
        flush() {
          const remainder = capturing ? buffer : ''
          reset()
          return remainder
        }
      }
    }

    const formatStreamPayload = (role: string, payload: unknown): string | null => {
      if (!payload || typeof payload !== 'object') return null
      if (role === 'worker') return formatWorkerMessage(payload as Partial<WorkerStructuredResponse>)
      if (role === 'verifier') return formatVerifierMessage(payload as Partial<VerifierStructuredResponse>)
      return null
    }

    const persistAgentMessage = async (role: string, round: number, content: string) => {
      const trimmed = content.trim()
      if (!trimmed.length) return
      const key = streamKey(role, round)
      if (persistedStreamKeys.has(key)) return
      persistedStreamKeys.add(key)
      try {
        const ok = await writeStructuredMessage({
          role,
          text: trimmed,
          providerId: MULTI_AGENT_PROVIDER_ID,
          modelId: options.model ?? null
        })
        if (!ok) {
          persistedStreamKeys.delete(key)
          await appendLogLine({ role, content: trimmed, round })
        }
      } catch (err) {
        persistedStreamKeys.delete(key)
        await appendLogLine({ role, content: trimmed, round })
        throw err
      }
    }

    const safePersistAgentMessage = (role: string, round: number, content: string) => {
      void persistAgentMessage(role, round, content).catch((err) => {
        console.warn('[coding-agent] Failed to persist agent message', {
          role,
          round,
          error: (err as any)?.message ?? String(err)
        })
      })
    }

    const ensureStreamEntry = (role: string, round: number): StreamEntry => {
      const key = streamKey(role, round)
      const existing = streamEntries.get(key)
      if (existing) return existing
      const parser = createJsonChunkParser((payload) => {
        const formatted = formatStreamPayload(role, payload)
        if (!formatted) return
        safePersistAgentMessage(role, round, formatted)
      })
      const entry: StreamEntry = { role, round, rawBuffer: '', parser }
      streamEntries.set(key, entry)
      return entry
    }

    const appendChunk = (event: { role: string; round: number; chunk: string }) => {
      const entry = ensureStreamEntry(event.role, event.round)
      entry.rawBuffer += event.chunk
      entry.parser.push(event.chunk)
    }

    const persistLoopResult = async (result: AgentLoopResult | null) => {
      if (!result) return
      const bootstrapText = formatVerifierMessage(result.bootstrap?.parsed ?? null)
      if (bootstrapText) {
        await persistAgentMessage('verifier', result.bootstrap.round ?? 0, bootstrapText)
      }
      for (const round of result.rounds ?? []) {
        const workerText = formatWorkerMessage(round.worker?.parsed ?? null)
        if (workerText) {
          await persistAgentMessage('worker', round.worker.round ?? 0, workerText)
        }
        const verifierText = formatVerifierMessage(round.verifier?.parsed ?? null)
        if (verifierText) {
          await persistAgentMessage('verifier', round.verifier.round ?? 0, verifierText)
        }
      }
    }

    const flushStreamEntries = async () => {
      for (const [key, entry] of streamEntries) {
        if (persistedStreamKeys.has(key)) continue
        const remainder = entry.parser.flush()
        const fallbackContent = (remainder || entry.rawBuffer).trim()
        if (!fallbackContent.length) continue
        await appendLogLine({ role: entry.role, content: fallbackContent, round: entry.round })
      }
      streamEntries.clear()
    }

    ;(async () => {
      let loopResult: AgentLoopResult | null = null
      // monitor opencode CLI invocations log and print its tail periodically to aid debugging
      let monitorRunning = true
      const invocationsLogPath = path.join(options.workspacePath, '.opencode', 'invocations.log')
      const monitor = async () => {
        while (monitorRunning) {
          try {
            const exists = await fs
              .stat(invocationsLogPath)
              .then(() => true)
              .catch(() => false)
            if (exists) {
              const raw = await fs.readFile(invocationsLogPath, 'utf8')
              const tail = raw.slice(-4000)
              console.log('[coding-agent] opencode invocations log tail:\n', tail)
            }
          } catch (err) {
            // ignore
          }
          await new Promise((r) => setTimeout(r, 2000))
        }
      }
      void monitor()
      try {
        loopResult = await runVerifierWorkerLoop({
          userInstructions: options.prompt,
          provider: (options.llmProviderId ?? 'opencode') as any,
          model: options.model,
          sessionDir: options.workspacePath,
          onStream: (evt) => {
            try {
              // log incoming stream chunks to aid debugging of what the provider emitted
              try {
                const preview = typeof evt.chunk === 'string' ? evt.chunk.slice(0, 200) : String(evt.chunk)
                console.log('[coding-agent] onStream chunk', { role: evt.role, round: evt.round, preview })
              } catch {}
              appendChunk({ role: evt.role, round: evt.round, chunk: evt.chunk })
            } catch (err) {
              console.warn('[coding-agent] Failed to write agent stream chunk', {
                error: (err as any)?.message ?? String(err)
              })
            }
          }
        })
      } catch (err) {
        logSessionsError('Agent loop failed', err, {
          workspacePath: options.workspacePath,
          personaId: options.personaId ?? MULTI_AGENT_PERSONA_ID
        })
      } finally {
        monitorRunning = false
        try {
          await persistLoopResult(loopResult)
        } catch (err) {
          logSessionsError('Failed to persist multi-agent loop result', err, {
            workspacePath: options.workspacePath,
            personaId: options.personaId ?? MULTI_AGENT_PERSONA_ID
          })
        }
        await flushStreamEntries()
      }
    })()

    return run
  }

  const titleizeModelSegment = (segment: string): string => {
    return segment
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => {
        const upper = part.toUpperCase()
        if (upper === 'GPT') return 'GPT'
        if (upper === 'LLM') return 'LLM'
        return part.charAt(0).toUpperCase() + part.slice(1)
      })
      .join(' ')
  }

  const formatCodingAgentModelLabel = (modelId: string): string => {
    if (!modelId) return 'Unknown model'
    const known = KNOWN_CODING_AGENT_MODEL_LABELS[modelId]
    if (known) return known
    const [providerSegment, nameSegment] = modelId.split('/', 2)
    if (!nameSegment) {
      return titleizeModelSegment(providerSegment)
    }
    return `${titleizeModelSegment(providerSegment)} · ${titleizeModelSegment(nameSegment)}`
  }

  const parseCodingAgentModelList = (raw: string | null | undefined): string[] => {
    if (!raw) return []
    const trimmed = raw.trim()
    if (!trimmed.length) return []
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return parsed
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter(Boolean)
      }
      if (Array.isArray((parsed as any).models)) {
        return ((parsed as any).models as unknown[])
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter(Boolean)
      }
    } catch {
      // fall back to newline parsing
    }
    return trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  }

  const ensureCodingAgentModelList = (models: string[]): string[] => {
    const seen = new Set<string>()
    const append = (value: string) => {
      const normalized = value.trim()
      if (!normalized.length || seen.has(normalized)) return
      seen.add(normalized)
    }
    models.filter((value) => typeof value === 'string').forEach(append)
    if (!seen.size) {
      FALLBACK_CODING_AGENT_MODEL_IDS.forEach(append)
    }
    if (!seen.has(DEFAULT_CODING_AGENT_MODEL)) {
      append(DEFAULT_CODING_AGENT_MODEL)
    }
    const ordered = Array.from(seen)
    const prioritized = ordered.filter((id) => id !== DEFAULT_CODING_AGENT_MODEL)
    return [DEFAULT_CODING_AGENT_MODEL, ...prioritized]
  }

  const listCodingAgentModelIds = async (): Promise<string[]> => {
    try {
      const result = await codingAgentCommandRunner(['models'])
      const stdout = result?.stdout ?? ''
      return ensureCodingAgentModelList(parseCodingAgentModelList(stdout))
    } catch (error) {
      console.warn('Failed to list coding agent models via coding agent CLI, falling back to defaults.', error)
      return ensureCodingAgentModelList([])
    }
  }

  const describeDefaultCodingAgentProvider = async (): Promise<CodingAgentProvider> => {
    const modelIds = await listCodingAgentModelIds()
    const defaultModelId = modelIds[0] ?? DEFAULT_CODING_AGENT_MODEL
    return {
      id: CODING_AGENT_PROVIDER_ID,
      label: 'Coding Agent CLI',
      defaultModelId,
      models: modelIds.map((id) => ({ id, label: formatCodingAgentModelLabel(id) }))
    }
  }

  const listCodingAgentProviders = async (): Promise<CodingAgentProvider[]> => {
    const adapters = listProviders()
    const descriptions: CodingAgentProvider[] = []
    for (const adapter of adapters) {
      if (adapter.id === CODING_AGENT_PROVIDER_ID) {
        descriptions.push(await describeDefaultCodingAgentProvider())
        continue
      }
      descriptions.push({ id: adapter.id, label: adapter.label, defaultModelId: '', models: [] })
    }
    return descriptions
  }

  const listCodingAgentProvidersHandler: RequestHandler = async (_req, res) => {
    try {
      const providers = await listCodingAgentProviders()
      const response: CodingAgentProviderListResponse = { providers }
      res.json(response)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list coding agent providers'
      res.status(500).json({ error: message })
    }
  }

  const listCodingAgentSessionsHandler: RequestHandler = async (req, res) => {
    try {
      const workspaceParam = req.query.workspacePath
      const workspacePath = typeof workspaceParam === 'string' ? workspaceParam : undefined
      const [sessionList, runList] = await Promise.all([
        codingAgentStorage.listSessions({ workspacePath }),
        codingAgentRunner.listRuns()
      ])
      type RunnerRun = (typeof runList)[number]
      const runIndex = new Map<string, RunnerRun>(runList.map((run) => [run.sessionId, run]))
      const payload: CodingAgentSessionSummary[] = sessionList.map((session) => {
        const run = runIndex.get(session.id)
        const providerId = run?.providerId ?? session.providerId ?? null
        const modelId = run?.model ?? session.modelId ?? null
        return { ...session, providerId, modelId }
      })
      const response: CodingAgentSessionListResponse = { sessions: payload }
      res.json(response)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list coding agent sessions'
      res.status(500).json({ error: message })
    }
  }

  const getCodingAgentSessionHandler: RequestHandler = async (req, res) => {
    const sessionId = req.params.sessionId
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' })
      return
    }
    try {
      const detail = (await codingAgentStorage.getSession(sessionId)) as CodingAgentSessionDetail | null
      if (!detail) {
        res.status(404).json({ error: 'Unknown session' })
        return
      }
      const normalizedMessages = dedupeSequentialMessages(detail.messages ?? [])
      console.log('[coding-agent] getCodingAgentSessionHandler', { sessionId, messages: normalizedMessages.length })
      const run = await codingAgentRunner.getRun(sessionId)
      const providerId = run?.providerId ?? detail.session.providerId ?? null
      const modelId = run?.model ?? detail.session.modelId ?? null
      res.json({
        ...detail,
        messages: normalizedMessages,
        session: {
          ...detail.session,
          providerId,
          modelId
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load coding agent session'
      res.status(500).json({ error: message })
    }
  }

  const listCodingAgentRunsHandler: RequestHandler = async (_req, res) => {
    try {
      const runs = await codingAgentRunner.listRuns()
      const payload: CodingAgentRunRecord[] = runs.map((run) => ({
        ...run,
        providerId: run.providerId ?? CODING_AGENT_PROVIDER_ID
      }))
      const response: CodingAgentRunListResponse = { runs: payload }
      res.json(response)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list coding agent runs'
      res.status(500).json({ error: message })
    }
  }

  const startCodingAgentSessionHandler: RequestHandler = async (req, res) => {
    const { workspacePath, prompt, title, model, providerId: rawProviderId } = req.body ?? {}
    const personaId =
      typeof req.body?.personaId === 'string' && req.body.personaId.trim() ? req.body.personaId.trim() : null
    const multiAgentMode = personaId === MULTI_AGENT_PERSONA_ID
    if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
      res.status(400).json({ error: 'workspacePath is required' })
      return
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'prompt is required' })
      return
    }
    const normalizedWorkspace = workspacePath.trim()
    const providerId =
      typeof rawProviderId === 'string' && rawProviderId.trim().length ? rawProviderId.trim() : CODING_AGENT_PROVIDER_ID
    // const adapter = getProviderAdapter(providerId)
    // if (!adapter) {
    //   res.status(400).json({ error: `Unsupported provider: ${providerId}` })
    //   return
    // }
    try {
      await ensureWorkspaceDirectory(normalizedWorkspace)
      if (personaId) {
        try {
          const persona = await readPersona(personaId)
          if (!persona) {
            res.status(400).json({ error: `Persona not found: ${personaId}` })
            return
          }
        } catch (err: any) {
          console.warn('[coding-agent] Failed to read persona file', { personaId, error: err?.message ?? String(err) })
          res.status(400).json({ error: `Failed to read persona: ${personaId}` })
          return
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Workspace path is unavailable'
      res.status(400).json({ error: message })
      return
    }
    try {
      // ensure provider config and apply persona merges (copy persona into session)
      await ensureProviderConfig(normalizedWorkspace, providerId, personaId)

      const resolvedModel = typeof model === 'string' && model.trim().length ? model.trim() : DEFAULT_CODING_AGENT_MODEL
      const trimmedPrompt = prompt.trim()
      const resolvedTitle = typeof title === 'string' ? title : null
      /** @todo use provider abstraction in the future */
      // if (adapter.validateModel) {
      //   const ok = await Promise.resolve(adapter.validateModel(resolvedModel))
      //   if (!ok) {
      //     res.status(400).json({ error: `Model not supported by provider: ${resolvedModel}` })
      //     return
      //   }
      // }
      logSessions('Starting coding agent run', {
        workspacePath: normalizedWorkspace,
        providerId,
        model: resolvedModel
      })

      // Branch: if persona is NOT multi-agent, start a normal provider-run via codingAgentRunner.
      if (!multiAgentMode) {
        try {
          const runRecord = await codingAgentRunner.startRun({
            workspacePath: normalizedWorkspace,
            prompt: trimmedPrompt,
            title: resolvedTitle,
            model: resolvedModel,
            providerId
          })
          res.status(202).json({ run: runRecord })
          return
        } catch (err) {
          logSessionsError('Failed to start provider run for persona', err, {
            workspacePath: normalizedWorkspace,
            personaId
          })
          const message = err instanceof Error ? err.message : 'Failed to start provider run'
          res.status(500).json({ error: message })
          return
        }
      }
      const runRecord = await startMultiAgentSession({
        workspacePath: normalizedWorkspace,
        prompt: trimmedPrompt,
        title: resolvedTitle,
        model: resolvedModel,
        // ensure multi-agent persona uses the opencode provider for LLM calls
        llmProviderId: multiAgentMode ? 'opencode' : (providerId ?? null),
        personaId
      })
      res.status(202).json({ run: runRecord })
    } catch (error) {
      logSessionsError('Failed to start coding agent session', error, {
        workspacePath: normalizedWorkspace,
        providerId
      })
      const message = error instanceof Error ? error.message : 'Failed to start coding agent session'
      res.status(500).json({ error: message })
    }
  }

  const killCodingAgentSessionHandler: RequestHandler = async (req, res) => {
    const sessionId = req.params.sessionId
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' })
      return
    }
    try {
      const success = await codingAgentRunner.killRun(sessionId)
      res.json({ success })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to terminate coding agent session'
      res.status(500).json({ error: message })
    }
  }

  const postCodingAgentMessageHandler: RequestHandler = async (req, res) => {
    const sessionId = req.params.sessionId
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' })
      return
    }
    const body = req.body ?? {}
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    const requestedModelId = typeof body.modelId === 'string' && body.modelId.trim().length ? body.modelId.trim() : null
    const role = typeof body.role === 'string' && body.role.trim().length ? body.role.trim() : 'user'
    if (!text.length) {
      res.status(400).json({ error: 'text is required' })
      return
    }
    try {
      const existing = (await codingAgentStorage.getSession(sessionId)) as CodingAgentSessionDetail | null
      if (!existing) {
        res.status(404).json({ error: 'Unknown session' })
        return
      }
      const run = await codingAgentRunner.getRun(sessionId)
      if (role !== 'user') {
        console.warn(`[coding-agent] Unsupported role "${role}" for session ${sessionId}; sending as user message.`)
      }
      try {
        await ensureWorkspaceDirectory(existing.session.workspacePath)
      } catch {
        res.status(400).json({ error: 'Session workspace is unavailable' })
        return
      }
      const providerFromMessages = existing.messages
        .slice()
        .reverse()
        .map((message) => (typeof message.providerId === 'string' ? message.providerId.trim() : ''))
        .find((candidate) => candidate.length)
      const resolvedProviderId =
        [existing.session.providerId, run?.providerId, providerFromMessages]
          .map((candidate) => (typeof candidate === 'string' ? candidate.trim() : ''))
          .find((candidate) => candidate.length)
          ?.trim() ?? CODING_AGENT_PROVIDER_ID
      const modelFromMessages = existing.messages
        .slice()
        .reverse()
        .map((message) => (typeof message.modelId === 'string' ? message.modelId.trim() : ''))
        .find((candidate) => candidate.length)
      const resolvedModelId =
        [requestedModelId, existing.session.modelId, run?.model, modelFromMessages]
          .map((candidate) => (typeof candidate === 'string' ? candidate.trim() : ''))
          .find((candidate) => candidate.length)
          ?.trim() ?? DEFAULT_CODING_AGENT_MODEL
      const adapter = getProviderAdapter(resolvedProviderId)
      if (!adapter) {
        res.status(400).json({ error: `Unsupported provider: ${resolvedProviderId}` })
        return
      }
      const invocation = adapter.buildInvocation
        ? adapter.buildInvocation({
            sessionId,
            modelId: resolvedModelId,
            text,
            workspacePath: existing.session.workspacePath,
            messages: existing.messages,
            session: existing
          })
        : null
      if (!invocation) {
        res.status(500).json({ error: `Provider ${resolvedProviderId} cannot build invocation` })
        return
      }
      logSessions('Posting coding agent message', {
        sessionId,
        providerId: resolvedProviderId,
        modelId: resolvedModelId,
        role
      })
      try {
        await runProviderInvocation(invocation, {
          cwd: existing.session.workspacePath,
          opencodeCommandRunner: codingAgentCommandRunner
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Provider invocation failed'
        logSessionsError('Provider invocation failed', err, {
          sessionId,
          providerId: resolvedProviderId,
          modelId: resolvedModelId
        })
        res.status(500).json({ error: message })
        return
      }
      const updated = (await codingAgentStorage.getSession(sessionId)) as CodingAgentSessionDetail | null
      const detail = updated ?? existing
      res.status(201).json({
        ...detail,
        session: {
          ...detail.session,
          providerId: resolvedProviderId,
          modelId: resolvedModelId
        }
      })
    } catch (error) {
      logSessionsError('Failed to post coding agent message', error, { sessionId })
      const message = error instanceof Error ? error.message : 'Failed to post coding agent message'
      res.status(500).json({ error: message })
    }
  }

  router.get('/api/coding-agent/providers', wrapAsync(listCodingAgentProvidersHandler))
  // Persona management (OpenCode agent markdown files in ~/.config/opencode/agent)
  const listPersonasHandler: RequestHandler = async (_req, res) => {
    try {
      const personas = await listPersonas()
      res.json({ personas })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list personas'
      res.status(500).json({ error: message })
    }
  }

  const getPersonaHandler: RequestHandler = async (req, res) => {
    const id = req.params.id
    if (!id) {
      res.status(400).json({ error: 'persona id is required' })
      return
    }
    try {
      const detail = await readPersona(id)
      if (!detail) {
        res.status(404).json({ error: 'Unknown persona' })
        return
      }
      res.json({ persona: detail })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read persona'
      res.status(500).json({ error: message })
    }
  }

  const createPersonaHandler: RequestHandler = async (req, res) => {
    const body = req.body ?? {}
    const markdown = typeof body.markdown === 'string' ? body.markdown : null
    const suggestedId = typeof body.id === 'string' ? body.id : undefined
    if (!markdown) {
      res.status(400).json({ error: 'markdown is required' })
      return
    }
    try {
      const { id, path } = await writePersona(suggestedId, markdown)
      res.status(201).json({ id, path })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create persona'
      res.status(500).json({ error: message })
    }
  }

  const updatePersonaHandler: RequestHandler = async (req, res) => {
    const id = req.params.id
    const body = req.body ?? {}
    const markdown = typeof body.markdown === 'string' ? body.markdown : null
    if (!id) {
      res.status(400).json({ error: 'persona id is required' })
      return
    }
    if (!markdown) {
      res.status(400).json({ error: 'markdown is required' })
      return
    }
    try {
      const result = await writePersona(id, markdown)
      res.json({ id: result.id, path: result.path })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update persona'
      res.status(500).json({ error: message })
    }
  }

  const deletePersonaHandler: RequestHandler = async (req, res) => {
    const id = req.params.id
    if (!id) {
      res.status(400).json({ error: 'persona id is required' })
      return
    }
    try {
      const ok = await deletePersona(id)
      res.json({ success: ok })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete persona'
      res.status(500).json({ error: message })
    }
  }

  router.get('/api/coding-agent/personas', wrapAsync(listPersonasHandler))
  router.get('/api/coding-agent/personas/:id', wrapAsync(getPersonaHandler))
  router.post('/api/coding-agent/personas', wrapAsync(createPersonaHandler))
  router.put('/api/coding-agent/personas/:id', wrapAsync(updatePersonaHandler))
  router.delete('/api/coding-agent/personas/:id', wrapAsync(deletePersonaHandler))
  router.get('/api/coding-agent/sessions', wrapAsync(listCodingAgentSessionsHandler))
  router.get('/api/coding-agent/sessions/:sessionId', wrapAsync(getCodingAgentSessionHandler))
  router.get('/api/coding-agent/runs', wrapAsync(listCodingAgentRunsHandler))
  router.post('/api/coding-agent/sessions', wrapAsync(startCodingAgentSessionHandler))
  router.post('/api/coding-agent/sessions/:sessionId/kill', wrapAsync(killCodingAgentSessionHandler))
  router.post('/api/coding-agent/sessions/:sessionId/messages', wrapAsync(postCodingAgentMessageHandler))

  return router
}
