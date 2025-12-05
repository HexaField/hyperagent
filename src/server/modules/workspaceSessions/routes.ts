import crypto from 'crypto'
import { Router, type RequestHandler } from 'express'
// filesystem logging and direct storage writes are handled in the agent module now
import type {
  CodingAgentMessage,
  CodingAgentProvider,
  CodingAgentProviderListResponse,
  CodingAgentRunListResponse,
  CodingAgentSessionDetail,
  CodingAgentSessionListResponse,
  CodingAgentSessionSummary,
  RunMeta
} from '../../../interfaces/core/codingAgent'
import { createSession, promptSession } from '../../../modules/agent/opencode'
import {
  CODING_AGENT_PROVIDER_ID,
  DEFAULT_CODING_AGENT_MODEL,
  KNOWN_CODING_AGENT_MODEL_LABELS
} from '../../core/config'

import { ensureProviderConfig } from '../../../../src/modules/workflowAgentExecutor'
import { runVerifierWorkerLoop } from '../../../modules/agent/multi-agent'
import { runSingleAgentLoop } from '../../../modules/agent/single-agent'
import { deletePersona, listPersonas, readPersona, writePersona } from './personas'

const MULTI_AGENT_PERSONA_ID = 'multi-agent'
const MULTI_AGENT_PROVIDER_ID = 'multi-agent'

type WrapAsync = (handler: RequestHandler) => RequestHandler

/**
 * Deduplicate consecutive messages that are semantically identical.
 *
 * This helper compares adjacent messages using a stable signature and
 * removes exact repeats that occur sequentially. It is used when
 * returning session detail responses to avoid noisy duplicate stream
 * chunks in the UI.
 *
 * @param messages - Array of persisted `CodingAgentMessage` objects
 * @returns A filtered array with consecutive duplicates removed
 */
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

/**
 * Build a stable signature string for a message.
 *
 * The signature consolidates the important fields (role, text, timestamps,
 * model/provider and simplified parts) into a JSON string for cheap
 * equality checks when deduplicating.
 *
 * @param message - Message to build a signature for
 * @returns A string signature suitable for equality comparisons
 */
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

/**
 * Simplify message parts for inclusion in a signature.
 *
 * Strips implementation-specific fields (ids, session references) and
 * returns a lightweight array suitable for JSON encoding in the
 * `buildMessageSignature` helper.
 *
 * @param parts - The parts array from a `CodingAgentMessage`
 * @returns A simplified array of part objects / primitives
 */
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

/**
 * Dependencies required to create the workspace sessions router.
 *
 * `wrapAsync` is an Express helper for async handlers. `ensureWorkspaceDirectory`
 * ensures session workspaces exist. `codingAgentStorage` and `codingAgentRunner`
 * are optional injected implementations used for persistence and running
 * agents; when absent the router provides in-process fallbacks.
 */
export type WorkspaceSessionsDeps = {
  wrapAsync: WrapAsync
  ensureWorkspaceDirectory: (dirPath: string) => Promise<void>
  // optional injected storage/runner for testability or alternate implementations
  codingAgentStorage?: any
  codingAgentRunner?: {
    listRuns: () => Promise<RunMeta[]>
    getRun: (sessionId: string) => Promise<RunMeta | null>
    startRun: (opts: {
      workspacePath: string
      prompt: string
      title?: string | null
      model?: string
      providerId?: string | null
      personaId?: string | null
    }) => Promise<RunMeta | Record<string, any>>
    killRun: (sessionId: string) => Promise<boolean>
  }
}

/**
 * Create and return the workspace sessions router.
 *
 * This router exposes endpoints under `/api/coding-agent/*` for listing
 * sessions, starting runs, posting messages, and managing personas. The
 * router delegates provenance and stream logging to the agent module; it
 * only orchestrates calls and returns persisted session/run metadata.
 *
 * @param deps - Dependency injection object (storage, runner, helpers)
 * @returns An Express `Router` instance with the coding-agent routes mounted
 */
