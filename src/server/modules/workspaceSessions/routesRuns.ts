import { Router, type RequestHandler } from 'express'
import fs from 'fs'
import path from 'path'
import { singleAgentWorkflowDefinition, verifierWorkerWorkflowDefinition } from '../../../modules/agent/workflows'
import { loadRunMeta, metaDirectory, saveRunMeta, type RunMeta } from '../../../modules/provenance/provenance'
import { type AgentWorkflowDefinition } from '../../../modules/agent/workflow-schema'
import { ensureProviderConfig } from '../../../modules/providerConfig'
import { DEFAULT_CODING_AGENT_MODEL } from '../../core/config'
import {
  readWorkspaceRuns,
  resolveWorkspacePath,
  safeLoadRun,
  serializeRunWithDiffs,
  serializeRunsWithDiffs
} from './routesShared'
import type { WorkspaceSessionsDeps } from './routesTypes'
import { runAgent, type AgentExecutionMode } from './agentRunner'

const MULTI_AGENT_PERSONA_ID = 'multi-agent'
const DEFAULT_WORKFLOW_ID = singleAgentWorkflowDefinition.id

type BuiltinWorkflow = {
  id: string
  source: 'builtin'
  definition: AgentWorkflowDefinition
}

const BUILTIN_WORKFLOWS: readonly BuiltinWorkflow[] = [
  { id: singleAgentWorkflowDefinition.id, source: 'builtin', definition: singleAgentWorkflowDefinition },
  { id: verifierWorkerWorkflowDefinition.id, source: 'builtin', definition: verifierWorkerWorkflowDefinition }
]

const workflowById = new Map(BUILTIN_WORKFLOWS.map((wf) => [wf.id, wf]))

const resolveWorkflow = (id: string | null | undefined): BuiltinWorkflow | null => {
  if (!id) return null
  return workflowById.get(id) ?? null
}

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
    const workspacePath = resolveWorkspacePath(req)
    if (!workspacePath) {
      res.json({ runs: [] as RunMeta[] })
      return
    }
    const runs = serializeRunsWithDiffs(readWorkspaceRuns(workspacePath))
    res.json({ runs })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list coding agent sessions'
    res.status(500).json({ error: message })
  }
}

const createListRunsHandler = (): RequestHandler => async (req, res) => {
  try {
    const workspacePath = resolveWorkspacePath(req)
    if (!workspacePath) {
      res.json({ runs: [] as RunMeta[] })
      return
    }
    const runs = serializeRunsWithDiffs(readWorkspaceRuns(workspacePath))
    res.json({ runs })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list coding agent runs'
    res.status(500).json({ error: message })
  }
}

const createStartSessionHandler =
  ({ logSessions, logSessionsError }: ReturnType<typeof createLogger>): RequestHandler =>
  async (req, res) => {
    const { workspacePath, prompt, model, workflowId: workflowIdRaw, execution, runInDocker } = req.body ?? {}
    const personaId =
      typeof req.body?.personaId === 'string' && req.body.personaId.trim() ? req.body.personaId.trim() : null
    const requestedWorkflowId =
      typeof workflowIdRaw === 'string' && workflowIdRaw.trim().length ? workflowIdRaw.trim() : null
    const legacyPersonaWorkflowId = personaId === MULTI_AGENT_PERSONA_ID ? verifierWorkerWorkflowDefinition.id : null
    const workflowId = requestedWorkflowId ?? legacyPersonaWorkflowId ?? DEFAULT_WORKFLOW_ID
    if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
      res.status(400).json({ error: 'workspacePath is required' })
      return
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'prompt is required' })
      return
    }
    const normalizedWorkspace = workspacePath.trim()
    const executionMode: AgentExecutionMode = resolveExecutionMode(execution, runInDocker)
    const runId = buildRunId(workflowId)

    try {
      const resolvedModel = typeof model === 'string' && model.trim().length ? model.trim() : DEFAULT_CODING_AGENT_MODEL
      const trimmedPrompt = prompt.trim()

      const workflow = resolveWorkflow(workflowId)
      if (!workflow) {
        res.status(400).json({ error: `Unknown workflow: ${workflowId}` })
        return
      }

      logSessions('Starting coding agent run', {
        workspacePath: normalizedWorkspace,
        model: resolvedModel,
        workflowId: workflow.id,
        workflowSource: workflow.source,
        execution: executionMode
      })

      if (personaId) {
        await ensureProviderConfig(normalizedWorkspace, 'opencode', personaId)
      }
      await runAgent({
        workflow,
        prompt: trimmedPrompt,
        model: resolvedModel,
        workspacePath: normalizedWorkspace,
        runId,
        execution: executionMode,
        personaId
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

const resolveExecutionMode = (rawMode: unknown, runInDocker?: unknown): AgentExecutionMode => {
  if (runInDocker === true) return 'docker'
  if (typeof rawMode === 'string' && rawMode.toLowerCase() === 'docker') return 'docker'
  return 'local'
}

const buildRunId = (workflowId: string) => `${workflowId}-${Date.now()}`

const createPostMessageHandler =
  ({ logSessions, logSessionsError }: ReturnType<typeof createLogger>): RequestHandler =>
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
    const executionMode: AgentExecutionMode = resolveExecutionMode(body.execution, body.runInDocker)
    if (!text.length) {
      res.status(400).json({ error: 'text is required' })
      return
    }
    let workflowForResponse: BuiltinWorkflow | null = null

    try {
      const workspacePath = resolveWorkspacePath(req)
      if (!workspacePath) {
        res.status(400).json({ error: 'workspacePath is required' })
        return
      }

      const resolvedModelId = requestedModelId ?? DEFAULT_CODING_AGENT_MODEL
      logSessions('Posting coding agent message (opencode prompt)', {
        sessionId: runId,
        modelId: resolvedModelId,
        role,
        workspacePath,
        execution: executionMode
      })
      try {
        const metaDir = metaDirectory(workspacePath)
        let workflow: BuiltinWorkflow | null = null
        let runMeta: RunMeta | null = null

        try {
          const filePath = path.join(metaDir, `${runId}.json`)
          if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf-8')
            const parsed = JSON.parse(raw) as RunMeta
            runMeta = parsed
            if (parsed.workflowId) {
              workflow = resolveWorkflow(parsed.workflowId)
            }
          }
        } catch {
          workflow = null
        }

        if (!workflow) {
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
          const fallbackWorkflowId = isMultiAgent ? verifierWorkerWorkflowDefinition.id : DEFAULT_WORKFLOW_ID
          workflow = resolveWorkflow(fallbackWorkflowId)
        }

        if (!workflow) {
          throw new Error('No matching workflow definition found for this run')
        }

        workflowForResponse = workflow

        ;(async () => {
          try {
            await runAgent({
              workflow,
              prompt: text,
              model: resolvedModelId,
              workspacePath,
              runId,
              execution: executionMode,
              personaId: null
            })
          } catch (err) {
            const label = `Workflow prompt failed (${workflow.id})`
            logSessionsError(label, err, { sessionId: runId, modelId: resolvedModelId })
          }
        })()

        if (runMeta && !runMeta.workflowId) {
          runMeta.workflowId = workflow.id
          runMeta.workflowSource = workflow.source
          saveRunMeta(runMeta, runId, workspacePath)
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
        updatedAt: new Date().toISOString(),
        ...(workflowForResponse
          ? { workflowId: workflowForResponse.id, workflowSource: workflowForResponse.source }
          : {})
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
