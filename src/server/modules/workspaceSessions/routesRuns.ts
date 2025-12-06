import { Router, type RequestHandler } from 'express'
import fs from 'fs'
import path from 'path'
import { runVerifierWorkerLoop } from '../../../modules/agent/multi-agent'
import { runSingleAgentLoop } from '../../../modules/agent/single-agent'
import { loadRunMeta, metaDirectory, type RunMeta } from '../../../modules/provenance/provenance'
import { ensureProviderConfig } from '../../../modules/workflowAgentExecutor'
import { DEFAULT_CODING_AGENT_MODEL } from '../../core/config'
import { readPersona } from './personas'
import {
  normalizeWorkspacePath,
  readWorkspaceRuns,
  rememberWorkspacePath,
  safeLoadRun,
  serializeRunWithDiffs,
  serializeRunsWithDiffs
} from './routesShared'
import type { WorkspaceSessionsDeps } from './routesTypes'

const MULTI_AGENT_PERSONA_ID = 'multi-agent'

const createLogger = () => {
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

  return { logSessions, logSessionsError }
}

const createListSessionsHandler = (): RequestHandler => async (req, res) => {
  try {
    const workspacePath = normalizeWorkspacePath(req.query.workspacePath)
    if (!workspacePath) {
      res.json({ runs: [] as RunMeta[] })
      return
    }
    rememberWorkspacePath(workspacePath)
    const runs = serializeRunsWithDiffs(readWorkspaceRuns(workspacePath))
    res.json({ runs })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list coding agent sessions'
    res.status(500).json({ error: message })
  }
}

const createListRunsHandler = (): RequestHandler => async (req, res) => {
  try {
    const workspacePath = normalizeWorkspacePath(req.query.workspacePath)
    if (!workspacePath) {
      res.json({ runs: [] as RunMeta[] })
      return
    }
    rememberWorkspacePath(workspacePath)
    const runs = serializeRunsWithDiffs(readWorkspaceRuns(workspacePath))
    res.json({ runs })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list coding agent runs'
    res.status(500).json({ error: message })
  }
}

const createStartSessionHandler = ({ logSessions, logSessionsError }: ReturnType<typeof createLogger>): RequestHandler =>
  async (req, res) => {
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
    rememberWorkspacePath(normalizedWorkspace)

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
      const resolvedModel = typeof model === 'string' && model.trim().length ? model.trim() : DEFAULT_CODING_AGENT_MODEL
      const trimmedPrompt = prompt.trim()

      logSessions('Starting coding agent run', { workspacePath: normalizedWorkspace, model: resolvedModel })

      if (personaId) {
        await ensureProviderConfig(normalizedWorkspace, 'opencode', personaId)
      }

      if (!multiAgentMode) {
        const { runId } = await runSingleAgentLoop({
          userInstructions: trimmedPrompt,
          model: resolvedModel,
          sessionDir: normalizedWorkspace
        })
        const run = loadRunMeta(runId, normalizedWorkspace)
        res.status(202).json({ run: serializeRunWithDiffs(run) })
        return
      }

      const { runId } = await runVerifierWorkerLoop({
        userInstructions: trimmedPrompt,
        model: resolvedModel,
        sessionDir: normalizedWorkspace
      })
      const run = loadRunMeta(runId, normalizedWorkspace)
      res.status(202).json({ run: serializeRunWithDiffs(run) })
    } catch (error) {
      logSessionsError('Failed to start coding agent session', error, { workspacePath: normalizedWorkspace })
      const message = error instanceof Error ? error.message : 'Failed to start coding agent session'
      res.status(500).json({ error: message })
    }
  }

const resolveRunId = (params: Record<string, string | undefined>) => params.runId ?? params.sessionId ?? null

const createPostMessageHandler = ({ logSessions, logSessionsError }: ReturnType<typeof createLogger>): RequestHandler =>
  async (req, res) => {
    const runId = resolveRunId(req.params)
    if (!runId) {
      res.status(400).json({ error: 'runId is required' })
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
      const workspacePath = normalizeWorkspacePath(req.query.workspacePath) ?? process.cwd()

      const resolvedModelId = requestedModelId ?? DEFAULT_CODING_AGENT_MODEL
      rememberWorkspacePath(workspacePath)
      logSessions('Posting coding agent message (opencode prompt)', {
        sessionId: runId,
        modelId: resolvedModelId,
        role,
        workspacePath
      })
      try {
        const metaDir = metaDirectory(workspacePath)
        let isMultiAgent = false
        try {
          const filePath = path.join(metaDir, `${runId}.json`)
          if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf-8')
            const parsed = JSON.parse(raw) as RunMeta
            const roles = Array.isArray(parsed.agents) ? parsed.agents.map((agent) => agent.role) : []
            if (roles.includes('worker') || roles.includes('verifier') || roles.length > 1) {
              isMultiAgent = true
            }
          }
        } catch {
          isMultiAgent = false
        }

        if (isMultiAgent) {
          ;(async () => {
            try {
              await runVerifierWorkerLoop({
                runID: runId,
                userInstructions: text,
                model: resolvedModelId,
                sessionDir: workspacePath
              })
            } catch (err) {
              logSessionsError('Multi-agent prompt failed', err, { sessionId: runId, modelId: resolvedModelId })
            }
          })()
        } else {
          ;(async () => {
            try {
              await runSingleAgentLoop({
                runID: runId,
                userInstructions: text,
                model: resolvedModelId,
                sessionDir: workspacePath
              })
            } catch (err) {
              logSessionsError('Single-agent prompt failed', err, { sessionId: runId, modelId: resolvedModelId })
            }
          })()
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Provider invocation failed'
        logSessionsError('Opencode prompt failed', err, { sessionId: runId, modelId: resolvedModelId })
        res.status(500).json({ error: message })
        return
      }

      const fallbackRun: RunMeta = {
        id: runId,
        agents: [],
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
      const run = safeLoadRun(runId, workspacePath) ?? fallbackRun
      res.status(201).json({ run: serializeRunWithDiffs(run) })
    } catch (error) {
      logSessionsError('Failed to post coding agent message', error, { sessionId: runId })
      const message = error instanceof Error ? error.message : 'Failed to post coding agent message'
      res.status(500).json({ error: message })
    }
  }

export const createRunsRouter = (deps: WorkspaceSessionsDeps) => {
  const { wrapAsync } = deps
  const router = Router()
  const logger = createLogger()

  router.get('/api/coding-agent/sessions', wrapAsync(createListSessionsHandler()))
  router.get('/api/coding-agent/runs', wrapAsync(createListRunsHandler()))
  router.post('/api/coding-agent/sessions', wrapAsync(createStartSessionHandler(logger)))
  router.post('/api/coding-agent/sessions/:runId/messages', wrapAsync(createPostMessageHandler(logger)))

  return router
}
