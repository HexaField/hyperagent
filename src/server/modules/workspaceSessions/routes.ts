import { Router, type RequestHandler } from 'express'
import type { CodingAgentCommandRunner } from '../../../../src/modules/opencodeCommandRunner'
import type { CodingAgentRunner, CodingAgentStorage } from '../../../../src/modules/provider'
import { runProviderInvocation } from '../../../../src/modules/providerRunner'
import { getProviderAdapter, listProviders } from '../../../../src/modules/providers'
import type {
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
import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'

import { listPersonas, readPersona, writePersona, deletePersona } from './personas'
import { ensureProviderConfig } from '../../../../src/modules/workflowAgentExecutor'
import { runVerifierWorkerLoop } from '../../../../src/modules/agent'

type WrapAsync = (handler: RequestHandler) => RequestHandler

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
      const run = await codingAgentRunner.getRun(sessionId)
      const providerId = run?.providerId ?? detail.session.providerId ?? null
      const modelId = run?.model ?? detail.session.modelId ?? null
      res.json({
        ...detail,
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
    const personaId = typeof req.body?.personaId === 'string' && req.body.personaId.trim() ? req.body.personaId.trim() : null
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
    const adapter = getProviderAdapter(providerId)
    if (!adapter) {
      res.status(400).json({ error: `Unsupported provider: ${providerId}` })
      return
    }
    try {
      await ensureWorkspaceDirectory(normalizedWorkspace)
      // If a persona is requested, validate that it exists in the user's
      // OpenCode config directory and then let `ensureProviderConfig` handle
      // copying and merging persona frontmatter into `opencode.json`.
      if (personaId) {
        try {
          const agentDir = process.env.OPENCODE_AGENT_DIR ?? path.join(process.env.HOME || process.env.USERPROFILE || '', '.config', 'opencode', 'agent')
          const personaPath = path.join(agentDir, `${personaId}.md`)
          await fs.access(personaPath)
        } catch (err: any) {
          if (err?.code === 'ENOENT') {
            res.status(400).json({ error: `Persona not found: ${personaId}` })
            return
          }
          console.warn('[coding-agent] Failed to access persona file', { personaId, error: err?.message ?? String(err) })
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Workspace path is unavailable'
      res.status(400).json({ error: message })
      return
    }
      try {
        // ensure provider config and apply persona merges if requested
        await ensureProviderConfig(normalizedWorkspace, providerId, personaId)

      const resolvedModel = typeof model === 'string' && model.trim().length ? model.trim() : DEFAULT_CODING_AGENT_MODEL
      if (adapter.validateModel) {
        const ok = await Promise.resolve(adapter.validateModel(resolvedModel))
        if (!ok) {
          res.status(400).json({ error: `Model not supported by provider: ${resolvedModel}` })
          return
        }
      }
      logSessions('Starting coding agent run', {
        workspacePath: normalizedWorkspace,
        providerId,
        model: resolvedModel
      })
      const run = await codingAgentRunner.startRun({
        workspacePath: normalizedWorkspace,
        prompt: prompt.trim(),
        title: typeof title === 'string' ? title : undefined,
        model: resolvedModel,
        providerId
      })
      logSessions('Coding agent run started', { workspacePath: normalizedWorkspace, sessionId: run.sessionId })
      // If a persona was requested and it's configured to run in agent mode,
      // kick off the verifier/worker loop in the background. This is intentionally
      // non-blocking: we do not await the agent loop here so the API can return
      // the run record immediately. Errors are logged.
      if (personaId) {
        try {
          const persona = await readPersona(personaId)
          const mode = persona?.frontmatter?.['mode']
          if (typeof mode === 'string' && mode.toLowerCase() === 'agent') {
            ;(async () => {
              try {
                const streamsDir = path.join(normalizedWorkspace, '.opencode', 'agent-streams')
                await fs.mkdir(streamsDir, { recursive: true })
                const logPath = path.join(streamsDir, `${run.sessionId}.log`)
                const appendChunk = async (event: { role: string; round: number; chunk: string }) => {
                  const time = new Date().toISOString()
                  // Try to persist into opencode storage message/part files so the UI
                  // can display agent turns like normal messages. Fall back to a
                  // simple file log if storage root is unavailable.
                  try {
                    const storageRoot = (codingAgentStorage as any)?.rootDir
                    if (storageRoot) {
                      const storageDir = path.join(storageRoot, 'storage')
                      const messageDir = path.join(storageDir, 'message', run.sessionId)
                      const partRoot = path.join(storageDir, 'part')
                      await fs.mkdir(messageDir, { recursive: true })
                      await fs.mkdir(partRoot, { recursive: true })
                      const messageId = crypto.randomUUID()
                      const partId = crypto.randomUUID()
                      const now = new Date().toISOString()
                      const messageJson = {
                        id: messageId,
                        sessionID: run.sessionId,
                        role: event.role,
                        time: { created: now, completed: now },
                        modelID: resolvedModel ?? null,
                        providerID: providerId ?? null
                      }
                      await fs.writeFile(path.join(messageDir, `${messageId}.json`), JSON.stringify(messageJson, null, 2), 'utf8')
                      const partDirPath = path.join(partRoot, messageId)
                      await fs.mkdir(partDirPath, { recursive: true })
                      const partJson = {
                        id: partId,
                        type: 'text',
                        text: event.chunk,
                        time: { start: Date.now(), end: Date.now() }
                      }
                      await fs.writeFile(path.join(partDirPath, `${partId}.json`), JSON.stringify(partJson, null, 2), 'utf8')
                      return
                    }
                  } catch (err) {
                    console.warn('[coding-agent] Failed to write agent message to storage', { error: (err as any)?.message ?? String(err) })
                  }
                  const line = `[${time}] [${event.role}] [round:${event.round}] ${event.chunk}\n`
                  await fs.appendFile(logPath, line, 'utf8')
                }

                await runVerifierWorkerLoop({
                  userInstructions: prompt.trim(),
                  model: resolvedModel,
                  sessionDir: normalizedWorkspace,
                  onStream: (evt) => {
                    try {
                      // schedule append (don't await here)
                      void appendChunk({ role: evt.role, round: evt.round, chunk: evt.chunk })
                    } catch (err) {
                      console.warn('[coding-agent] Failed to write agent stream chunk', { error: (err as any)?.message ?? String(err) })
                    }
                  }
                })
              } catch (err) {
                logSessionsError('Agent loop failed', err, { workspacePath: normalizedWorkspace, personaId })
              }
            })()
          }
        } catch (err) {
          // If persona cannot be read, don't block session start — just log.
          console.warn('[coding-agent] Failed to read persona for agent run', { personaId, error: (err as any)?.message ?? String(err) })
        }
      }
      res.status(202).json({ run })
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
