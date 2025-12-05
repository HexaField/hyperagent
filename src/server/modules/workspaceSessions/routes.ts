import crypto from 'crypto'
import { Router, type RequestHandler } from 'express'
// filesystem logging and direct storage writes are handled in the agent module now
import fs from 'fs'
import path from 'path'
import { ensureProviderConfig } from '../../../../src/modules/workflowAgentExecutor'
import type {
  CodingAgentMessage,
  CodingAgentRunListResponse,
  CodingAgentSessionDetail,
  CodingAgentSessionListResponse,
  CodingAgentSessionSummary,
  RunMeta
} from '../../../interfaces/core/codingAgent'
import { runVerifierWorkerLoop } from '../../../modules/agent/multi-agent'
import { getSession as getOpencodeSession } from '../../../modules/agent/opencode'
import { runSingleAgentLoop } from '../../../modules/agent/single-agent'
import { metaDirectory, RunMeta as ProvRunMeta } from '../../../modules/provenance/provenance'
import { DEFAULT_CODING_AGENT_MODEL } from '../../core/config'
import { deletePersona, listPersonas, readPersona, writePersona } from './personas'
type WrapAsync = (handler: RequestHandler) => RequestHandler
const MULTI_AGENT_PERSONA_ID = 'multi-agent'
/**
 * Deduplicate consecutive messages that are semantically identical.
 *
 * This helper compares adjacent messages using a stable signature and
 * removes exact repeats that occur sequentially. It is used when
 * returning session detail responses to avoid noisy duplicate stream
 * chunks in the UI.
 *
 * @param messages - Array of persisted CodingAgentMessage objects
 * @returns A filtered array with consecutive duplicates removed
 */

