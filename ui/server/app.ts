import cors from 'cors'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import express from 'express'
import fs from 'fs/promises'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { spawn } from 'node:child_process'
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import { createServer, type AddressInfo, type Socket } from 'node:net'
import os from 'os'
import path from 'path'
import { runVerifierWorkerLoop, type AgentStreamEvent } from '../../src/modules/agent'
import {
  createCodeServerController,
  type CodeServerController,
  type CodeServerOptions
} from '../../src/modules/codeServer'
import { createPersistence, type Persistence, type ProjectRecord } from '../../src/modules/persistence'
import { createWorkflowRuntime, type PlannerRun, type PlannerTask, type WorkflowDetail, type WorkflowRuntime } from '../../src/modules/workflows'
import { createRadicleModule, type RadicleModule } from '../../src/modules/radicle'
import type { Provider } from '../../src/modules/llm'

const DEFAULT_PORT = Number(process.env.UI_SERVER_PORT || 5556)
const CODE_SERVER_HOST = process.env.CODE_SERVER_HOST || '127.0.0.1'

export type ProxyWithUpgrade = RequestHandler & {
  upgrade?: (req: IncomingMessage, socket: Socket, head: Buffer) => void
}

export type CodeServerSession = {
  id: string
  dir: string
  basePath: string
  projectId: string
  branch: string
  controller: CodeServerController
  proxy: ProxyWithUpgrade
  publicUrl: string
}

type RunLoop = typeof runVerifierWorkerLoop

type ControllerFactory = (options: CodeServerOptions) => CodeServerController

type GraphCommitNode = {
  id: string
  commitHash: string
  branch: string
  message: string
  label: string
  workflowId: string
  stepId: string
  timestamp: string
}

type GraphEdge = {
  from: string
  to: string
}

export type CreateServerOptions = {
  runLoop?: RunLoop
  controllerFactory?: ControllerFactory
  tmpDir?: string
  port?: number
  allocatePort?: () => Promise<number>
  persistence?: Persistence
  persistenceFile?: string
  workflowRuntime?: WorkflowRuntime
  workflowPollIntervalMs?: number
  radicleModule?: RadicleModule
}

export type ServerInstance = {
  app: express.Express
  start: (port?: number) => HttpServer
  shutdown: () => Promise<void>
  getActiveSessionIds: () => string[]
  handleUpgrade: (req: IncomingMessage, socket: Socket, head: Buffer) => void
  handlers: {
    agentRun: RequestHandler
    codeServerProxy: RequestHandler
  }
}

