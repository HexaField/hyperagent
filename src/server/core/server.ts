import cors from 'cors'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import express from 'express'
import fs from 'fs/promises'
import { spawnSync } from 'node:child_process'
import type { IncomingMessage } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net'
import os from 'os'
import path from 'path'
import { createCodeServerController } from '../../../src/modules/codeServer'
import { createPersistence, type Persistence } from '../../../src/modules/database'
import { detectGitAuthorFromCli } from '../../../src/modules/gitAuthor'
import { createRadicleModule, type RadicleModule } from '../../../src/modules/radicle'
import { createDiffModule } from '../../../src/modules/review/diff'
import { createReviewEngineModule } from '../../../src/modules/review/engine'
import { createPullRequestModule } from '../../../src/modules/review/pullRequest'
import { createDockerReviewRunnerGateway } from '../../../src/modules/review/runnerGateway'
import { createReviewSchedulerModule } from '../../../src/modules/review/scheduler'
import { createTerminalModule, type TerminalModule } from '../../../src/modules/terminal'
import { createWorkflowPolicyFromEnv } from '../../../src/modules/workflowPolicy'
import type { WorkflowRunnerGateway } from '../../../src/modules/workflowRunnerGateway'
import { createDockerWorkflowRunnerGateway } from '../../../src/modules/workflowRunnerGateway'
import { createWorkflowRuntime, type WorkflowRuntime } from '../../../src/modules/workflows'
import type { AgentRunResponse } from '../../modules/agent/agent'
import { runAgentWorkflow, type AgentWorkflowRunOptions } from '../../modules/agent/agent-orchestrator'
import { verifierWorkerWorkflowDefinition, type VerifierWorkerWorkflowResult } from '../../modules/agent/workflows'
import { runGitCommand } from '../../modules/git'
import { createWorkspaceCodeServerRouter } from '../modules/workspaceCodeServer/routes'
import { createWorkspaceNarratorRouter, type NarratorRelay } from '../modules/workspaceNarrator/routes'
import { seedDefaultPersonas } from '../modules/workspaceSessions/personas'
import { createWorkspaceSessionsRouter } from '../modules/workspaceSessions/routes'
import { createWorkspaceSummaryRouter } from '../modules/workspaceSummary/routes'
import { createWorkspaceTerminalModule } from '../modules/workspaceTerminal/module'
import { createWorkflowLogStream } from '../modules/workspaceWorkflows/logStream'
import { createWorkspaceWorkflowsRouter } from '../modules/workspaceWorkflows/routes'
import { createCodeServerProxyHandler, extractCodeServerSessionIdFromUrl } from './codeServerProxy'
import {
  createCodeServerSessionManager,
  type ControllerFactory as CodeServerControllerFactory
} from './codeServerSessionManager'
import {
  CODE_SERVER_HOST,
  DEFAULT_PORT,
  GRAPH_BRANCH_LIMIT,
  GRAPH_COMMITS_PER_BRANCH,
  WORKFLOW_AGENT_MAX_ROUNDS,
  WORKFLOW_AGENT_MODEL,
  WORKFLOW_AGENT_PROVIDER,
  normalizePublicOrigin
} from './config'
import { installProcessErrorHandlers, logFullError, wrapAsync } from './errors'
import { createLogger, toErrorMeta } from './logging'
import { attachJsonStackMiddleware } from './middleware/jsonErrorStack'
import {
  createCodeServerService,
  createReviewSchedulerService,
  createTerminalService,
  createWorkflowRuntimeService,
  startManagedServices,
  stopManagedServices,
  type ManagedService
} from './services'
import { resolveTlsMaterials, type TlsConfig } from './tls'
import { createVersionControlRouter } from './versionControlRoutes'
import { ensureWorkspaceDirectory, initializeWorkspaceRepository, readGitMetadata } from './workspaceGit'
import { loadWebSocketModule, type WebSocketBindings } from './ws'

export type { CodeServerSession, ProxyWithUpgrade } from './codeServerTypes'

type WorkflowRunner = (options: AgentWorkflowRunOptions) => Promise<AgentRunResponse<VerifierWorkerWorkflowResult>>
type ControllerFactory = CodeServerControllerFactory