export const dedupeSequentialMessages = (messages: CodingAgentMessage[]): CodingAgentMessage[] => {
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
      // Determine workspace: prefer explicit query, otherwise we'll try
      // to discover a persisted RunMeta file for the session across the
      // repository (supports tests which write meta files without passing
      // the workspace path on the request).
      let workspaceQuery = typeof req.query.workspacePath === 'string' ? req.query.workspacePath : undefined
      let detail: CodingAgentSessionDetail | null = null
      // Helper: search for run meta file in common layouts when no workspace provided
      const findRunMetaFile = (id: string): string | null => {
        const root = process.cwd()
        const ignored = new Set(['node_modules', '.git'])
        const stack: string[] = [root]
        while (stack.length) {
          const dir = stack.pop() as string
          let entries: string[] = []
          try {
            entries = fs.readdirSync(dir)
          } catch {
            continue
          }
          for (const name of entries) {
            if (ignored.has(name)) continue
            const full = path.join(dir, name)
            let stat: fs.Stats
            try {
              stat = fs.statSync(full)
            } catch {
              continue
            }
            if (stat.isDirectory()) {
              // If we find a .hyperagent dir containing the id, return it
              if (name === '.hyperagent') {
                const candidate = path.join(full, `${id}.json`)
                if (fs.existsSync(candidate)) return candidate
              }
              // Look for legacy opencode storage layout
              if (name === 'storage') {
                // check storage/session/**/<id>.json
                const sessionDir = path.join(full, 'session')
                if (fs.existsSync(sessionDir)) {
                  try {
                    const projects = fs.readdirSync(sessionDir)
                    for (const p of projects) {
                      const candidate = path.join(sessionDir, p, `${id}.json`)
                      if (fs.existsSync(candidate)) return candidate
                    }
                  } catch {
                    // ignore
                  }
                }
              }
              // push directory for further traversal
              stack.push(full)
            }
          }
        }
        return null
      }

      if (workspaceQuery) {
        try {
          const opSession = await getOpencodeSession(workspaceQuery, sessionId).catch(() => null)
          if (opSession) {
            detail = {
              session: {
                id: sessionId,
                workspacePath: workspaceQuery,
                modelId: DEFAULT_CODING_AGENT_MODEL,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                title: null,
                projectId: null as any,
                summary: { additions: 0, deletions: 0, files: 0 }
              },
              messages: []
            }
          }
        } catch (e) {
          console.error('opencode session lookup failed', e)
        }
        if (!detail) {
          try {
            const metaDir = metaDirectory(workspaceQuery)
            const filePath = path.join(metaDir, `${sessionId}.json`)
            if (fs.existsSync(filePath)) {
              const raw = fs.readFileSync(filePath, 'utf-8')
              const parsed = JSON.parse(raw) as ProvRunMeta
              detail = {
                session: {
                  id: parsed.id,
                  workspacePath: workspaceQuery,
                  modelId: DEFAULT_CODING_AGENT_MODEL,
                  createdAt: parsed.createdAt,
                  updatedAt: parsed.updatedAt,
                  title: null,
                  projectId: null as any,
                  summary: { additions: 0, deletions: 0, files: 0 }
                },
                messages: []
              }
            }
          } catch (err) {
            console.error('run meta lookup failed', err)
          }
        }
      } else {
        // No workspace query provided: try to discover a RunMeta file
        // elsewhere in the repository (supports test fixtures and legacy
        // opencode storage layouts).
        const found = findRunMetaFile(sessionId)
        if (found) {
          try {
            const raw = fs.readFileSync(found, 'utf-8')
            const parsed = JSON.parse(raw) as ProvRunMeta
            // compute workspace root based on file layout
            let inferredWorkspace = process.cwd()
            if (
              found.includes(`${path.sep}.hyperagent${path.sep}`) ||
              found.endsWith(`${path.sep}.hyperagent${path.sep}${sessionId}.json`)
            ) {
              inferredWorkspace = path.dirname(path.dirname(found))
            } else if (found.includes(`${path.sep}storage${path.sep}session${path.sep}`)) {
              inferredWorkspace = found.split(`${path.sep}storage${path.sep}session`)[0]
            } else {
              inferredWorkspace = path.dirname(path.dirname(found))
            }
            workspaceQuery = inferredWorkspace
            detail = {
              session: {
                id: parsed.id,
                workspacePath: workspaceQuery,
                modelId: DEFAULT_CODING_AGENT_MODEL,
                createdAt: parsed.createdAt,
                updatedAt: parsed.updatedAt,
                title: null,
                projectId: null as any,
                summary: { additions: 0, deletions: 0, files: 0 }
              },
              messages: []
            }
          } catch (err) {
            console.error('discovered run meta parse failed', err)
          }
        }
      }
      if (!detail) {
        res.status(404).json({ error: 'Unknown session' })
        return
      }
      const normalizedMessages = dedupeSequentialMessages(detail.messages ?? [])
      console.log('[coding-agent] getCodingAgentSessionHandler', { sessionId, messages: normalizedMessages.length })
      res.json({ ...detail, messages: normalizedMessages })
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
    // provider selection removed; provider config will be defaulted by ensureProviderConfig
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
      await ensureProviderConfig(normalizedWorkspace, undefined, personaId)

      const resolvedModel = typeof model === 'string' && model.trim().length ? model.trim() : DEFAULT_CODING_AGENT_MODEL
      const trimmedPrompt = prompt.trim()
      /** @todo use provider abstraction in the future */
      // if (adapter.validateModel) {
      //   const ok = await Promise.resolve(adapter.validateModel(resolvedModel))
      //   if (!ok) {
      //     res.status(400).json({ error: `Model not supported by provider: ${resolvedModel}` })
      //     return
      //   }
      // }
      logSessions('Starting coding agent run', { workspacePath: normalizedWorkspace, model: resolvedModel })

      // For non-multi-agent runs we start a simple opencode session and
      // prompt it with the initial text. This keeps the route as a thin
      // wrapper over the opencode helpers.
      if (!multiAgentMode) {
        // Start a single-agent loop in the background which will create and
        // persist run metadata via the provenance helpers.
        const sessionId = `ses_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
        const startedAt = new Date().toISOString()
        const runRecord: RunMeta = { id: sessionId, agents: [], log: [], createdAt: startedAt, updatedAt: startedAt }
        ;(async () => {
          try {
            await runSingleAgentLoop({
              userInstructions: trimmedPrompt,
              model: resolvedModel,
              sessionDir: normalizedWorkspace,
              runID: sessionId
            })
          } catch (err) {
            logSessionsError('Single-agent loop failed', err, { sessionId })
          }
        })()
        res.status(202).json({ run: runRecord })
        return
      }

      // Multi-agent persona: kick off the verifier/worker loop in the
      // background and return a minimal RunMeta immediately.
      const sessionId = `ses_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
      const startedAt = new Date().toISOString()
      const runRecord: RunMeta = { id: sessionId, agents: [], log: [], createdAt: startedAt, updatedAt: startedAt }
      ;(async () => {
        try {
          await runVerifierWorkerLoop({
            userInstructions: trimmedPrompt,
            model: resolvedModel,
            sessionDir: normalizedWorkspace,
            runID: sessionId
          })
        } catch (err) {
          logSessionsError('Multi-agent loop failed', err, { sessionId })
        }
      })()
      res.status(202).json({ run: runRecord })
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
      try {
        await ensureWorkspaceDirectory(workspaceQuery)
      } catch {
        res.status(400).json({ error: 'Session workspace is unavailable' })
        return
      }

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
  router.get('/api/coding-agent/sessions/:sessionId', wrapAsync(getCodingAgentSessionHandler))
  router.get('/api/coding-agent/runs', wrapAsync(listCodingAgentRunsHandler))
  router.post('/api/coding-agent/sessions', wrapAsync(startCodingAgentSessionHandler))
  router.post('/api/coding-agent/sessions/:sessionId/kill', wrapAsync(killCodingAgentSessionHandler))
  router.post('/api/coding-agent/sessions/:sessionId/messages', wrapAsync(postCodingAgentMessageHandler))

  return router
}
