import { Router, type RequestHandler } from 'express'
// filesystem logging and direct storage writes are handled in the agent module now
import fs from 'fs'
import path from 'path'
import type {
  CodingAgentRunListResponse,
  CodingAgentSessionDetail,
  CodingAgentSessionListResponse,
  CodingAgentSessionSummary,
  RunMeta
} from '../../../interfaces/core/codingAgent'
import { runVerifierWorkerLoop } from '../../../modules/agent/multi-agent'
import { runSingleAgentLoop } from '../../../modules/agent/single-agent'
import { hasRunMeta, loadRunMeta, metaDirectory, RunMeta as ProvRunMeta } from '../../../modules/provenance/provenance'
import { DEFAULT_CODING_AGENT_MODEL } from '../../core/config'
import { deletePersona, listPersonas, readPersona, writePersona } from './personas'

type WrapAsync = (handler: RequestHandler) => RequestHandler

const MULTI_AGENT_PERSONA_ID = 'multi-agent'

/**
 * Dependencies required to create the workspace sessions router.
 *
 * `wrapAsync` is an Express helper for async handlers.
 */
export type WorkspaceSessionsDeps = {
  wrapAsync: WrapAsync
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
  const { wrapAsync } = deps
  const router = Router()
  // No injected storage/command-runner: routes call agent/opencode functions directly.

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
   * Turn a model id segment into a human-friendly title fragment.
   *
   * Examples: `gpt-5-mini` -> `GPT 5 Mini`, `openai/gpt-4` -> `Openai · GPT 4`.
   */
  // model title helpers removed with providers concept

  /**
   * Create a display label for a coding agent model id.
   *
   * Falls back to a best-effort humanized label when the model isn't
   * in the known labels map.
   */
  // model label formatting removed with providers concept

  // Providers concept removed: routes no longer expose provider/model discovery.

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
      // Return runs discovered in the workspace's provenance metadata
      const payload: CodingAgentSessionSummary[] = []
      if (workspacePath) {
        try {
          const metaDir = metaDirectory(workspacePath)
          if (fs.existsSync(metaDir)) {
            const files = fs.readdirSync(metaDir).filter((f) => f.endsWith('.json'))
            for (const file of files) {
              try {
                const raw = fs.readFileSync(path.join(metaDir, file), 'utf-8')
                const parsed = JSON.parse(raw) as ProvRunMeta
                payload.push({
                  id: parsed.id,
                  title: `Run ${parsed.id}`,
                  workspacePath,
                  projectId: null as any,
                  createdAt: parsed.createdAt,
                  updatedAt: parsed.updatedAt,
                  summary: { additions: 0, deletions: 0, files: 0 }
                })
              } catch {
                // ignore malformed run files
              }
            }
          }
        } catch {
          // fall through and return empty list
        }
        // If no run metadata exists in the .hyperagent folder, also
        // inspect legacy opencode storage layout under `storage/session`.
        if (payload.length === 0) {
          try {
            const storageSessionDir = path.join(workspacePath, 'storage', 'session')
            if (fs.existsSync(storageSessionDir)) {
              const projects = fs.readdirSync(storageSessionDir)
              for (const proj of projects) {
                try {
                  const files = fs.readdirSync(path.join(storageSessionDir, proj)).filter((f) => f.endsWith('.json'))
                  for (const file of files) {
                    try {
                      const raw = fs.readFileSync(path.join(storageSessionDir, proj, file), 'utf-8')
                      const parsed = JSON.parse(raw) as any
                      payload.push({
                        id: parsed.id || path.basename(file, '.json'),
                        title: parsed.title || `Run ${parsed.id || path.basename(file, '.json')}`,
                        workspacePath: parsed.directory || workspacePath,
                        projectId: parsed.projectID || null,
                        createdAt: parsed.time?.created
                          ? new Date(parsed.time.created).toISOString()
                          : new Date().toISOString(),
                        updatedAt: parsed.time?.updated
                          ? new Date(parsed.time.updated).toISOString()
                          : new Date().toISOString(),
                        summary: parsed.summary || { additions: 0, deletions: 0, files: 0 }
                      })
                    } catch {
                      // ignore malformed session files
                    }
                  }
                } catch {
                  // ignore per-project errors
                }
              }
            }
          } catch {
            // ignore
          }
        }
      }
      // When no workspacePath is provided we return an empty list. The
      // router no longer supports injected storage enumerators.

      const response: CodingAgentSessionListResponse = { sessions: payload }
      res.json(response)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list coding agent sessions'
      res.status(500).json({ error: message })
    }
  }

  /**
   * HTTP handler: GET /api/coding-agent/sessions/:runId
   *
   * Loads session details (messages, session metadata) from the
   * codingAgentStorage and returns a deduplicated message stream.
   */
  const getCodingAgentSessionHandler: RequestHandler = async (req, res) => {
    const runId = req.params.runId
    if (!runId) {
      res.status(400).json({ error: 'runId is required' })
      return
    }
    let workspaceQuery = typeof req.query.workspacePath === 'string' ? req.query.workspacePath : undefined
    if (!workspaceQuery) throw new Error('workspacePath query parameter is required')

    const exists = hasRunMeta(runId, workspaceQuery)

    if (!exists) {
      res.status(404).json({ error: 'Unknown session' })
      return
    }

    const runs = loadRunMeta(runId, workspaceQuery)
    console.log('runs', runs)

    const detail: CodingAgentSessionDetail = {
      session: {
        id: runId,
        workspacePath: workspaceQuery,
        modelId: DEFAULT_CODING_AGENT_MODEL,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: null,
        projectId: null as any,
        summary: { additions: 0, deletions: 0, files: 0 }
      },
      messages: runs.log.map((entry) => ({
        id: entry.entryId,
        role: entry.role || 'agent',
        createdAt: entry.createdAt,
        completedAt: entry.createdAt,
        modelId: entry.model || DEFAULT_CODING_AGENT_MODEL,
        parts: entry.payload
      }))
    }

    console.log('[coding-agent] getCodingAgentSessionHandler', { runId, messages: detail.messages.length })
    res.json(detail)
  }

  /**
   * HTTP handler: GET /api/coding-agent/runs
   *
   * Returns a list of recent runs from the configured runner.
   */
  const listCodingAgentRunsHandler: RequestHandler = async (_req, res) => {
    try {
      // Discover run metadata files in an optional workspace query parameter
      const workspaceQuery =
        typeof _req.query.workspacePath === 'string' ? (_req.query.workspacePath as string) : undefined
      const runs: RunMeta[] = []
      if (workspaceQuery) {
        try {
          const metaDir = metaDirectory(workspaceQuery)
          if (fs.existsSync(metaDir)) {
            const files = fs.readdirSync(metaDir).filter((f) => f.endsWith('.json'))
            for (const file of files) {
              try {
                const raw = fs.readFileSync(path.join(metaDir, file), 'utf-8')
                const parsed = JSON.parse(raw) as ProvRunMeta
                runs.push({
                  id: parsed.id,
                  agents: parsed.agents ?? [],
                  log: parsed.log ?? [],
                  createdAt: parsed.createdAt,
                  updatedAt: parsed.updatedAt
                })
              } catch {
                // ignore malformed files
              }
            }
          }
        } catch {
          // ignore and return empty
        }
      }
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
    const { workspacePath, prompt, model } = req.body ?? {}
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

    try {
      /** @todo refactor */
      // ensure provider config and apply persona merges (copy persona into session)
      // await ensureProviderConfig(normalizedWorkspace, undefined, personaId)

      const resolvedModel = typeof model === 'string' && model.trim().length ? model.trim() : DEFAULT_CODING_AGENT_MODEL
      const trimmedPrompt = prompt.trim()

      logSessions('Starting coding agent run', { workspacePath: normalizedWorkspace, model: resolvedModel })

      if (!multiAgentMode) {
        const { runId } = await runSingleAgentLoop({
          userInstructions: trimmedPrompt,
          model: resolvedModel,
          sessionDir: normalizedWorkspace
        })
        const run = loadRunMeta(runId, normalizedWorkspace)
        res.status(202).json({ run })
        return
      }

      const { runId } = await runVerifierWorkerLoop({
        userInstructions: trimmedPrompt,
        model: resolvedModel,
        sessionDir: normalizedWorkspace
      })
      const run = loadRunMeta(runId, normalizedWorkspace)
      res.status(202).json({ run })
    } catch (error) {
      logSessionsError('Failed to start coding agent session', error, { workspacePath: normalizedWorkspace })
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
      // Kill semantics are provided by the agent runtime; this router no
      // longer exposes a programmatic kill command. Return 501 to indicate
      // the operation is not supported in this build.
      res.status(501).json({ error: 'Kill run not supported in this server build' })
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
      // Determine workspace (prefer explicit query)
      const workspaceQuery = typeof req.query.workspacePath === 'string' ? req.query.workspacePath : process.cwd()

      const resolvedModelId = requestedModelId ?? DEFAULT_CODING_AGENT_MODEL
      logSessions('Posting coding agent message (opencode prompt)', { sessionId, modelId: resolvedModelId, role })
      try {
        // Determine whether this session is a multi-agent run by checking
        // for an existing provenance RunMeta file. If present we dispatch
        // to the verifier/worker loop; otherwise we use the single-agent
        // loop. Both loops handle creating sessions and persisting run
        // metadata when necessary.
        const metaDir = metaDirectory(workspaceQuery)
        let isMultiAgent = false
        try {
          const filePath = path.join(metaDir, `${sessionId}.json`)
          if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf-8')
            const parsed = JSON.parse(raw) as ProvRunMeta
            const roles = Array.isArray(parsed.agents) ? parsed.agents.map((a) => a.role) : []
            // If the run has both worker/verifier or multiple agents,
            // treat it as a multi-agent run.
            if (roles.includes('worker') || roles.includes('verifier') || roles.length > 1) {
              isMultiAgent = true
            }
          }
        } catch {
          // If run meta parsing fails, fall back to single-agent behavior
          isMultiAgent = false
        }

        // Kick off the appropriate agent loop in the background so the
        // HTTP response can return quickly while the agent processes the
        // prompt. The loops will persist provenance themselves.
        if (isMultiAgent) {
          ;(async () => {
            try {
              await runVerifierWorkerLoop({
                runID: sessionId,
                userInstructions: text,
                model: resolvedModelId,
                sessionDir: workspaceQuery
              })
            } catch (err) {
              logSessionsError('Multi-agent prompt failed', err, { sessionId, modelId: resolvedModelId })
            }
          })()
        } else {
          ;(async () => {
            try {
              await runSingleAgentLoop({
                runID: sessionId,
                userInstructions: text,
                model: resolvedModelId,
                sessionDir: workspaceQuery
              })
            } catch (err) {
              logSessionsError('Single-agent prompt failed', err, { sessionId, modelId: resolvedModelId })
            }
          })()
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Provider invocation failed'
        logSessionsError('Opencode prompt failed', err, { sessionId, modelId: resolvedModelId })
        res.status(500).json({ error: message })
        return
      }

      // Return a minimal updated session detail to the caller
      res.status(201).json({
        session: {
          id: sessionId,
          workspacePath: workspaceQuery,
          modelId: resolvedModelId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        messages: []
      })
    } catch (error) {
      logSessionsError('Failed to post coding agent message', error, { sessionId })
      const message = error instanceof Error ? error.message : 'Failed to post coding agent message'
      res.status(500).json({ error: message })
    }
  }

  // provider listing removed
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
  router.get('/api/coding-agent/sessions/:runId', wrapAsync(getCodingAgentSessionHandler))
  router.get('/api/coding-agent/runs', wrapAsync(listCodingAgentRunsHandler))
  router.post('/api/coding-agent/sessions', wrapAsync(startCodingAgentSessionHandler))
  router.post('/api/coding-agent/sessions/:runId/kill', wrapAsync(killCodingAgentSessionHandler))
  router.post('/api/coding-agent/sessions/:runId/messages', wrapAsync(postCodingAgentMessageHandler))

  return router
}
