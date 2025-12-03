import cors from 'cors'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import express from 'express'
import fs from 'fs/promises'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { spawn, spawnSync } from 'node:child_process'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net'
import os from 'os'
import path from 'path'
import { runVerifierWorkerLoop, type AgentStreamEvent } from '../../../src/modules/agent'
import {
  createCodeServerController,
  type CodeServerController,
  type CodeServerOptions
} from '../../../src/modules/codeServer'
import { createPersistence, type Persistence, type ProjectRecord } from '../../../src/modules/database'
import { detectGitAuthorFromCli } from '../../../src/modules/gitAuthor'
import type { Provider } from '../../../src/modules/llm'
import type {
  CodingAgentCommandOptions,
  CodingAgentCommandResult,
  CodingAgentCommandRunner
} from '../../../src/modules/opencodeCommandRunner'
import {
  createCodingAgentRunner,
  createCodingAgentStorage,
  type CodingAgentRunner,
  type CodingAgentStorage
} from '../../../src/modules/provider'
import { createRadicleModule, type RadicleModule } from '../../../src/modules/radicle'
import { createDiffModule } from '../../../src/modules/review/diff'
import { createReviewEngineModule } from '../../../src/modules/review/engine'
import { createPullRequestModule } from '../../../src/modules/review/pullRequest'
import { createDockerReviewRunnerGateway } from '../../../src/modules/review/runnerGateway'
import { createReviewSchedulerModule } from '../../../src/modules/review/scheduler'
import type { ReviewRunTrigger } from '../../../src/modules/review/types'
import { createTerminalModule, type TerminalModule } from '../../../src/modules/terminal'
import { createWorkflowPolicyFromEnv } from '../../../src/modules/workflowPolicy'
import type { WorkflowRunnerGateway } from '../../../src/modules/workflowRunnerGateway'
import { createDockerWorkflowRunnerGateway } from '../../../src/modules/workflowRunnerGateway'
import { createWorkflowRuntime, type WorkflowRuntime } from '../../../src/modules/workflows'
import { runGitCommand } from '../../modules/git'
import { createSseStream } from '../lib/sse'
import { createWorkspaceCodeServerRouter } from '../modules/workspaceCodeServer/routes'
import { createWorkspaceNarratorRouter, type NarratorRelay } from '../modules/workspaceNarrator/routes'
import { seedDefaultPersonas } from '../modules/workspaceSessions/personas'
import { createWorkspaceSessionsRouter } from '../modules/workspaceSessions/routes'
import { createWorkspaceSummaryRouter } from '../modules/workspaceSummary/routes'
import { createWorkspaceTerminalModule } from '../modules/workspaceTerminal/module'
import { createWorkflowLogStream } from '../modules/workspaceWorkflows/logStream'
import { createWorkspaceWorkflowsRouter } from '../modules/workspaceWorkflows/routes'
import {
  CODE_SERVER_HOST,
  DEFAULT_PORT,
  GRAPH_BRANCH_LIMIT,
  GRAPH_COMMITS_PER_BRANCH,
  WORKFLOW_AGENT_MAX_ROUNDS,
  WORKFLOW_AGENT_MODEL,
  WORKFLOW_AGENT_PROVIDER,
  buildExternalUrl,
  mergeFrameAncestorsDirective,
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
import { ensureWorkspaceDirectory, initializeWorkspaceRepository, readGitMetadata } from './workspaceGit'
import { loadWebSocketModule, type WebSocketBindings } from './ws'

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

function ensureWorkflowAgentProviderReady(provider: Provider | undefined) {
  if (!provider) return
  const binary = resolveWorkflowAgentBinary(provider)
  if (!binary) return
  const check = spawnSync('which', [binary], { stdio: 'ignore' })
  if (check.status !== 0) {
    throw new Error(`Workflow agent provider "${provider}" requires the "${binary}" CLI to be available on PATH`)
  }
}

function resolveWorkflowAgentBinary(provider: Provider): string | null {
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
  runLoop?: RunLoop
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
  codingAgentStorage?: CodingAgentStorage
  codingAgentRunner?: CodingAgentRunner
  codingAgentCommandRunner?: CodingAgentCommandRunner
  webSockets?: WebSocketBindings
  narratorRelay?: NarratorRelay
}

export type ServerInstance = {
  app: express.Express
  start: (port?: number) => HttpsServer
  shutdown: () => Promise<void>
  getActiveSessionIds: () => string[]
  handleUpgrade: (req: IncomingMessage, socket: Socket, head: Buffer) => void
  handlers: {
    agentRun: RequestHandler
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
  const runLoop = options.runLoop ?? runVerifierWorkerLoop
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

  const codingAgentStorage = options.codingAgentStorage ?? createCodingAgentStorage()
  const codingAgentRunner = options.codingAgentRunner ?? createCodingAgentRunner()
  const codingAgentCommandRunner =
    options.codingAgentCommandRunner ??
    (async (args: string[], commandOptions?: CodingAgentCommandOptions) =>
      await runCodingAgentCli(args, commandOptions))

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
    runLoop,
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
  persistence.codeServerSessions.resetAllRunning()

  const app = express()
  const corsMiddleware = corsOrigin ? cors({ origin: corsOrigin, credentials: true }) : cors()
  app.use(corsMiddleware)
  app.use(express.json({ limit: '1mb' }))

  // Attach stack traces to JSON error responses when handlers only set `{ error }`.
  app.use(attachJsonStackMiddleware())

  const activeCodeServers = new Map<string, CodeServerSession>()
  const applyProxyResponseHeaders = (proxyRes: IncomingMessage, _req: IncomingMessage, res: Response) => {
    if (corsOrigin) {
      proxyRes.headers['access-control-allow-origin'] = corsOrigin
      proxyRes.headers['access-control-allow-credentials'] = 'true'
      res.setHeader('Access-Control-Allow-Origin', corsOrigin)
      res.setHeader('Access-Control-Allow-Credentials', 'true')
    }
    if (frameAncestorOrigin) {
      const merged = mergeFrameAncestorsDirective(proxyRes.headers['content-security-policy'], frameAncestorOrigin)
      proxyRes.headers['content-security-policy'] = merged
      res.setHeader('Content-Security-Policy', merged)
    } else if (proxyRes.headers['content-security-policy']) {
      res.setHeader('Content-Security-Policy', proxyRes.headers['content-security-policy'] as string)
    }
    delete proxyRes.headers['x-frame-options']
    res.removeHeader('X-Frame-Options')
  }

  const deriveProjectSessionId = (projectId: string) => `project-${projectId}`

  const normalizeBranchName = (value?: string | null) => {
    if (typeof value === 'string' && value.trim().length) {
      return value.trim()
    }
    return 'main'
  }

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

  function ensureEphemeralProject(sessionId: string, sessionDir: string): ProjectRecord {
    return {
      id: `session-${sessionId}`,
      name: `Session ${sessionId}`,
      description: null,
      repositoryPath: sessionDir,
      repositoryProvider: 'ephemeral',
      defaultBranch: 'main',
      createdAt: new Date().toISOString()
    }
  }

  function normalizeReviewTrigger(value: unknown): ReviewRunTrigger {
    if (value === 'auto_on_open' || value === 'auto_on_update') {
      return value
    }
    return 'manual'
  }

  function rewriteCodeServerPath(pathName: string, sessionId: string): string {
    const prefix = `/code-server/${sessionId}`
    if (!pathName.startsWith(prefix)) return pathName
    const trimmed = pathName.slice(prefix.length)
    return trimmed.length ? trimmed : '/'
  }

  async function runCodingAgentCli(
    args: string[],
    commandOptions?: CodingAgentCommandOptions
  ): Promise<CodingAgentCommandResult> {
    return await new Promise((resolve, reject) => {
      const child = spawn('opencode', args, {
        cwd: commandOptions?.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      child.once('error', reject)
      child.once('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr })
          return
        }
        const message = stderr.trim() || stdout.trim() || `opencode ${args.join(' ')} failed with code ${code}`
        reject(new Error(message))
      })
    })
  }

  type CodeServerWorkspaceOptions = {
    sessionId: string
    sessionDir: string
    project: ProjectRecord
    branch?: string | null
  }

  async function startCodeServerWorkspace(options: CodeServerWorkspaceOptions): Promise<CodeServerSession | null> {
    if (activeCodeServers.has(options.sessionId)) {
      return activeCodeServers.get(options.sessionId) ?? null
    }

    try {
      const branch = normalizeBranchName(options.branch ?? options.project.defaultBranch)
      const port = await allocatePort()
      const basePath = `/code-server/${options.sessionId}`
      const controller = controllerFactory({
        host: CODE_SERVER_HOST,
        port,
        repoRoot: options.sessionDir,
        publicBasePath: basePath
      })
      const handle = await controller.ensure()
      if (!handle) {
        throw new Error('code-server failed to start')
      }
      const sessionPublicUrl = buildExternalUrl(handle.publicUrl, publicOrigin) ?? handle.publicUrl

      const targetBase = `http://${CODE_SERVER_HOST}:${port}`
      const rewriteProxyOriginHeader = (proxyReq: ClientRequest) => {
        if (!proxyReq.hasHeader('origin')) return
        proxyReq.setHeader('origin', targetBase)
      }

      const proxy = createProxyMiddleware({
        target: targetBase,
        changeOrigin: true,
        ws: true,
        pathRewrite: (pathName: string) => rewriteCodeServerPath(pathName, options.sessionId),
        on: {
          proxyRes: applyProxyResponseHeaders,
          proxyReq: (proxyReq: ClientRequest) => {
            rewriteProxyOriginHeader(proxyReq)
          },
          proxyReqWs: (proxyReq: ClientRequest) => {
            rewriteProxyOriginHeader(proxyReq)
          }
        }
      } as any) as ProxyWithUpgrade

      const session: CodeServerSession = {
        id: options.sessionId,
        dir: options.sessionDir,
        basePath,
        projectId: options.project.id,
        branch,
        controller,
        proxy,
        publicUrl: sessionPublicUrl
      }
      activeCodeServers.set(options.sessionId, session)
      persistence.codeServerSessions.upsert({
        id: options.sessionId,
        projectId: options.project.id,
        branch,
        workspacePath: options.sessionDir,
        url: sessionPublicUrl,
        authToken: 'none',
        processId: handle.child.pid ?? null
      })
      return session
    } catch (error) {
      codeServerLogger.warn('Unable to launch code-server session', {
        sessionId: options.sessionId,
        projectId: options.project.id,
        error: toErrorMeta(error)
      })
      return null
    }
  }

  async function ensureProjectCodeServer(project: ProjectRecord): Promise<CodeServerSession | null> {
    return await startCodeServerWorkspace({
      sessionId: deriveProjectSessionId(project.id),
      sessionDir: project.repositoryPath,
      project,
      branch: project.defaultBranch
    })
  }

  async function startCodeServerForSession(sessionId: string, sessionDir: string): Promise<CodeServerSession | null> {
    const project = ensureEphemeralProject(sessionId, sessionDir)
    return await startCodeServerWorkspace({ sessionId, sessionDir, project, branch: project.defaultBranch })
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
    const { prompt, provider, model, maxRounds, projectId } = req.body ?? {}
    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'prompt is required' })
      return
    }

    let project: ProjectRecord | null = null
    if (typeof projectId === 'string' && projectId.trim().length) {
      project = persistence.projects.getById(projectId.trim())
      if (!project) {
        res.status(404).json({ error: 'Unknown project' })
        return
      }
      try {
        await ensureWorkspaceDirectory(project.repositoryPath)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Project repository path is unavailable'
        res.status(400).json({ error: message })
        return
      }
    }

    const sse = createSseStream(res, req)
    let closed = false
    let sessionId: string | null = null
    let sessionDir: string | null = null
    let shouldShutdownCodeServer = !project
    sse.onClose(() => {
      closed = true
      if (sessionId && shouldShutdownCodeServer) {
        void shutdownCodeServerSession(sessionId)
      }
    })

    const emit = (packet: Record<string, unknown>) => {
      if (closed) return
      sse.emit(packet)
    }

    if (project) {
      sessionDir = project.repositoryPath
      sessionId = `project-run-${project.id}-${Date.now().toString(36)}`
    } else {
      sessionDir = await fs.mkdtemp(path.join(tmpDir, 'hyperagent-session-'))
      sessionId = path.basename(sessionDir)
    }

    if (!sessionId || !sessionDir) {
      throw new Error('Unable to initialize agent workspace')
    }

    const codeServerSession = project
      ? await ensureProjectCodeServer(project)
      : await startCodeServerForSession(sessionId, sessionDir)

    agentLogger.info('Session ready', {
      sessionId,
      projectId: project?.id ?? null,
      workspaceDir: sessionDir,
      codeServerSessionId: codeServerSession?.id ?? null
    })
    emit({
      type: 'session',
      payload: {
        sessionDir,
        sessionId,
        codeServerUrl: codeServerSession?.publicUrl ?? null,
        projectId: project?.id ?? codeServerSession?.projectId ?? null,
        branch: project?.defaultBranch ?? codeServerSession?.branch ?? null
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

      agentLogger.info('Agent loop started', {
        sessionId,
        projectId: project?.id ?? null,
        provider: providerToUse ?? null,
        model: modelToUse ?? null
      })
      const result = await runLoop({
        userInstructions: prompt,
        provider: providerToUse,
        model: modelToUse,
        maxRounds: normalizedMaxRounds,
        sessionDir: sessionDir ?? undefined,
        onStream: streamHandler
      })
      agentLogger.info('Agent loop completed', {
        sessionId,
        projectId: project?.id ?? null
      })
      emit({ type: 'result', payload: result })
    } catch (error: unknown) {
      logFullError(error, { method: req.method, url: req.originalUrl, label: 'agentRunHandler' })
      const message = error instanceof Error ? error.message : 'Agent loop failed'
      const stack = error instanceof Error ? (error.stack ?? null) : String(error)
      if (!closed) {
        emit({
          type: 'error',
          payload: {
            message,
            stack
          }
        })
      }
    } finally {
      if (!closed) {
        agentLogger.debug('Emitting end frame', { sessionId })
        emit({ type: 'end' })
        agentLogger.debug('Ending response', { sessionId })
        res.end()
      }
      if (sessionId && shouldShutdownCodeServer) {
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

  const listProjectPullRequestsHandler: RequestHandler = (req, res) => {
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
    const pullRequests = pullRequestModule.listPullRequests(projectId).map((pullRequest) => {
      const runs = persistence.reviewRuns.listByPullRequest(pullRequest.id)
      return {
        ...pullRequest,
        latestReviewRun: runs.length ? runs[0] : null
      }
    })
    res.json({ project, pullRequests })
  }

  const listActiveReviewsHandler: RequestHandler = (_req, res) => {
    const projects = persistence.projects.list()
    const groups: Array<{ project: ProjectRecord; pullRequests: Array<Record<string, unknown>> }> = []
    projects.forEach((project) => {
      const pullRequests = pullRequestModule
        .listPullRequests(project.id)
        .filter((pullRequest) => pullRequest.status === 'open')
        .map((pullRequest) => {
          const runs = persistence.reviewRuns.listByPullRequest(pullRequest.id)
          return {
            ...pullRequest,
            latestReviewRun: runs.length ? runs[0] : null
          }
        })
      if (pullRequests.length) {
        groups.push({ project, pullRequests })
      }
    })
    res.json({ groups })
  }

  const createProjectPullRequestHandler: RequestHandler = async (req, res) => {
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
    const { title, description, sourceBranch, targetBranch, radiclePatchId } = req.body ?? {}
    if (typeof title !== 'string' || !title.trim().length) {
      res.status(400).json({ error: 'title is required' })
      return
    }
    if (typeof sourceBranch !== 'string' || !sourceBranch.trim().length) {
      res.status(400).json({ error: 'sourceBranch is required' })
      return
    }
    const authorUserId = resolveUserIdFromRequest(req)
    try {
      const record = await pullRequestModule.createPullRequest({
        projectId: project.id,
        title: title.trim(),
        description: typeof description === 'string' ? description : undefined,
        sourceBranch: sourceBranch.trim(),
        targetBranch: typeof targetBranch === 'string' && targetBranch.trim().length ? targetBranch.trim() : undefined,
        radiclePatchId:
          typeof radiclePatchId === 'string' && radiclePatchId.trim().length ? radiclePatchId.trim() : undefined,
        authorUserId
      })
      res.status(201).json({ pullRequest: record })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create pull request'
      res.status(500).json({ error: message })
    }
  }

  const pullRequestDetailHandler: RequestHandler = async (req, res) => {
    const prId = req.params.prId
    if (!prId) {
      res.status(400).json({ error: 'pull request id is required' })
      return
    }
    const detail = await pullRequestModule.getPullRequestWithCommits(prId)
    if (!detail) {
      res.status(404).json({ error: 'Unknown pull request' })
      return
    }
    const reviewRuns = persistence.reviewRuns.listByPullRequest(prId)
    res.json({
      project: detail.project,
      pullRequest: detail.pullRequest,
      commits: detail.commits,
      events: detail.events,
      reviewRuns
    })
  }

  const pullRequestDiffHandler: RequestHandler = async (req, res) => {
    const prId = req.params.prId
    if (!prId) {
      res.status(400).json({ error: 'pull request id is required' })
      return
    }
    const detail = await pullRequestModule.getPullRequestWithCommits(prId)
    if (!detail) {
      res.status(404).json({ error: 'Unknown pull request' })
      return
    }
    try {
      const diff = await diffModule.getPullRequestDiff(detail.pullRequest, detail.project)
      res.json({ pullRequestId: prId, diff })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to compute diff'
      res.status(500).json({ error: message })
    }
  }

  const pullRequestThreadsHandler: RequestHandler = (req, res) => {
    const prId = req.params.prId
    if (!prId) {
      res.status(400).json({ error: 'pull request id is required' })
      return
    }
    const pullRequest = persistence.pullRequests.getById(prId)
    if (!pullRequest) {
      res.status(404).json({ error: 'Unknown pull request' })
      return
    }
    const threads = persistence.reviewThreads.listByPullRequest(prId)
    const comments = persistence.reviewComments.listByThreadIds(threads.map((thread) => thread.id))
    const commentMap = new Map<string, typeof comments>()
    comments.forEach((comment) => {
      const existing = commentMap.get(comment.threadId) ?? []
      existing.push(comment)
      commentMap.set(comment.threadId, existing)
    })
    res.json({
      pullRequest,
      threads: threads.map((thread) => ({
        ...thread,
        comments: commentMap.get(thread.id) ?? []
      }))
    })
  }

  const addThreadCommentHandler: RequestHandler = (req, res) => {
    const threadId = req.params.threadId
    if (!threadId) {
      res.status(400).json({ error: 'threadId is required' })
      return
    }
    const thread = persistence.reviewThreads.getById(threadId)
    if (!thread) {
      res.status(404).json({ error: 'Unknown review thread' })
      return
    }
    const bodyText = typeof req.body?.body === 'string' ? req.body.body.trim() : ''
    if (!bodyText.length) {
      res.status(400).json({ error: 'body is required' })
      return
    }
    const authorKind = req.body?.authorKind === 'agent' ? 'agent' : 'user'
    const authorUserId = authorKind === 'agent' ? null : resolveUserIdFromRequest(req)
    const suggestedPatch =
      typeof req.body?.suggestedPatch === 'string' && req.body.suggestedPatch.trim().length
        ? req.body.suggestedPatch
        : null
    const comment = persistence.reviewComments.create({
      threadId,
      authorKind,
      authorUserId,
      body: bodyText,
      suggestedPatch
    })
    persistence.pullRequestEvents.insert({
      pullRequestId: thread.pullRequestId,
      kind: 'comment_added',
      actorUserId: authorUserId,
      data: { threadId, commentId: comment.id }
    })
    res.status(201).json({ comment })
  }

  const resolveThreadHandler: RequestHandler = (req, res) => {
    const threadId = req.params.threadId
    if (!threadId) {
      res.status(400).json({ error: 'threadId is required' })
      return
    }
    const thread = persistence.reviewThreads.getById(threadId)
    if (!thread) {
      res.status(404).json({ error: 'Unknown review thread' })
      return
    }
    const resolvedState = typeof req.body?.resolved === 'boolean' ? req.body.resolved : true
    persistence.reviewThreads.markResolved(threadId, resolvedState)
    const actorUserId = resolveUserIdFromRequest(req)
    persistence.pullRequestEvents.insert({
      pullRequestId: thread.pullRequestId,
      kind: 'comment_resolved',
      actorUserId,
      data: { threadId, resolved: resolvedState }
    })
    res.json({ threadId, resolved: resolvedState })
  }

  const triggerPullRequestReviewHandler: RequestHandler = async (req, res) => {
    const prId = req.params.prId
    if (!prId) {
      res.status(400).json({ error: 'pull request id is required' })
      return
    }
    const pullRequest = persistence.pullRequests.getById(prId)
    if (!pullRequest) {
      res.status(404).json({ error: 'Unknown pull request' })
      return
    }
    const trigger = normalizeReviewTrigger(req.body?.trigger)
    try {
      const run = await reviewScheduler.requestReview(prId, trigger)
      res.status(202).json({ run })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to request review'
      res.status(500).json({ error: message })
    }
  }

  const mergePullRequestHandler: RequestHandler = async (req, res) => {
    const prId = req.params.prId
    if (!prId) {
      res.status(400).json({ error: 'pull request id is required' })
      return
    }
    const pullRequest = persistence.pullRequests.getById(prId)
    if (!pullRequest) {
      res.status(404).json({ error: 'Unknown pull request' })
      return
    }
    const actorUserId = resolveUserIdFromRequest(req)
    try {
      await pullRequestModule.mergePullRequest(prId, actorUserId)
      res.json({ pullRequestId: prId, status: 'merged' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to merge pull request'
      res.status(500).json({ error: message })
    }
  }

  const closePullRequestHandler: RequestHandler = async (req, res) => {
    const prId = req.params.prId
    if (!prId) {
      res.status(400).json({ error: 'pull request id is required' })
      return
    }
    const pullRequest = persistence.pullRequests.getById(prId)
    if (!pullRequest) {
      res.status(404).json({ error: 'Unknown pull request' })
      return
    }
    const actorUserId = resolveUserIdFromRequest(req)
    try {
      await pullRequestModule.closePullRequest(prId, actorUserId)
      res.json({ pullRequestId: prId, status: 'closed' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to close pull request'
      res.status(500).json({ error: message })
    }
  }

  const applySuggestionHandler: RequestHandler = async (req, res) => {
    const prId = req.params.prId
    if (!prId) {
      res.status(400).json({ error: 'pull request id is required' })
      return
    }
    const commentId = typeof req.body?.commentId === 'string' ? req.body.commentId.trim() : ''
    if (!commentId.length) {
      res.status(400).json({ error: 'commentId is required' })
      return
    }
    const detail = await pullRequestModule.getPullRequestWithCommits(prId)
    if (!detail) {
      res.status(404).json({ error: 'Unknown pull request' })
      return
    }
    const comment = persistence.reviewComments.getById(commentId)
    if (!comment || !comment.suggestedPatch) {
      res.status(404).json({ error: 'Review comment does not contain a suggestion' })
      return
    }
    const thread = persistence.reviewThreads.getById(comment.threadId)
    if (!thread || thread.pullRequestId !== prId) {
      res.status(400).json({ error: 'Comment does not belong to this pull request' })
      return
    }
    const commitMessage =
      typeof req.body?.commitMessage === 'string' && req.body.commitMessage.trim().length
        ? req.body.commitMessage.trim()
        : `Apply suggestion from review comment ${comment.id}`
    try {
      const commitHash = await applyPatchToBranch(
        detail.project.repositoryPath,
        detail.pullRequest.sourceBranch,
        comment.suggestedPatch,
        commitMessage
      )
      await pullRequestModule.updatePullRequestCommits(prId)
      res.json({ pullRequestId: prId, commitHash })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to apply suggestion'
      res.status(500).json({ error: message })
    }
  }

  const reviewRunCallbackHandler: RequestHandler = async (req, res) => {
    const runId = req.params.runId
    if (!runId) {
      res.status(400).json({ error: 'runId is required' })
      return
    }
    if (!validateReviewRunnerToken(req)) {
      res.status(401).json({ error: 'Invalid runner token' })
      return
    }
    const run = persistence.reviewRuns.getById(runId)
    if (!run) {
      res.status(404).json({ error: 'Unknown review run' })
      return
    }
    const status = typeof req.body?.status === 'string' ? req.body.status : 'completed'
    if (status === 'failed') {
      const summary =
        typeof req.body?.error === 'string' && req.body.error.trim().length
          ? req.body.error.trim()
          : 'Review runner reported failure'
      persistence.reviewRuns.update(runId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        summary,
        logsPath: typeof req.body?.logsPath === 'string' ? req.body.logsPath : undefined
      })
      persistence.pullRequestEvents.insert({
        pullRequestId: run.pullRequestId,
        kind: 'review_run_completed',
        actorUserId: null,
        data: { runId, status: 'failed' }
      })
      res.json({ ok: true })
      return
    }
    await reviewScheduler.runRunById(runId)
    if (typeof req.body?.logsPath === 'string' && req.body.logsPath.trim().length) {
      persistence.reviewRuns.update(runId, { logsPath: req.body.logsPath.trim() })
    }
    res.json({ ok: true })
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
    wrapAsync,
    codingAgentRunner,
    codingAgentStorage,
    codingAgentCommandRunner,
    ensureWorkspaceDirectory
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
      const session = await ensureProjectCodeServer(project)
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

  const managedServices: ManagedService[] = [
    createWorkflowRuntimeService({ runtime: workflowRuntime, manageLifecycle: manageWorkerLifecycle }),
    createReviewSchedulerService(reviewScheduler),
    createTerminalService(workspaceTerminalModule),
    createCodeServerService({ shutdownAllCodeServers })
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

  app.post('/api/agent/run', wrapAsync(agentRunHandler))
  app.use(workspaceSummaryRouter)
  app.use(workspaceSessionsRouter)
  app.use(workspaceNarratorRouter)
  app.use(workspaceWorkflowsRouter)
  app.use(workspaceCodeServerRouter)
  app.use(workspaceTerminalModule.router)

  app.get('/api/projects/:projectId/pull-requests', wrapAsync(listProjectPullRequestsHandler))
  app.get('/api/reviews/active', wrapAsync(listActiveReviewsHandler))
  app.post('/api/projects/:projectId/pull-requests', wrapAsync(createProjectPullRequestHandler))
  app.get('/api/pull-requests/:prId', wrapAsync(pullRequestDetailHandler))
  app.get('/api/pull-requests/:prId/diff', wrapAsync(pullRequestDiffHandler))
  app.get('/api/pull-requests/:prId/threads', wrapAsync(pullRequestThreadsHandler))
  app.post('/api/pull-requests/:prId/reviews', wrapAsync(triggerPullRequestReviewHandler))
  app.post('/api/pull-requests/:prId/merge', wrapAsync(mergePullRequestHandler))
  app.post('/api/pull-requests/:prId/close', wrapAsync(closePullRequestHandler))
  app.post('/api/pull-requests/:prId/apply-suggestion', wrapAsync(applySuggestionHandler))
  app.post('/api/threads/:threadId/comments', wrapAsync(addThreadCommentHandler))
  app.post('/api/threads/:threadId/resolve', wrapAsync(resolveThreadHandler))
  app.post('/api/review-runs/:runId/callback', wrapAsync(reviewRunCallbackHandler))

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
    getActiveSessionIds: () => [...activeCodeServers.keys()],
    handleUpgrade,
    handlers: {
      agentRun: agentRunHandler,
      codeServerProxy: codeServerProxyHandler
    }
  }
}