function ensureWorkflowAgentProviderReady(provider: string | undefined) {
  if (!provider) return
  const binary = resolveWorkflowAgentBinary(provider)
  if (!binary) return
  const check = spawnSync('which', [binary], { stdio: 'ignore' })
  if (check.status !== 0) {
    throw new Error(`Workflow agent provider "${provider}" requires the "${binary}" CLI to be available on PATH`)
  }
}

function resolveWorkflowAgentBinary(provider: string): string | null {
  switch (provider) {
    case 'opencode':
      return 'opencode'
    case 'ollama':
    case 'ollama-cli':
      return 'ollama'
    case 'goose':
      return 'goose'
    default:
      return null
  }
}

export type CreateServerOptions = {
  runWorkflow?: WorkflowRunner
  controllerFactory?: ControllerFactory
  tmpDir?: string
  port?: number
  allocatePort?: () => Promise<number>
  persistence?: Persistence
  persistenceFile?: string
  workflowRuntime?: WorkflowRuntime
  workflowPollIntervalMs?: number
  reviewPollIntervalMs?: number
  radicleModule?: RadicleModule
  terminalModule?: TerminalModule
  workflowRunnerGateway?: WorkflowRunnerGateway
  tls?: TlsConfig
  publicOrigin?: string
  corsOrigin?: string
  webSockets?: WebSocketBindings
  narratorRelay?: NarratorRelay
  // NOTE: old injected coding agent runner/storage/command-runner
  // options have been removed. The router now uses the opencode
  // runtime and provenance helpers directly.
}

export type ServerInstance = {
  app: express.Express
  start: (port?: number) => HttpsServer
  shutdown: () => Promise<void>
  getActiveSessionIds: () => string[]
  handleUpgrade: (req: IncomingMessage, socket: Socket, head: Buffer) => void
  handlers: {
    codeServerProxy: RequestHandler
  }
}

const serverLogger = createLogger('ui/server/core/server', { service: 'ui-server' })

