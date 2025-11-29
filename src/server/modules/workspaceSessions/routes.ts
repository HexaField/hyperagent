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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Workspace path is unavailable'
      res.status(400).json({ error: message })
      return
    }
    try {
      const resolvedModel = typeof model === 'string' && model.trim().length ? model.trim() : DEFAULT_CODING_AGENT_MODEL
      if (adapter.validateModel) {
        const ok = await Promise.resolve(adapter.validateModel(resolvedModel))
        if (!ok) {
          res.status(400).json({ error: `Model not supported by provider: ${resolvedModel}` })
          return
        }
      }
      const run = await codingAgentRunner.startRun({
        workspacePath: normalizedWorkspace,
        prompt: prompt.trim(),
        title: typeof title === 'string' ? title : undefined,
        model: resolvedModel,
        providerId
      })
      res.status(202).json({ run })
    } catch (error) {
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
      try {
        await runProviderInvocation(invocation, {
          cwd: existing.session.workspacePath,
          opencodeCommandRunner: codingAgentCommandRunner
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Provider invocation failed'
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
      const message = error instanceof Error ? error.message : 'Failed to post coding agent message'
      res.status(500).json({ error: message })
    }
  }

  router.get('/api/coding-agent/providers', wrapAsync(listCodingAgentProvidersHandler))
  router.get('/api/coding-agent/sessions', wrapAsync(listCodingAgentSessionsHandler))
  router.get('/api/coding-agent/sessions/:sessionId', wrapAsync(getCodingAgentSessionHandler))
  router.get('/api/coding-agent/runs', wrapAsync(listCodingAgentRunsHandler))
  router.post('/api/coding-agent/sessions', wrapAsync(startCodingAgentSessionHandler))
  router.post('/api/coding-agent/sessions/:sessionId/kill', wrapAsync(killCodingAgentSessionHandler))
  router.post('/api/coding-agent/sessions/:sessionId/messages', wrapAsync(postCodingAgentMessageHandler))

  return router
}