export const createWorkspaceSessionsRouter = (deps: WorkspaceSessionsDeps) => {
  const { wrapAsync, ensureWorkspaceDirectory } = deps
  const router = Router()
  const codingAgentStorage =
    (deps as any).codingAgentStorage ??
    ({ rootDir: process.env.OPENCODE_STORAGE_ROOT, listSessions: async () => [], getSession: async () => null } as any)

  // provide a simple in-process default runner when none is injected. This runner
  // starts either the single-agent or verifier-worker loop in the background and
  // keeps minimal run tracking in-memory so the frontend can query runs.
  const defaultRuns = new Map<string, RunMeta>()
  /**
   * Minimal in-process runner used when an external/injected runner is
   * not provided. It launches the appropriate agent loop (single or
   * verifier/worker) and maintains a tiny in-memory `RunMeta` index
   * so the frontend can query recent runs. Provenance and durable
   * logging remain the responsibility of the agent module.
   */
  const defaultRunner = {
    listRuns: async () => Array.from(defaultRuns.values()),
    getRun: async (sessionId: string) => defaultRuns.get(sessionId) ?? null,
    startRun: async (opts: any) => {
      const sessionId = `ses_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
      const startedAt = new Date().toISOString()
      const run: RunMeta = { id: sessionId, agents: [], log: [], createdAt: startedAt, updatedAt: startedAt }
      defaultRuns.set(sessionId, run)
      // run the appropriate agent loop in background; provenance/logging
      // responsibilities are handled by the agent module itself, so the
      // default runner only invokes the loop and keeps minimal in-memory
      // metadata for listing.
      ;(async () => {
        try {
          if (opts.personaId === MULTI_AGENT_PERSONA_ID) {
            await runVerifierWorkerLoop({
              userInstructions: opts.prompt,
              model: opts.model,
              sessionDir: opts.workspacePath,
              runID: sessionId,
              onStream: opts.onStream
            })
          } else {
            await runSingleAgentLoop({
              runID: sessionId,
              userInstructions: opts.prompt,
              model: opts.model,
              sessionDir: opts.workspacePath,
              onStream: opts.onStream
            })
          }
        } catch {
          const updated = defaultRuns.get(sessionId)
          if (updated) {
            updated.updatedAt = new Date().toISOString()
            defaultRuns.set(sessionId, updated)
          }
        }
      })()
      return run
    },
    killRun: async (sessionId: string) => {
      const existing = defaultRuns.get(sessionId)
      if (!existing) return false
      existing.updatedAt = new Date().toISOString()
      defaultRuns.set(sessionId, existing)
      return true
    }
  }

  const codingAgentRunner = (deps as any).codingAgentRunner ?? defaultRunner

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

  /**
   * Start a multi-agent session by delegating to the configured runner.
   *
   * Historically this function created log files and wrote structured
   * messages. That behavior has been moved into the agent module; this
   * helper now simply calls `codingAgentRunner.startRun`.
   *
   * @param options.workspacePath - Workspace directory for the session
   * @param options.prompt - Initial user prompt
   * @param options.title - Optional title for the run
   * @param options.model - Model id to use for LLM calls
   * @param options.llmProviderId - Provider id for LLM calls
   * @param options.personaId - Persona id to use
   * @returns A `RunMeta` representing the started run
   */
  const startMultiAgentSession = async (options: {
    workspacePath: string
    prompt: string
    title: string | null
    model: string
    llmProviderId: string | null
    personaId: string | null
  }): Promise<RunMeta> => {
    if (typeof codingAgentRunner.startRun !== 'function') {
      throw new Error('Provider run not supported in this server build')
    }
    const run = await codingAgentRunner.startRun({
      workspacePath: options.workspacePath,
      prompt: options.prompt,
      title: options.title,
      model: options.model,
      providerId: options.llmProviderId ?? MULTI_AGENT_PROVIDER_ID,
      personaId: options.personaId ?? MULTI_AGENT_PERSONA_ID
    } as any)
    return run
  }

  /**
   * Turn a model id segment into a human-friendly title fragment.
   *
   * Examples: `gpt-5-mini` -> `GPT 5 Mini`, `openai/gpt-4` -> `Openai · GPT 4`.
   */
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

  /**
   * Create a display label for a coding agent model id.
   *
   * Falls back to a best-effort humanized label when the model isn't
   * in the known labels map.
   */
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

  /**
   * List available coding agent providers.
   *
   * The router currently exposes a simplified list with a single built-in
   * provider backed by the Opencode runtime.
   *
   * @returns An array of provider descriptions suitable for client display
   */
  const listCodingAgentProviders = async (): Promise<CodingAgentProvider[]> => {
    // Simplified provider listing: advertise only the built-in opencode provider
    return [
      {
        id: CODING_AGENT_PROVIDER_ID,
        label: 'Opencode',
        defaultModelId: DEFAULT_CODING_AGENT_MODEL,
        models: [{ id: DEFAULT_CODING_AGENT_MODEL, label: formatCodingAgentModelLabel(DEFAULT_CODING_AGENT_MODEL) }]
      }
    ]
  }

  /**
   * HTTP handler: GET /api/coding-agent/providers
   *
   * Returns a compact list of available LLM providers and models.
   */
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

  /**
   * HTTP handler: GET /api/coding-agent/sessions
   *
   * Returns a list of known workspace sessions. Accepts optional
   * `workspacePath` query parameter to scope results.
   */
  const listCodingAgentSessionsHandler: RequestHandler = async (req, res) => {
    try {
      const workspaceParam = req.query.workspacePath
      const workspacePath = typeof workspaceParam === 'string' ? workspaceParam : undefined
      const sessionList = await codingAgentStorage.listSessions({ workspacePath })
      const payload: CodingAgentSessionSummary[] = sessionList.map((session: any) => ({ ...session }))
      const response: CodingAgentSessionListResponse = { sessions: payload }
      res.json(response)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list coding agent sessions'
      res.status(500).json({ error: message })
    }
  }

  /**
   * HTTP handler: GET /api/coding-agent/sessions/:sessionId
   *
   * Loads session details (messages, session metadata) from the
   * codingAgentStorage and returns a deduplicated message stream.
   */
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
      // Run meta does not include provider/model; prefer stored session values
      await codingAgentRunner.getRun(sessionId).catch(() => null)
      const providerId = detail.session.providerId ?? null
      const modelId = detail.session.modelId ?? null
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

  /**
   * HTTP handler: GET /api/coding-agent/runs
   *
   * Returns a list of recent runs from the configured runner.
   */
  const listCodingAgentRunsHandler: RequestHandler = async (_req, res) => {
    try {
      const runs = await codingAgentRunner.listRuns()
      const response: CodingAgentRunListResponse = { runs }
      res.json(response)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list coding agent runs'
      res.status(500).json({ error: message })
    }
  }

  /**
   * HTTP handler: POST /api/coding-agent/sessions
   *
   * Starts a new coding agent run. If the provided `personaId` indicates
   * a multi-agent persona this will delegate to the multi-agent runner;
   * otherwise it will start a single-provider run. The endpoint validates
   * workspace and persona inputs and enforces basic request shape.
   */
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
        if (typeof codingAgentRunner.startRun !== 'function') {
          res.status(501).json({ error: 'Provider run not supported in this server build' })
          return
        }
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

  /**
   * HTTP handler: POST /api/coding-agent/sessions/:sessionId/kill
   *
   * Requests that the running agent be terminated. The router delegates
   * the kill operation to the configured `codingAgentRunner` implementation.
   */
  const killCodingAgentSessionHandler: RequestHandler = async (req, res) => {
    const sessionId = req.params.sessionId
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' })
      return
    }
    try {
      if (typeof codingAgentRunner.killRun !== 'function') {
        res.status(501).json({ error: 'Kill run not supported in this server build' })
        return
      }
      const success = await codingAgentRunner.killRun(sessionId)
      res.json({ success })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to terminate coding agent session'
      res.status(500).json({ error: message })
    }
  }

  /**
   * HTTP handler: POST /api/coding-agent/sessions/:sessionId/messages
   *
   * Posts a one-off message to an existing session using the Opencode
   * runtime. This is typically used for ad-hoc prompts back into the
   * session and does not attempt to manage provenance itself (the
   * agent/opencode layer records messages and run metadata).
   */
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
      logSessions('Posting coding agent message (opencode prompt)', {
        sessionId,
        providerId: resolvedProviderId,
        modelId: resolvedModelId,
        role
      })
      try {
        // Use opencode directly to prompt the workspace session
        const opSession = await createSession(existing.session.workspacePath)
        await promptSession(opSession, [text], resolvedModelId)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Provider invocation failed'
        logSessionsError('Opencode prompt failed', err, {
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
