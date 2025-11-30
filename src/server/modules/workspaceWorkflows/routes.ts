import { Router, type Request, type RequestHandler } from 'express'
import fs from 'fs/promises'
import path from 'path'
import type { Persistence } from '../../../../src/modules/database'
import type { PlannerRun, PlannerTask, WorkflowDetail, WorkflowRuntime } from '../../../../src/modules/workflows'

type WrapAsync = (handler: RequestHandler) => RequestHandler

type WorkspaceWorkflowsPersistence = Pick<Persistence, 'projects' | 'workflowSteps' | 'workflowRunnerEvents'>

export type WorkspaceWorkflowsDeps = {
  wrapAsync: WrapAsync
  workflowRuntime: WorkflowRuntime
  persistence: WorkspaceWorkflowsPersistence
  runGitCommand: (args: string[], cwd: string) => Promise<string>
  validateWorkflowRunnerToken: (req: Request) => boolean
}

export const createWorkspaceWorkflowsRouter = (deps: WorkspaceWorkflowsDeps) => {
  const { wrapAsync, workflowRuntime, persistence, runGitCommand, validateWorkflowRunnerToken } = deps
  const router = Router()

  const logWorkflow = (message: string, metadata?: Record<string, unknown>) => {
    if (metadata && Object.keys(metadata).length) {
      console.log(`[workflows] ${message}`, metadata)
      return
    }
    console.log(`[workflows] ${message}`)
  }

  const logWorkflowError = (message: string, error: unknown, metadata?: Record<string, unknown>) => {
    const payload = {
      ...(metadata ?? {}),
      error:
        error instanceof Error
          ? { message: error.message, stack: error.stack }
          : typeof error === 'string'
            ? { message: error }
            : error
    }
    console.error(`[workflows] ${message}`, payload)
  }

  const normalizePlannerTasks = (raw: unknown): PlannerTask[] => {
    if (!Array.isArray(raw)) return []
    const tasks: PlannerTask[] = []
    raw.forEach((candidate, index) => {
      if (!isPlainObject(candidate)) return
      const title = typeof candidate.title === 'string' ? candidate.title.trim() : ''
      const instructions = typeof candidate.instructions === 'string' ? candidate.instructions.trim() : ''
      if (!title || !instructions) return
      const dependsOn = Array.isArray(candidate.dependsOn)
        ? candidate.dependsOn.filter((dep) => typeof dep === 'string' && dep.length)
        : []
      const metadata = isPlainObject(candidate.metadata) ? candidate.metadata : undefined
      tasks.push({
        id: typeof candidate.id === 'string' && candidate.id.length ? candidate.id : `task-${index + 1}`,
        title,
        instructions,
        agentType:
          typeof candidate.agentType === 'string' && candidate.agentType.length ? candidate.agentType : 'coding',
        dependsOn,
        metadata
      })
    })
    return tasks
  }

  const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  const readWorkspacePathFromResult = (result: Record<string, unknown> | null | undefined): string | null => {
    if (!result || typeof result !== 'object') return null
    const workspace = (result as any).workspace
    if (workspace && typeof workspace.workspacePath === 'string') {
      return workspace.workspacePath
    }
    return null
  }

  const safeParseJson = (raw: string): unknown | null => {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  const MAX_WORKSPACE_ENTRIES = 75

  const collectWorkspaceEntries = async (
    workspacePath: string | null
  ): Promise<Array<{ name: string; kind: 'file' | 'directory' }>> => {
    if (!workspacePath) return []
    try {
      const dirents = await fs.readdir(workspacePath, { withFileTypes: true })
      return dirents
        .sort((a, b) => {
          const aDir = a.isDirectory()
          const bDir = b.isDirectory()
          if (aDir !== bDir) {
            return aDir ? -1 : 1
          }
          return a.name.localeCompare(b.name)
        })
        .slice(0, MAX_WORKSPACE_ENTRIES)
        .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' }))
    } catch {
      return []
    }
  }

  const readLogsPathFromResult = (result: Record<string, unknown> | null | undefined): string | null => {
    if (!result || typeof result !== 'object') return null
    const provenance = (result as any).provenance
    if (provenance && typeof provenance.logsPath === 'string') {
      return provenance.logsPath
    }
    if (typeof (result as any).logsPath === 'string') {
      return (result as any).logsPath
    }
    return null
  }

  const deriveLogsPathForStep = (
    step: { id: string; result: Record<string, unknown> | null },
    runs: Array<{ workflowStepId: string | null; logsPath: string | null }>
  ): string | null => {
    const direct = readLogsPathFromResult(step.result)
    if (direct) return direct
    const run = runs.find((entry) => entry.workflowStepId === step.id && typeof entry.logsPath === 'string')
    return typeof run?.logsPath === 'string' ? (run as { logsPath: string }).logsPath : null
  }

  const extractCommitFromStep = (
    step: WorkflowDetail['steps'][number]
  ): { commitHash: string; branch: string; message: string } | null => {
    if (!step.result) return null
    const commitPayload = (step.result as Record<string, any>).commit as Record<string, any> | undefined
    if (!commitPayload?.commitHash) {
      return null
    }
    const branch =
      typeof commitPayload.branch === 'string' && commitPayload.branch.length ? commitPayload.branch : 'unknown'
    const message = typeof commitPayload.message === 'string' ? commitPayload.message : ''
    return {
      commitHash: String(commitPayload.commitHash),
      branch,
      message
    }
  }

  const listWorkflowsHandler: RequestHandler = (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined
    const workflows = workflowRuntime.listWorkflows(projectId)
    const payload = workflows.map((workflow) => ({
      workflow,
      steps: persistence.workflowSteps.listByWorkflow(workflow.id)
    }))
    logWorkflow('List workflows requested', { projectId, count: payload.length })
    res.json({ workflows: payload })
  }

  const createWorkflowHandler: RequestHandler = (req, res) => {
    const { projectId, kind, tasks, data, autoStart } = req.body ?? {}
    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({ error: 'projectId is required' })
      return
    }
    const project = persistence.projects.getById(projectId)
    if (!project) {
      res.status(404).json({ error: 'Unknown project' })
      return
    }
    const normalizedTasks = normalizePlannerTasks(tasks)
    if (!normalizedTasks.length) {
      res.status(400).json({ error: 'At least one task is required' })
      return
    }
    const plannerRun: PlannerRun = {
      id: `planner-${Date.now()}`,
      kind: typeof kind === 'string' && kind.length ? kind : 'custom',
      tasks: normalizedTasks,
      data: isPlainObject(data) ? data : {}
    }
    try {
      logWorkflow('Creating workflow from plan', {
        projectId,
        kind: plannerRun.kind,
        taskCount: plannerRun.tasks.length,
        autoStart: Boolean(autoStart)
      })
      const workflow = workflowRuntime.createWorkflowFromPlan({ projectId, plannerRun })
      if (autoStart) {
        logWorkflow('Auto-starting workflow', { workflowId: workflow.id, projectId })
        workflowRuntime.startWorkflow(workflow.id)
      }
      const detail = workflowRuntime.getWorkflowDetail(workflow.id)
      logWorkflow('Workflow created', { workflowId: workflow.id, projectId })
      res.status(201).json(detail ?? { workflow })
    } catch (error) {
      logWorkflowError('Failed to create workflow', error, { projectId })
      res.status(500).json({ error: 'Failed to create workflow' })
    }
  }

  const startWorkflowHandler: RequestHandler = (req, res) => {
    const workflowId = req.params.workflowId
    if (!workflowId) {
      res.status(400).json({ error: 'workflowId is required' })
      return
    }
    const detail = workflowRuntime.getWorkflowDetail(workflowId)
    if (!detail) {
      res.status(404).json({ error: 'Unknown workflow' })
      return
    }
    try {
      logWorkflow('Starting workflow', { workflowId })
      workflowRuntime.startWorkflow(workflowId)
      res.json({ workflowId, status: 'running' })
    } catch (error) {
      logWorkflowError('Failed to start workflow', error, { workflowId })
      res.status(500).json({ error: 'Failed to start workflow' })
    }
  }

  const workflowDetailHandler: RequestHandler = (req, res) => {
    const workflowId = req.params.workflowId
    if (!workflowId) {
      res.status(400).json({ error: 'workflowId is required' })
      return
    }
    const detail = workflowRuntime.getWorkflowDetail(workflowId)
    if (!detail) {
      res.status(404).json({ error: 'Unknown workflow' })
      return
    }
    logWorkflow('Workflow detail requested', { workflowId })
    res.json(detail)
  }

  const workflowEventsHandler: RequestHandler = (req, res) => {
    const workflowId = req.params.workflowId
    if (!workflowId) {
      res.status(400).json({ error: 'workflowId is required' })
      return
    }
    const detail = workflowRuntime.getWorkflowDetail(workflowId)
    if (!detail) {
      res.status(404).json({ error: 'Unknown workflow' })
      return
    }
    const events = persistence.workflowRunnerEvents.listByWorkflow(workflowId, 200)
    logWorkflow('Workflow events requested', { workflowId, eventCount: events.length })
    res.json({ workflowId, events })
  }

  const workflowRunnerCallbackHandler: RequestHandler = async (req, res) => {
    const workflowId = req.params.workflowId
    const stepId = req.params.stepId
    if (!workflowId || !stepId) {
      res.status(400).json({ error: 'workflowId and stepId are required' })
      return
    }
    if (!validateWorkflowRunnerToken(req)) {
      res.status(401).json({ error: 'Invalid workflow runner token' })
      return
    }
    const runnerInstanceId = typeof req.body?.runnerInstanceId === 'string' ? req.body.runnerInstanceId.trim() : ''
    if (!runnerInstanceId.length) {
      res.status(400).json({ error: 'runnerInstanceId is required' })
      return
    }
    const runnerStatus = typeof req.body?.status === 'string' ? req.body.status : 'unknown'
    const runnerError = typeof req.body?.error === 'string' ? req.body.error : undefined
    logWorkflow('Runner callback received', {
      workflowId,
      stepId,
      runnerInstanceId,
      runnerStatus,
      runnerError: runnerError ?? null
    })
    res.json({ ok: true })
  }

  const workflowStepDiffHandler: RequestHandler = async (req, res) => {
    const { workflowId, stepId } = req.params
    if (!workflowId || !stepId) {
      res.status(400).json({ error: 'workflowId and stepId are required' })
      return
    }
    const detail = workflowRuntime.getWorkflowDetail(workflowId)
    if (!detail) {
      res.status(404).json({ error: 'Unknown workflow' })
      return
    }
    const project = persistence.projects.getById(detail.workflow.projectId)
    if (!project) {
      res.status(404).json({ error: 'Unknown project' })
      return
    }
    const step = detail.steps.find((item) => item.id === stepId)
    if (!step) {
      res.status(404).json({ error: 'Unknown workflow step' })
      return
    }
    const commit = extractCommitFromStep(step)
    if (!commit) {
      res.status(404).json({ error: 'No commit for this step' })
      return
    }
    try {
      const diffArgs = [
        'show',
        commit.commitHash,
        '--stat',
        '--patch',
        '--unified=200',
        '--',
        '.',
        ':(exclude).hyperagent/**',
        ':(exclude)**/.hyperagent/**'
      ]
      const diffText = await runGitCommand(diffArgs, project.repositoryPath)
      logWorkflow('Workflow step diff generated', { workflowId, stepId, commit: commit.commitHash })
      res.json({
        workflowId,
        stepId,
        commitHash: commit.commitHash,
        branch: commit.branch === 'unknown' ? project.defaultBranch : commit.branch,
        message: commit.message,
        diffText
      })
    } catch (error) {
      logWorkflowError('Failed to read workflow step diff', error, { workflowId, stepId })
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to read diff' })
    }
  }

  const workflowStepProvenanceHandler: RequestHandler = async (req, res) => {
    const workflowId = req.params.workflowId
    const stepId = req.params.stepId
    if (!workflowId || !stepId) {
      res.status(400).json({ error: 'workflowId and stepId are required' })
      return
    }
    const detail = workflowRuntime.getWorkflowDetail(workflowId)
    if (!detail) {
      res.status(404).json({ error: 'Unknown workflow' })
      return
    }
    const step = detail.steps.find((entry) => entry.id === stepId)
    if (!step) {
      res.status(404).json({ error: 'Unknown workflow step' })
      return
    }
    const logsPath = deriveLogsPathForStep(step, detail.runs)
    if (!logsPath) {
      res.status(404).json({ error: 'Provenance file not available for this step' })
      return
    }
    try {
      const raw = await fs.readFile(logsPath, 'utf8')
      const workspacePath = readWorkspacePathFromResult(step.result)
      const workspaceEntries = await collectWorkspaceEntries(workspacePath)
      logWorkflow('Workflow step provenance served', { workflowId, stepId, logsPath })
      res.json({
        logsPath,
        workspacePath,
        content: raw,
        parsed: safeParseJson(raw),
        workspaceEntries,
        downloadUrl: `/api/workflows/${workflowId}/steps/${stepId}/provenance/download`
      })
    } catch (error) {
      logWorkflowError('Failed to load workflow provenance', error, { workflowId, stepId })
      const message = error instanceof Error ? error.message : 'Failed to load provenance file'
      res.status(500).json({ error: message })
    }
  }

  const workflowStepProvenanceDownloadHandler: RequestHandler = async (req, res) => {
    const workflowId = req.params.workflowId
    const stepId = req.params.stepId
    if (!workflowId || !stepId) {
      res.status(400).json({ error: 'workflowId and stepId are required' })
      return
    }
    const detail = workflowRuntime.getWorkflowDetail(workflowId)
    if (!detail) {
      res.status(404).json({ error: 'Unknown workflow' })
      return
    }
    const step = detail.steps.find((entry) => entry.id === stepId)
    if (!step) {
      res.status(404).json({ error: 'Unknown workflow step' })
      return
    }
    const logsPath = deriveLogsPathForStep(step, detail.runs)
    if (!logsPath) {
      res.status(404).json({ error: 'Provenance file not available for this step' })
      return
    }
    try {
      const raw = await fs.readFile(logsPath)
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(logsPath)}"`)
      logWorkflow('Workflow step provenance download', { workflowId, stepId, logsPath })
      res.send(raw)
    } catch (error) {
      logWorkflowError('Failed to download workflow provenance', error, { workflowId, stepId })
      const message = error instanceof Error ? error.message : 'Failed to load provenance file'
      res.status(500).json({ error: message })
    }
  }

  router.get('/api/workflows', wrapAsync(listWorkflowsHandler))
  router.post('/api/workflows', wrapAsync(createWorkflowHandler))
  router.post('/api/workflows/:workflowId/start', wrapAsync(startWorkflowHandler))
  router.get('/api/workflows/:workflowId', wrapAsync(workflowDetailHandler))
  router.get('/api/workflows/:workflowId/events', wrapAsync(workflowEventsHandler))
  router.post('/api/workflows/:workflowId/steps/:stepId/callback', wrapAsync(workflowRunnerCallbackHandler))
  router.get('/api/workflows/:workflowId/steps/:stepId/diff', wrapAsync(workflowStepDiffHandler))
  router.get('/api/workflows/:workflowId/steps/:stepId/provenance', wrapAsync(workflowStepProvenanceHandler))
  router.get(
    '/api/workflows/:workflowId/steps/:stepId/provenance/download',
    wrapAsync(workflowStepProvenanceDownloadHandler)
  )

  return router
}
