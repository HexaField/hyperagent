import crypto from 'crypto'
import { Router, type RequestHandler } from 'express'
import fs from 'fs/promises'
import path from 'path'
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
  createOpencodeStorage,
  createSession,
  extractResponseText,
  promptSession
} from '../../../modules/agent/opencode'
import {
  CODING_AGENT_PROVIDER_ID,
  DEFAULT_CODING_AGENT_MODEL,
  KNOWN_CODING_AGENT_MODEL_LABELS
} from '../../core/config'

import { ensureProviderConfig } from '../../../../src/modules/workflowAgentExecutor'
import { runVerifierWorkerLoop } from '../../../modules/agent/multi-agent'
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
  ensureWorkspaceDirectory: (dirPath: string) => Promise<void>
}

export const createWorkspaceSessionsRouter = (deps: WorkspaceSessionsDeps) => {
  const { wrapAsync, ensureWorkspaceDirectory } = deps
  const router = Router()
  const codingAgentStorage = createOpencodeStorage({ rootDir: process.env.OPENCODE_STORAGE_ROOT })

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
    const run: CodingAgentRunRecord = {
      sessionId,
      pid: -1,
      workspacePath: options.workspacePath,
      prompt: options.prompt,
      title: options.title,
      model: options.model,
      providerId: MULTI_AGENT_PROVIDER_ID,
      logFile: '',
      startedAt,
      updatedAt: startedAt,
      status: 'running',
      exitCode: null,
      signal: null
    }

    logSessions('Coding agent run started (multi-agent persona)', {
      workspacePath: options.workspacePath,
      sessionId: run.sessionId
    })

    // simple log file for streaming output
    try {
      const logDir = path.join(options.workspacePath, '.opencode', 'agent-streams')
      await fs.mkdir(logDir, { recursive: true })
      const logPath = path.join(logDir, `${run.sessionId}.log`)

      const appendLogLine = async (entry: { role: string; content: string; round?: number }) => {
        const time = new Date().toISOString()
        const roundSegment = typeof entry.round === 'number' ? `[round:${entry.round}] ` : ''
        const line = `[${time}] [${entry.role}] ${roundSegment}${entry.content}\n`
        await fs.appendFile(logPath, line, 'utf8')
      }

      // write initial user prompt to the log
      if (options.prompt && options.prompt.trim()) {
        await appendLogLine({ role: 'user', content: options.prompt.trim() })
      }

      // run the agent loop in background; stream events are appended to the log
      ;(async () => {
        try {
          // persist structured messages into codingAgentStorage if available
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
              return true
            } catch (err) {
              console.warn('[coding-agent] Failed to write agent message to storage', {
                error: (err as any)?.message ?? String(err)
              })
              return false
            }
          }

          const formatWorkerMessage = (payload: any): string | null => {
            if (!payload) return null
            const sections: string[] = []
            if (payload.status) sections.push(`Status: ${payload.status}`)
            if (payload.plan) sections.push(`Plan:\n${payload.plan}`)
            if (payload.work) sections.push(`Work:\n${payload.work}`)
            if (payload.requests) sections.push(`Requests:\n${payload.requests}`)
            if (!sections.length) return null
            return sections.join('\n\n').trim()
          }

          const formatVerifierMessage = (payload: any): string | null => {
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

          const result = await runVerifierWorkerLoop({
            userInstructions: options.prompt,
            model: options.model,
            sessionDir: options.workspacePath,
            onStream: async (evt) => {
              try {
                // prefer structured parts if present
                let formatted: string | null = null
                if (Array.isArray((evt as any).parts) && (evt as any).parts.length) {
                  formatted = (evt as any).parts.map((p: any) => p.text ?? String(p)).join('\n')
                } else if (typeof (evt as any).chunk === 'string') {
                  // chunk may be JSON string
                  try {
                    const parsed = JSON.parse((evt as any).chunk)
                    if (evt.role === 'worker') formatted = formatWorkerMessage(parsed)
                    else if (evt.role === 'verifier') formatted = formatVerifierMessage(parsed)
                  } catch {
                    formatted = String((evt as any).chunk)
                  }
                }
                if (formatted && storagePaths) {
                  await writeStructuredMessage({
                    role: evt.role,
                    text: formatted,
                    providerId: MULTI_AGENT_PROVIDER_ID,
                    modelId: options.model ?? null
                  })
                }
                // always append raw to the simple log as well
                const content =
                  formatted ??
                  (Array.isArray((evt as any).parts)
                    ? (evt as any).parts.map((p: any) => p.text ?? '').join('\n')
                    : String((evt as any).chunk ?? ''))
                await appendLogLine({ role: evt.role, content, round: evt.round })
              } catch (err) {
                console.warn('[coding-agent] failed to append stream chunk', err)
              }
            }
          })

          await appendLogLine({ role: 'system', content: `Agent finished: ${result.outcome}` })
        } catch (err) {
          logSessionsError('Agent loop failed', err, {
            workspacePath: options.workspacePath,
            personaId: options.personaId ?? MULTI_AGENT_PERSONA_ID
          })
          try {
            await fs.appendFile(
              path.join(options.workspacePath, '.opencode', 'agent-streams', `${run.sessionId}.log`),
              `Agent loop failed: ${String(err)}\n`,
              'utf8'
            )
          } catch {}
        }
      })()
    } catch (err) {
      console.warn('[coding-agent] failed to start multi-agent session logging', err)
    }

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
      const runIndex = new Map<string, RunnerRun>(runList.map((run: any) => [run.sessionId, run]))
      const payload: CodingAgentSessionSummary[] = sessionList.map((session: any) => {
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
      const payload: CodingAgentRunRecord[] = runs.map((run: any) => ({
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
        const response = await promptSession(opSession, [text], resolvedModelId)
        try {
          const out = extractResponseText((response as any).parts ?? (response as any))
          const logDir = path.join(existing.session.workspacePath, '.opencode', 'agent-streams')
          await fs.mkdir(logDir, { recursive: true })
          const logPath = path.join(logDir, `${sessionId}.log`)
          const line = `[${new Date().toISOString()}] [provider] ${out}\n`
          await fs.appendFile(logPath, line, 'utf8')
        } catch {
          // best-effort logging, ignore
        }
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