export function createServerApp(options: CreateServerOptions = {}): ServerInstance {
  const runLoop = options.runLoop ?? runVerifierWorkerLoop
  const controllerFactory = options.controllerFactory ?? createCodeServerController
  const tmpDir = options.tmpDir ?? os.tmpdir()
  const defaultPort = options.port ?? DEFAULT_PORT
  const allocatePort =
    options.allocatePort ??
    (async () =>
      await new Promise<number>((resolve, reject) => {
        const server = createServer()
        server.once('error', reject)
        server.listen(0, CODE_SERVER_HOST, () => {
          const address = server.address() as AddressInfo | null
          if (!address) {
            server.close(() => reject(new Error('Unable to allocate code-server port')))
            return
          }
          const port = address.port
          server.close(() => resolve(port))
        })
      }))

  const managePersistenceLifecycle = !options.persistence
  const persistence = options.persistence ?? createPersistence({ file: options.persistenceFile })

  const manageRadicleLifecycle = !options.radicleModule
  const radicleModule =
    options.radicleModule ??
    createRadicleModule({
      defaultRemote: process.env.RADICLE_REMOTE ?? 'origin',
      tempRootDir: process.env.RADICLE_TEMP_DIR
    })

  const commitAuthor = {
    name: process.env.WORKFLOW_AUTHOR_NAME ?? 'Hyperagent Workflow',
    email: process.env.WORKFLOW_AUTHOR_EMAIL ?? 'workflow@hyperagent.local'
  }

  const manageWorkerLifecycle = !options.workflowRuntime
  const workflowRuntime =
    options.workflowRuntime ??
    createWorkflowRuntime({
      persistence,
      pollIntervalMs: options.workflowPollIntervalMs,
      radicle: radicleModule,
      commitAuthor
    })
  if (manageWorkerLifecycle) {
    workflowRuntime.startWorker()
  }
  persistence.codeServerSessions.resetAllRunning()

  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '1mb' }))

  const activeCodeServers = new Map<string, CodeServerSession>()

  function ensureEphemeralProject (sessionId: string, sessionDir: string): ProjectRecord {
    return persistence.projects.upsert({
      id: `session-${sessionId}`,
      name: `Session ${sessionId}`,
      repositoryPath: sessionDir,
      defaultBranch: 'main'
    })
  }

  function normalizePlannerTasks (raw: unknown): PlannerTask[] {
    if (!Array.isArray(raw)) return []
    const tasks: PlannerTask[] = []
    raw.forEach((candidate, index) => {
      if (!isPlainObject(candidate)) return
      const title = typeof candidate.title === 'string' ? candidate.title.trim() : ''
      const instructions = typeof candidate.instructions === 'string' ? candidate.instructions.trim() : ''
      if (!title || !instructions) return
      const dependsOn = Array.isArray(candidate.dependsOn)
        ? candidate.dependsOn.filter(dep => typeof dep === 'string' && dep.length)
        : []
      const metadata = isPlainObject(candidate.metadata) ? candidate.metadata : undefined
      tasks.push({
        id: typeof candidate.id === 'string' && candidate.id.length ? candidate.id : `task-${index + 1}`,
        title,
        instructions,
        agentType: typeof candidate.agentType === 'string' && candidate.agentType.length ? candidate.agentType : 'coding',
        dependsOn,
        metadata
      })
    })
    return tasks
  }

  function isPlainObject (value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  function rewriteCodeServerPath(pathName: string, sessionId: string): string {
    const prefix = `/code-server/${sessionId}`
    if (!pathName.startsWith(prefix)) return pathName
    const trimmed = pathName.slice(prefix.length)
    return trimmed.length ? trimmed : '/'
  }

  async function runGitCommand(args: string[], cwd: string): Promise<string> {
    return await new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (data) => {
        stdout += data.toString()
      })
      child.stderr.on('data', (data) => {
        stderr += data.toString()
      })
      child.once('error', reject)
      child.once('close', (code) => {
        if (code === 0) {
          resolve(stdout)
        } else {
          const message = stderr.trim() || stdout.trim() || `git ${args.join(' ')} failed with code ${code}`
          reject(new Error(message))
        }
      })
    })
  }

  function extractCommitFromStep (
    step: WorkflowDetail['steps'][number]
  ): { commitHash: string; branch: string; message: string } | null {
    if (!step.result) return null
    const commitPayload = (step.result as Record<string, any>).commit as Record<string, any> | undefined
    if (!commitPayload?.commitHash) {
      return null
    }
    const branch = typeof commitPayload.branch === 'string' && commitPayload.branch.length ? commitPayload.branch : 'unknown'
    const message = typeof commitPayload.message === 'string' ? commitPayload.message : ''
    return {
      commitHash: String(commitPayload.commitHash),
      branch,
      message
    }
  }

  async function startCodeServerForSession(sessionId: string, sessionDir: string): Promise<CodeServerSession | null> {
    if (activeCodeServers.has(sessionId)) {
      return activeCodeServers.get(sessionId) ?? null
    }

    try {
      const project = ensureEphemeralProject(sessionId, sessionDir)
      const branch = project.defaultBranch
      const port = await allocatePort()
      const basePath = `/code-server/${sessionId}`
      const controller = controllerFactory({
        host: CODE_SERVER_HOST,
        port,
        repoRoot: sessionDir,
        publicBasePath: basePath
      })
      const handle = await controller.ensure()
      if (!handle) {
        throw new Error('code-server failed to start')
      }

      const proxy = createProxyMiddleware({
        target: `http://${CODE_SERVER_HOST}:${port}`,
        changeOrigin: true,
        ws: true,
        pathRewrite: (pathName: string) => rewriteCodeServerPath(pathName, sessionId)
      }) as ProxyWithUpgrade

      const session: CodeServerSession = {
        id: sessionId,
        dir: sessionDir,
        basePath,
        projectId: project.id,
        branch,
        controller,
        proxy,
        publicUrl: handle.publicUrl
      }
      activeCodeServers.set(sessionId, session)
      persistence.codeServerSessions.upsert({
        id: sessionId,
        projectId: project.id,
        branch,
        workspacePath: sessionDir,
        url: handle.publicUrl,
        authToken: 'none',
        processId: handle.child.pid ?? null
      })
      return session
    } catch (error) {
      console.warn('Unable to launch code-server session', sessionId, error)
      return null
    }
  }

  async function shutdownCodeServerSession(sessionId: string): Promise<void> {
    const session = activeCodeServers.get(sessionId)
    if (!session) return
    activeCodeServers.delete(sessionId)
    await session.controller.shutdown()
    persistence.codeServerSessions.markStopped(sessionId)
  }

  function extractSessionIdFromUrl(rawUrl: string | undefined): string | null {
    if (!rawUrl) return null
    const match = rawUrl.match(/^\/code-server\/([^/?#]+)/)
    return match?.[1] ?? null
  }

  async function shutdownAllCodeServers(): Promise<void> {
    const entries = [...activeCodeServers.keys()]
    await Promise.all(entries.map((id) => shutdownCodeServerSession(id)))
  }

  const agentRunHandler: RequestHandler = async (req: Request, res: Response) => {
    const { prompt, provider, model, maxRounds } = req.body ?? {}
    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'prompt is required' })
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    })
    res.flushHeaders?.()
    req.socket?.setKeepAlive?.(true)

    let closed = false
    let sessionId: string | null = null
    res.on('close', () => {
      closed = true
      if (sessionId) {
        void shutdownCodeServerSession(sessionId)
      }
    })

    const emit = (packet: Record<string, unknown>) => {
      if (closed) return
      res.write(`data: ${JSON.stringify(packet)}\n\n`)
      const maybeFlush = (res as Response & { flush?: () => void }).flush
      if (typeof maybeFlush === 'function') {
        maybeFlush.call(res)
      }
    }

    const sessionDir = await fs.mkdtemp(path.join(tmpDir, 'hyperagent-session-'))
    sessionId = path.basename(sessionDir)
    const codeServerSession = await startCodeServerForSession(sessionId, sessionDir)
    console.log('session ready', sessionId)
    emit({
      type: 'session',
      payload: {
        sessionDir,
        sessionId,
        codeServerUrl: codeServerSession?.publicUrl ?? null,
        projectId: codeServerSession?.projectId ?? null,
        branch: codeServerSession?.branch ?? null
      }
    })

    const streamHandler = (event: AgentStreamEvent) => {
      if (closed) return
      emit({ type: 'chunk', payload: event })
    }

    try {
      const providerToUse = typeof provider === 'string' && provider.length ? (provider as Provider) : undefined
      const modelToUse = typeof model === 'string' && model.length ? model : undefined
      const normalizedMaxRounds = typeof maxRounds === 'number' ? maxRounds : undefined

      console.log('running loop', sessionId)
      const result = await runLoop({
        userInstructions: prompt,
        provider: providerToUse,
        model: modelToUse,
        maxRounds: normalizedMaxRounds,
        sessionDir,
        onStream: streamHandler
      })
      console.log('runLoop completed', sessionId)
      emit({ type: 'result', payload: result })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Agent loop failed'
      if (!closed) {
        emit({
          type: 'error',
          payload: {
            message
          }
        })
      }
    } finally {
      if (!closed) {
        console.log('emitting end frame', sessionId)
        emit({ type: 'end' })
        console.log('ending response', sessionId)
        res.end()
      }
      if (sessionId) {
        await shutdownCodeServerSession(sessionId)
      }
    }
  }

  const codeServerProxyHandler: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const { sessionId } = req.params
    const session = sessionId ? activeCodeServers.get(sessionId) : null
    if (!session) {
      res.status(404).json({ error: 'Unknown code-server session' })
      return
    }
    session.proxy(req, res, next)
  }

  const repositoryGraphHandler: RequestHandler = (req, res) => {
    const projectId = req.params.projectId
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' })
      return
    }
    const project = persistence.projects.getById(projectId)
    if (!project) {
      res.status(404).json({ error: 'Unknown project' })
      return
    }
    const workflows = workflowRuntime.listWorkflows(projectId)
    const branchMap = new Map<string, GraphCommitNode[]>()
    const seenCommits = new Set<string>()

    workflows.forEach((workflow) => {
      const steps = persistence.workflowSteps.listByWorkflow(workflow.id)
      steps.forEach((step) => {
        const commit = extractCommitFromStep(step)
        if (!commit) return
        if (seenCommits.has(commit.commitHash)) return
        seenCommits.add(commit.commitHash)
        const branchName = commit.branch === 'unknown' ? project.defaultBranch : commit.branch
        const label = typeof step.data?.title === 'string' && step.data.title.length
          ? (step.data.title as string)
          : `Step ${step.sequence}`
        const node: GraphCommitNode = {
          id: commit.commitHash,
          commitHash: commit.commitHash,
          branch: branchName,
          message: commit.message,
          label,
          workflowId: workflow.id,
          stepId: step.id,
          timestamp: step.updatedAt
        }
        const list = branchMap.get(branchName) ?? []
        list.push(node)
        branchMap.set(branchName, list)
      })
    })

    const branches = [...branchMap.entries()].map(([name, commits]) => ({
      name,
      commits: commits.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    }))

    const edges: GraphEdge[] = []
    branches.forEach((branch) => {
      for (let index = 1; index < branch.commits.length; index++) {
        edges.push({ from: branch.commits[index - 1].id, to: branch.commits[index].id })
      }
    })

    res.json({ project, branches, edges })
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
    const step = detail.steps.find(item => item.id === stepId)
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
      const diffText = await runGitCommand(
        ['show', commit.commitHash, '--stat', '--patch', '--unified=200'],
        project.repositoryPath
      )
      res.json({
        workflowId,
        stepId,
        commitHash: commit.commitHash,
        branch: commit.branch === 'unknown' ? project.defaultBranch : commit.branch,
        message: commit.message,
        diffText
      })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to read diff' })
    }
  }

  const listProjectsHandler: RequestHandler = (_req, res) => {
    res.json({ projects: persistence.projects.list() })
  }

  const createProjectHandler: RequestHandler = (req, res) => {
    const { name, repositoryPath, description, defaultBranch } = req.body ?? {}
    if (!name || typeof name !== 'string' || !repositoryPath || typeof repositoryPath !== 'string') {
      res.status(400).json({ error: 'name and repositoryPath are required' })
      return
    }
    const project = persistence.projects.upsert({
      name: name.trim(),
      repositoryPath: repositoryPath.trim(),
      description: typeof description === 'string' ? description.trim() : undefined,
      defaultBranch: typeof defaultBranch === 'string' && defaultBranch.trim().length ? defaultBranch.trim() : 'main'
    })
    res.status(201).json(project)
  }

  const listWorkflowsHandler: RequestHandler = (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined
    const workflows = workflowRuntime.listWorkflows(projectId)
    const payload = workflows.map(workflow => ({
      workflow,
      steps: persistence.workflowSteps.listByWorkflow(workflow.id)
    }))
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
    const workflow = workflowRuntime.createWorkflowFromPlan({ projectId, plannerRun })
    if (autoStart) {
      workflowRuntime.startWorkflow(workflow.id)
    }
    const detail = workflowRuntime.getWorkflowDetail(workflow.id)
    res.status(201).json(detail ?? { workflow })
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
    workflowRuntime.startWorkflow(workflowId)
    res.json({ workflowId, status: 'running' })
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
    res.json(detail)
  }

  const listCodeSessionsHandler: RequestHandler = (_req, res) => {
    res.json({ sessions: persistence.codeServerSessions.listActive() })
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true })
  })

  app.get('/api/projects', listProjectsHandler)
  app.get('/api/projects/:projectId/graph', repositoryGraphHandler)
  app.post('/api/projects', createProjectHandler)
  app.get('/api/workflows', listWorkflowsHandler)
  app.post('/api/workflows', createWorkflowHandler)
  app.post('/api/workflows/:workflowId/start', startWorkflowHandler)
  app.get('/api/workflows/:workflowId', workflowDetailHandler)
  app.get('/api/workflows/:workflowId/steps/:stepId/diff', workflowStepDiffHandler)
  app.get('/api/code-server/sessions', listCodeSessionsHandler)
  app.post('/api/agent/run', agentRunHandler)

  app.use('/code-server/:sessionId', codeServerProxyHandler)

  const handleUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const sessionIdFromUrl = extractSessionIdFromUrl(req.url)
    if (!sessionIdFromUrl) {
      socket.destroy()
      return
    }
    const session = activeCodeServers.get(sessionIdFromUrl)
    if (!session?.proxy.upgrade) {
      socket.destroy()
      return
    }
    session.proxy.upgrade(req, socket, head)
  }

  const start = (port = defaultPort) => {
    const server = app.listen(port, () => {
      console.log(`UI server listening on http://localhost:${port}`)
    })
    server.on('upgrade', handleUpgrade)
    return server
  }

  const shutdownApp = async () => {
    await shutdownAllCodeServers()
    if (manageWorkerLifecycle) {
      await workflowRuntime.stopWorker()
    }
    if (managePersistenceLifecycle) {
      persistence.db.close()
    }
    if (manageRadicleLifecycle) {
      await radicleModule.cleanup()
    }
  }

  return {
    app,
    start,
    shutdown: shutdownApp,
    getActiveSessionIds: () => [...activeCodeServers.keys()],
    handleUpgrade,
    handlers: {
      agentRun: agentRunHandler,
      codeServerProxy: codeServerProxyHandler
    }
  }
}