export async function createServerApp(options: CreateServerOptions = {}): Promise<ServerInstance> {
  const lifecycleLogger = serverLogger.child({ scope: 'lifecycle' })
  const agentLogger = serverLogger.child({ scope: 'agent-run' })
  const codeServerLogger = serverLogger.child({ scope: 'code-server' })
  const runnerAuthLogger = serverLogger.child({ scope: 'runner-auth' })
  const wsModule = options.webSockets ?? (await loadWebSocketModule())
  const WebSocketCtor = wsModule.WebSocket
  const WebSocketServerCtor = wsModule.WebSocketServer
  const runWorkflow =
    options.runWorkflow ?? ((runnerOptions) => runAgentWorkflow(verifierWorkerWorkflowDefinition, runnerOptions))
  const controllerFactory = options.controllerFactory ?? createCodeServerController
  const tmpDir = options.tmpDir ?? os.tmpdir()
  const defaultPort = options.port ?? DEFAULT_PORT
  const defaultCertPath = process.env.UI_TLS_CERT_PATH ?? path.resolve(process.cwd(), 'certs/hyperagent.cert.pem')
  const defaultKeyPath = process.env.UI_TLS_KEY_PATH ?? path.resolve(process.cwd(), 'certs/hyperagent.key.pem')
  const tlsMaterials = await resolveTlsMaterials({
    cert: options.tls?.cert,
    key: options.tls?.key,
    certPath: options.tls?.certPath ?? defaultCertPath,
    keyPath: options.tls?.keyPath ?? defaultKeyPath
  })
  const publicOrigin =
    normalizePublicOrigin(options.publicOrigin ?? process.env.UI_PUBLIC_ORIGIN ?? null) ??
    normalizePublicOrigin(process.env.UI_PUBLIC_HOST ?? null)
  const corsOrigin = options.corsOrigin ?? process.env.UI_CORS_ORIGIN ?? publicOrigin ?? undefined
  const frameAncestorOrigin =
    normalizePublicOrigin(process.env.UI_FRAME_ANCESTOR ?? null) ?? corsOrigin ?? publicOrigin ?? null
  const allocatePort =
    options.allocatePort ??
    (async () =>
      await new Promise<number>((resolve, reject) => {
        const server = createNetServer()
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
      tempRootDir: process.env.RADICLE_TEMP_DIR,
      radCliPath: process.env.RADICLE_CLI_PATH
    })

  const maxTerminalSessionsEnv = process.env.TERMINAL_MAX_SESSIONS ?? process.env.TERMINAL_MAX_SESSIONS_PER_USER
  const normalizedMaxTerminalSessions = (() => {
    if (!maxTerminalSessionsEnv) return undefined
    const parsed = Number(maxTerminalSessionsEnv)
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
  })()

  const manageTerminalLifecycle = !options.terminalModule
  const terminalModule =
    options.terminalModule ??
    createTerminalModule({
      config: {
        defaultShell: process.env.TERMINAL_DEFAULT_SHELL ?? process.env.SHELL ?? '/bin/bash',
        defaultCwd: process.env.TERMINAL_DEFAULT_CWD ?? process.cwd(),
        maxSessionsPerUser: normalizedMaxTerminalSessions,
        env: process.env
      },
      repository: persistence.terminalSessions
    })

  const gitAuthor = detectGitAuthorFromCli()
  const commitAuthor = {
    name: gitAuthor?.name ?? process.env.WORKFLOW_AUTHOR_NAME ?? 'Hyperagent Workflow',
    email: gitAuthor?.email ?? process.env.WORKFLOW_AUTHOR_EMAIL ?? 'workflow@hyperagent.local'
  }

  const applyPatchToBranch = async (
    repositoryPath: string,
    branch: string,
    patch: string,
    commitMessage: string
  ): Promise<string> => {
    const repoPath = path.resolve(repositoryPath)
    const scratchDir = await fs.mkdtemp(path.join(tmpDir, 'review-patch-'))
    const patchFile = path.join(scratchDir, 'suggestion.patch')
    await fs.writeFile(patchFile, patch, 'utf8')
    const currentBranch = await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath).catch(() => null)
    try {
      await runGitCommand(['checkout', branch], repoPath)
      await runGitCommand(['apply', '--whitespace=fix', '--index', patchFile], repoPath)
      const authorFlag = `${commitAuthor.name} <${commitAuthor.email}>`
      await runGitCommand(['commit', '-m', commitMessage, `--author=${authorFlag}`], repoPath)
      const commitHash = (await runGitCommand(['rev-parse', 'HEAD'], repoPath)).trim()
      return commitHash
    } finally {
      if (currentBranch && currentBranch !== branch) {
        await runGitCommand(['checkout', currentBranch], repoPath).catch(() => undefined)
      }
      await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  ensureWorkflowAgentProviderReady(WORKFLOW_AGENT_PROVIDER)

  const workflowAgentExecutorOptions = {
    runWorkflow,
    provider: WORKFLOW_AGENT_PROVIDER,
    model: WORKFLOW_AGENT_MODEL,
    maxRounds: WORKFLOW_AGENT_MAX_ROUNDS
  }

  const workflowPolicy = createWorkflowPolicyFromEnv(process.env)
  const workflowLogStream = createWorkflowLogStream()

  const workflowCallbackBaseUrl =
    process.env.WORKFLOW_CALLBACK_BASE_URL ?? `https://host.docker.internal:${defaultPort}`
  const workflowRunnerToken = process.env.WORKFLOW_RUNNER_TOKEN ?? process.env.WORKFLOW_CALLBACK_TOKEN ?? null
  const workflowRunnerGateway =
    options.workflowRunnerGateway ??
    createDockerWorkflowRunnerGateway({
      dockerBinary: process.env.WORKFLOW_DOCKER_BINARY,
      image: process.env.WORKFLOW_RUNNER_IMAGE,
      callbackBaseUrl: workflowCallbackBaseUrl,
      callbackToken: workflowRunnerToken ?? undefined,
      timeoutMs: process.env.WORKFLOW_RUNNER_TIMEOUT ? Number(process.env.WORKFLOW_RUNNER_TIMEOUT) : undefined,
      caCertPath: process.env.WORKFLOW_RUNNER_CA_PATH ?? defaultCertPath,
      onLog: (event) => {
        workflowLogStream.ingestRunnerChunk({
          workflowId: event.workflowId,
          stepId: event.stepId,
          runnerInstanceId: event.runnerInstanceId,
          stream: event.stream,
          line: event.line
        })
      }
    })

  const pullRequestModule = createPullRequestModule({
    projects: persistence.projects,
    pullRequests: persistence.pullRequests,
    pullRequestCommits: persistence.pullRequestCommits,
    pullRequestEvents: persistence.pullRequestEvents
  })

  const manageWorkerLifecycle = !options.workflowRuntime
  const workflowRuntime =
    options.workflowRuntime ??
    createWorkflowRuntime({
      persistence,
      persistenceFilePath: persistence.db.name,
      pollIntervalMs: options.workflowPollIntervalMs,
      radicle: radicleModule,
      commitAuthor,
      agentExecutorOptions: workflowAgentExecutorOptions,
      runnerGateway: workflowRunnerGateway,
      pullRequestModule,
      policy: workflowPolicy
    })
  const reviewCallbackBaseUrl = process.env.REVIEW_CALLBACK_BASE_URL ?? `https://host.docker.internal:${defaultPort}`
  const reviewRunnerToken = process.env.REVIEW_RUNNER_TOKEN ?? process.env.REVIEW_CALLBACK_TOKEN ?? null
  const reviewRunnerGateway = createDockerReviewRunnerGateway({
    dockerBinary: process.env.REVIEW_DOCKER_BINARY,
    image: process.env.REVIEW_RUNNER_IMAGE,
    callbackBaseUrl: reviewCallbackBaseUrl,
    callbackToken: reviewRunnerToken ?? undefined,
    logsDir: process.env.REVIEW_RUNNER_LOGS_DIR,
    timeoutMs: process.env.REVIEW_RUNNER_TIMEOUT ? Number(process.env.REVIEW_RUNNER_TIMEOUT) : undefined
  })
  const diffModule = createDiffModule()
  const reviewEngine = createReviewEngineModule()
  const reviewScheduler = createReviewSchedulerModule({
    reviewRuns: persistence.reviewRuns,
    reviewThreads: persistence.reviewThreads,
    reviewComments: persistence.reviewComments,
    pullRequestEvents: persistence.pullRequestEvents,
    pullRequestModule,
    diffModule,
    reviewEngine,
    runnerGateway: reviewRunnerGateway,
    pollIntervalMs: options.reviewPollIntervalMs
  })

  const app = express()
  const corsMiddleware = corsOrigin ? cors({ origin: corsOrigin, credentials: true }) : cors()
  app.use(corsMiddleware)
  app.use(express.json({ limit: '1mb' }))

  // Attach stack traces to JSON error responses when handlers only set `{ error }`.
  app.use(attachJsonStackMiddleware())

  const codeServerSessionManager = createCodeServerSessionManager({
    controllerFactory,
    allocatePort,
    persistence,
    publicOrigin,
    corsOrigin,
    frameAncestorOrigin,
    logger: codeServerLogger
  })
  const codeServerProxyHandler = createCodeServerProxyHandler({
    getSession: (sessionId) => codeServerSessionManager.getSession(sessionId)
  })

  const DEFAULT_TERMINAL_USER_ID = process.env.TERMINAL_DEFAULT_USER_ID ?? 'anonymous'
  const USER_ID_HEADER_KEYS = ['x-user-id', 'x-user', 'x-hyperagent-user'] as const

  const pickUserIdValue = (value: string | string[] | undefined): string | null => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry !== 'string') continue
        const trimmed = entry.trim()
        if (trimmed.length) return trimmed
      }
      return null
    }
    if (typeof value === 'string') {
      const trimmed = value.trim()
      return trimmed.length ? trimmed : null
    }
    return null
  }

  const resolveUserIdFromHeaders = (headers: IncomingMessage['headers']): string => {
    for (const key of USER_ID_HEADER_KEYS) {
      const candidate = pickUserIdValue(headers[key])
      if (candidate) return candidate
    }
    return DEFAULT_TERMINAL_USER_ID
  }

  const resolveUserIdFromRequest = (req: Request): string => {
    return resolveUserIdFromHeaders(req.headers)
  }

  const validateReviewRunnerToken = (req: Request): boolean => {
    if (!reviewRunnerToken) return true
    const value = pickUserIdValue(req.headers['x-review-runner-token'])
    const valid = value === reviewRunnerToken
    if (!valid) {
      runnerAuthLogger.warn('Review runner token rejected', {
        kind: 'review',
        event: 'runner_token_invalid',
        remoteAddress: req.ip ?? req.socket.remoteAddress ?? null,
        path: req.originalUrl
      })
    }
    return valid
  }

  const validateWorkflowRunnerToken = (req: Request): boolean => {
    if (!workflowRunnerToken) return true
    const value = pickUserIdValue(req.headers['x-workflow-runner-token'])
    const valid = value === workflowRunnerToken
    if (!valid) {
      runnerAuthLogger.warn('Workflow runner token rejected', {
        kind: 'workflow',
        event: 'runner_token_invalid',
        remoteAddress: req.ip ?? req.socket.remoteAddress ?? null,
        path: req.originalUrl
      })
    }
    return valid
  }

  const workspaceSummaryRouter = createWorkspaceSummaryRouter({
    wrapAsync,
    persistence,
    radicleModule,
    workflowRuntime,
    readGitMetadata,
    runGitCommand,
    graphBranchLimit: GRAPH_BRANCH_LIMIT,
    graphCommitsPerBranch: GRAPH_COMMITS_PER_BRANCH,
    initializeWorkspaceRepository
  })

  const workspaceSessionsRouter = createWorkspaceSessionsRouter({
    wrapAsync
  })

  const workspaceNarratorRouter = createWorkspaceNarratorRouter({
    wrapAsync,
    narratorRelay: options.narratorRelay
  })

  const workspaceWorkflowsRouter = createWorkspaceWorkflowsRouter({
    wrapAsync,
    workflowRuntime,
    persistence,
    runGitCommand,
    validateWorkflowRunnerToken,
    workflowLogStream
  })

  const workspaceCodeServerRouter = createWorkspaceCodeServerRouter({
    wrapAsync,
    persistence,
    ensureWorkspaceDirectory,
    ensureProjectCodeServer: async (project) => {
      const session = await codeServerSessionManager.ensureProjectSession(project)
      if (!session) return null
      return {
        id: session.id,
        publicUrl: session.publicUrl,
        dir: session.dir,
        branch: session.branch
      }
    }
  })

  const workspaceTerminalModule = createWorkspaceTerminalModule({
    wrapAsync,
    terminalModule,
    WebSocketCtor,
    WebSocketServerCtor,
    resolveUserIdFromRequest,
    resolveUserIdFromHeaders
  })

  const versionControlRouter = createVersionControlRouter({
    wrapAsync,
    persistence,
    pullRequestModule,
    reviewScheduler,
    diffModule,
    applyPatchToBranch,
    resolveUserIdFromRequest,
    validateReviewRunnerToken
  })

  const managedServices: ManagedService[] = [
    createWorkflowRuntimeService({ runtime: workflowRuntime, manageLifecycle: manageWorkerLifecycle }),
    createReviewSchedulerService(reviewScheduler),
    createTerminalService(workspaceTerminalModule),
    createCodeServerService({ shutdownAllCodeServers: () => codeServerSessionManager.shutdownAll() })
  ]

  await startManagedServices(managedServices)

  installProcessErrorHandlers()

  // Ensure built-in personas exist so users have sensible defaults.
  try {
    await seedDefaultPersonas()
  } catch (err) {
    serverLogger.warn('Failed to seed default personas', { error: toErrorMeta(err) })
  }

  app.get(
    '/api/health',
    wrapAsync((_req, res) => {
      res.json({ ok: true })
    })
  )

  app.get(
    '/api/health/workflows',
    wrapAsync((_req, res) => {
      const metrics = persistence.workflowSteps.getQueueMetrics()
      const deadLetters = persistence.workflowRunnerDeadLetters.listRecent(20)
      const events = persistence.workflowRunnerEvents.listRecent(100)
      res.json({ ok: true, metrics, deadLetters, events })
    })
  )

  app.get(
    '/api/health/radicle',
    wrapAsync(async (_req, res) => {
      const status = await radicleModule.getStatus()
      const registrations = persistence.radicleRegistrations.list()
      res.json({
        ok: status.reachable && status.loggedIn,
        status,
        registrations
      })
    })
  )

  app.get(
    '/api/templates',
    wrapAsync(async (_req, res) => {
      const templatesDir = path.resolve(process.cwd(), 'templates')
      let dirEntries
      try {
        dirEntries = await fs.readdir(templatesDir, { withFileTypes: true })
      } catch (err) {
        serverLogger.warn('Templates directory not found', { dir: templatesDir, error: toErrorMeta(err) })
        res.json({ templates: [] })
        return
      }

      const templates: Array<{
        id: string
        name: string
        description: string | null
        manifest?: Record<string, unknown> | null
      }> = []

      for (const entry of dirEntries) {
        if (!entry.isDirectory()) continue
        const id = entry.name
        const manifestPath = path.join(templatesDir, id, 'template.json')
        let manifest: Record<string, unknown> | null = null
        try {
          const raw = await fs.readFile(manifestPath, 'utf8')
          manifest = JSON.parse(raw)
        } catch (err) {
          serverLogger.warn('Failed to read template manifest', { id, manifestPath, error: toErrorMeta(err) })
        }
        templates.push({
          id,
          name: (manifest && (manifest.name as string)) ?? id,
          description: (manifest && (manifest.description as string)) ?? null,
          manifest
        })
      }

      res.json({ templates })
    })
  )

  app.use(workspaceSummaryRouter)
  app.use(workspaceSessionsRouter)
  app.use(workspaceNarratorRouter)
  app.use(workspaceWorkflowsRouter)
  app.use(workspaceCodeServerRouter)
  app.use(workspaceTerminalModule.router)

  app.use(versionControlRouter)

  app.use('/code-server/:sessionId', codeServerProxyHandler)

  // Express error handler: log full error and return stack to client
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    try {
      logFullError(err, { method: req.method, url: req.originalUrl, label: 'expressErrorMiddleware' })
    } catch {
      // ignore
    }
    if (res.headersSent) {
      // Delegate to default Express error handler if headers already sent
      next(err as any)
      return
    }
    const message = err instanceof Error ? err.message : 'Internal server error'
    const stack = err instanceof Error ? err.stack : String(err)
    res.status(500).json({ error: message, stack })
  })

  const handleUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (workspaceTerminalModule.matchesUpgrade(req)) {
      workspaceTerminalModule.handleUpgrade(req, socket, head)
      return
    }
    const sessionIdFromUrl = extractCodeServerSessionIdFromUrl(req.url)
    if (!sessionIdFromUrl) {
      socket.destroy()
      return
    }
    const session = codeServerSessionManager.getSession(sessionIdFromUrl)
    if (!session?.proxy.upgrade) {
      socket.destroy()
      return
    }
    session.proxy.upgrade(req, socket, head)
  }

  const start = (port = defaultPort): HttpsServer => {
    const server = createHttpsServer({ key: tlsMaterials.key, cert: tlsMaterials.cert }, app)
    server.on('upgrade', handleUpgrade)
    server.listen(port, () => {
      lifecycleLogger.info('UI server listening', { port })
    })
    return server
  }

  const shutdownApp = async () => {
    await stopManagedServices(managedServices)
    if (managePersistenceLifecycle) {
      persistence.db.close()
    }
    if (manageRadicleLifecycle) {
      await radicleModule.cleanup()
    }
    if (manageTerminalLifecycle) {
      await terminalModule.cleanup()
    }
  }

  return {
    app,
    start,
    shutdown: shutdownApp,
    getActiveSessionIds: () => codeServerSessionManager.listSessionIds(),
    handleUpgrade,
    handlers: {
      codeServerProxy: codeServerProxyHandler
    }
  }
}
