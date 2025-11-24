const loadWebSocketModule = async (): Promise<{
  WebSocket: typeof WebSocketType
  WebSocketServer: typeof WebSocketServerType
}> => {
  const nodeRequire = eval('require') as NodeJS.Require

  const loadFromLibFiles = (): {
    WebSocket: typeof WebSocketType
    WebSocketServer: typeof WebSocketServerType
  } | null => {
    try {
      const resolvedEntry = nodeRequire.resolve('ws')
      const packageDir = path.dirname(resolvedEntry)
      const loadLib = (relativePath: string) => {
        const mod = nodeRequire(path.join(packageDir, relativePath))
        return (mod && typeof mod === 'object' && 'default' in mod ? (mod as any).default : mod) as typeof WebSocketType
      }
      const WebSocket = loadLib('lib/websocket.js') as unknown as typeof WebSocketType
      const WebSocketServer = loadLib('lib/websocket-server.js') as unknown as typeof WebSocketServerType
      if (typeof WebSocketServer === 'function') {
        return { WebSocket, WebSocketServer }
      }
    } catch {
      // ignore and fall through
    }
    return null
  }

  const libResult = loadFromLibFiles()
  if (libResult) {
    return libResult
  }

  const tryImport = async (specifier: string) => {
    const module = await import(specifier)
    const defaultExport = module.default as typeof WebSocketType & {
      Server?: typeof WebSocketServerType
      WebSocketServer?: typeof WebSocketServerType
    }
    const candidates = [
      module.WebSocketServer,
      module.Server,
      defaultExport?.WebSocketServer,
      defaultExport?.Server,
      (module as any).default?.WebSocketServer,
      (module as any).default?.Server
    ]
    const WebSocketServer = candidates.find((entry): entry is typeof WebSocketServerType => typeof entry === 'function')
    const WebSocket = (defaultExport ?? (module as unknown as typeof WebSocketType)) as typeof WebSocketType
    if (!WebSocketServer) {
      throw new Error('WebSocketServer export from ws is unavailable')
    }
    return { WebSocket, WebSocketServer }
  }

  const candidateSpecifiers: string[] = []
  try {
    const resolvedPath = nodeRequire.resolve('ws')
    candidateSpecifiers.push(pathToFileURL(resolvedPath).href)
  } catch {
    // ignore resolve failures
  }
  candidateSpecifiers.push('ws')

  for (const specifier of candidateSpecifiers) {
    try {
      return await tryImport(specifier)
    } catch {
      // try next specifier
    }
  }

  const fallback = nodeRequire('ws') as typeof WebSocketType & {
    Server?: typeof WebSocketServerType
    WebSocketServer?: typeof WebSocketServerType
  }
  const WebSocket = (fallback as any).default
    ? ((fallback as any).default as typeof WebSocketType)
    : (fallback as typeof WebSocketType)
  const WebSocketServer = (fallback.WebSocketServer ?? fallback.Server) as typeof WebSocketServerType
  if (typeof WebSocketServer !== 'function') {
    throw new Error('WebSocketServer export from ws is unavailable')
  }
  return { WebSocket, WebSocketServer }
}
import cors from 'cors'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import express from 'express'
import fs from 'fs/promises'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { spawn, spawnSync } from 'node:child_process'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net'
import { pathToFileURL } from 'node:url'
import os from 'os'
import path from 'path'
import type WebSocketType from 'ws'
import type { RawData, WebSocketServer as WebSocketServerType } from 'ws'
import { runVerifierWorkerLoop, type AgentStreamEvent } from '../../src/modules/agent'
import {
  createCodeServerController,
  type CodeServerController,
  type CodeServerOptions
} from '../../src/modules/codeServer'
import {
  createPersistence,
  type Persistence,
  type ProjectRecord,
  type RadicleRegistrationRecord
} from '../../src/modules/database'
import { listBranchCommits, listGitBranches } from '../../src/modules/git'
import type { Provider } from '../../src/modules/llm'
import { createRadicleModule, type RadicleModule } from '../../src/modules/radicle'
import { createDiffModule } from '../../src/modules/review/diff'
import { createReviewEngineModule } from '../../src/modules/review/engine'
import { createPullRequestModule } from '../../src/modules/review/pullRequest'
import { createDockerReviewRunnerGateway } from '../../src/modules/review/runnerGateway'
import { createReviewSchedulerModule } from '../../src/modules/review/scheduler'
import type { ReviewRunTrigger } from '../../src/modules/review/types'
import { createOpencodeRunner, type OpencodeRunner } from '../../src/modules/opencodeRunner'
import { createOpencodeStorage, type OpencodeStorage } from '../../src/modules/opencodeStorage'
import { createTerminalModule, type LiveTerminalSession, type TerminalModule } from '../../src/modules/terminal'
import { createAgentWorkflowExecutor } from '../../src/modules/workflowAgentExecutor'
import type { WorkflowRunnerGateway } from '../../src/modules/workflowRunnerGateway'
import { createDockerWorkflowRunnerGateway } from '../../src/modules/workflowRunnerGateway'
import {
  createWorkflowRuntime,
  type PlannerRun,
  type PlannerTask,
  type WorkflowDetail,
  type WorkflowRuntime
} from '../../src/modules/workflows'

const DEFAULT_PORT = Number(process.env.UI_SERVER_PORT || 5556)
const CODE_SERVER_HOST = process.env.CODE_SERVER_HOST || '127.0.0.1'
const GRAPH_BRANCH_LIMIT = Math.max(Number(process.env.REPO_GRAPH_BRANCH_LIMIT ?? 6) || 6, 1)
const GRAPH_COMMITS_PER_BRANCH = Math.max(Number(process.env.REPO_GRAPH_COMMITS_PER_BRANCH ?? 25) || 25, 1)
const WORKFLOW_AGENT_PROVIDER =
  normalizeWorkflowProvider(process.env.WORKFLOW_AGENT_PROVIDER) ?? ('opencode' as Provider)
const WORKFLOW_AGENT_MODEL = process.env.WORKFLOW_AGENT_MODEL ?? 'github-copilot/gpt-5-mini'
const WORKFLOW_AGENT_MAX_ROUNDS = parsePositiveInteger(process.env.WORKFLOW_AGENT_MAX_ROUNDS)

function normalizeWorkflowProvider(raw?: string | null): Provider | undefined {
  if (!raw) return undefined
  const normalized = raw.trim().toLowerCase()
  const allowed: Provider[] = ['ollama', 'opencode', 'goose', 'ollama-cli']
  return allowed.find((entry) => entry === normalized) as Provider | undefined
}

function parsePositiveInteger(raw?: string | null): number | undefined {
  if (!raw) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return undefined
  const rounded = Math.floor(parsed)
  return rounded > 0 ? rounded : undefined
}

type TlsConfig = {
  certPath?: string
  keyPath?: string
  cert?: Buffer | string
  key?: Buffer | string
}

type TlsMaterials = {
  cert: Buffer
  key: Buffer
}

const bufferize = (value: Buffer | string): Buffer => (Buffer.isBuffer(value) ? value : Buffer.from(value))

const readTlsFile = async (filePath: string, label: 'certificate' | 'key'): Promise<Buffer> => {
  try {
    return await fs.readFile(filePath)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Unable to read TLS ${label} at ${filePath}: ${reason}. Run \"npm run certs:generate\" or set UI_TLS_${
        label === 'certificate' ? 'CERT' : 'KEY'
      }_PATH.`
    )
  }
}

async function resolveTlsMaterials(config: TlsConfig): Promise<TlsMaterials> {
  if (config.cert && config.key) {
    return {
      cert: bufferize(config.cert),
      key: bufferize(config.key)
    }
  }
  if ((config.cert && !config.key) || (!config.cert && config.key)) {
    throw new Error('TLS configuration requires both certificate and key data to be provided together.')
  }
  const certPath = config.certPath
  const keyPath = config.keyPath
  if (!certPath || !keyPath) {
    throw new Error(
      'TLS certificate and key paths must be provided. Set UI_TLS_CERT_PATH and UI_TLS_KEY_PATH or run "npm run certs:generate".'
    )
  }
  const [cert, key] = await Promise.all([readTlsFile(certPath, 'certificate'), readTlsFile(keyPath, 'key')])
  return { cert, key }
}

function normalizePublicOrigin(raw?: string | null): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    return url.origin
  } catch {
    return null
  }
}

function buildExternalUrl(pathOrUrl: string | null, origin: string | null): string | null {
  if (!pathOrUrl) return null
  if (!origin) return pathOrUrl
  try {
    const resolved = new URL(pathOrUrl, origin)
    return resolved.toString()
  } catch {
    return pathOrUrl
  }
}

function mergeFrameAncestorsDirective(policy: string | string[] | undefined, ancestor: string): string {
  const normalized = Array.isArray(policy) ? policy.join('; ') : policy ?? ''
  const directives = normalized
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length && !entry.toLowerCase().startsWith('frame-ancestors'))
  directives.push(`frame-ancestors 'self' ${ancestor}`)
  return directives.join('; ')
}

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
  workflowId: string | null
  stepId: string | null
  timestamp: string
  authorName: string | null
  authorEmail: string | null
  source: 'hyperagent' | 'git'
}

type GraphEdge = {
  from: string
  to: string
}

type GitMetadata = {
  repositoryPath: string
  branch: string | null
  commit: {
    hash: string | null
    message: string | null
    timestamp: string | null
  } | null
  remotes: Array<{ name: string; url: string }>
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
  opencodeStorage?: OpencodeStorage
  opencodeRunner?: OpencodeRunner
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

export async function createServerApp(options: CreateServerOptions = {}): Promise<ServerInstance> {
  const wsModule = await loadWebSocketModule()
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
      tempRootDir: process.env.RADICLE_TEMP_DIR
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

  const opencodeStorage = options.opencodeStorage ?? createOpencodeStorage()
  const opencodeRunner = options.opencodeRunner ?? createOpencodeRunner()

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

  const workflowAgentExecutor = createAgentWorkflowExecutor({
    runLoop,
    provider: WORKFLOW_AGENT_PROVIDER,
    model: WORKFLOW_AGENT_MODEL,
    maxRounds: WORKFLOW_AGENT_MAX_ROUNDS
  })

  const workflowCallbackBaseUrl = process.env.WORKFLOW_CALLBACK_BASE_URL ?? `https://host.docker.internal:${defaultPort}`
  const workflowRunnerToken = process.env.WORKFLOW_RUNNER_TOKEN ?? process.env.WORKFLOW_CALLBACK_TOKEN ?? null
  const workflowRunnerGateway =
    options.workflowRunnerGateway ??
    createDockerWorkflowRunnerGateway({
      dockerBinary: process.env.WORKFLOW_DOCKER_BINARY,
      image: process.env.WORKFLOW_RUNNER_IMAGE,
      callbackBaseUrl: workflowCallbackBaseUrl,
      callbackToken: workflowRunnerToken ?? undefined,
      timeoutMs: process.env.WORKFLOW_RUNNER_TIMEOUT ? Number(process.env.WORKFLOW_RUNNER_TIMEOUT) : undefined
    })

  const manageWorkerLifecycle = !options.workflowRuntime
  const workflowRuntime =
    options.workflowRuntime ??
    createWorkflowRuntime({
      persistence,
      pollIntervalMs: options.workflowPollIntervalMs,
      radicle: radicleModule,
      commitAuthor,
      agentExecutor: workflowAgentExecutor,
      runnerGateway: workflowRunnerGateway
    })
  if (manageWorkerLifecycle) {
    workflowRuntime.startWorker()
  }
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
  const pullRequestModule = createPullRequestModule({
    projects: persistence.projects,
    pullRequests: persistence.pullRequests,
    pullRequestCommits: persistence.pullRequestCommits,
    pullRequestEvents: persistence.pullRequestEvents
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
  reviewScheduler.startWorker()
  persistence.codeServerSessions.resetAllRunning()

  const app = express()
  const corsMiddleware = corsOrigin ? cors({ origin: corsOrigin, credentials: true }) : cors()
  app.use(corsMiddleware)
  app.use(express.json({ limit: '1mb' }))

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

  const ensureWorkspaceDirectory = async (dirPath: string): Promise<void> => {
    const stats = await fs.stat(dirPath)
    if (!stats.isDirectory()) {
      throw new Error('Project repository path is not a directory')
    }
  }
  const terminalWsServer: WebSocketServerType = new WebSocketServerCtor({ noServer: true })
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
    return value === reviewRunnerToken
  }

  const validateWorkflowRunnerToken = (req: Request): boolean => {
    if (!workflowRunnerToken) return true
    const value = pickUserIdValue(req.headers['x-workflow-runner-token'])
    return value === workflowRunnerToken
  }

  const MAX_WORKSPACE_ENTRIES = 75

  const readWorkspacePathFromResult = (result: Record<string, unknown> | null | undefined): string | null => {
    if (!result || typeof result !== 'object') return null
    const workspace = (result as any).workspace
    if (workspace && typeof workspace.workspacePath === 'string') {
      return workspace.workspacePath
    }
    return null
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

  const safeParseJson = (raw: string): unknown | null => {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

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

  function ensureEphemeralProject(sessionId: string, sessionDir: string): ProjectRecord {
    return persistence.projects.upsert({
      id: `session-${sessionId}`,
      name: `Session ${sessionId}`,
      repositoryPath: sessionDir,
      defaultBranch: 'main'
    })
  }

  function normalizePlannerTasks(raw: unknown): PlannerTask[] {
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

  function normalizeReviewTrigger(value: unknown): ReviewRunTrigger {
    if (value === 'auto_on_open' || value === 'auto_on_update') {
      return value
    }
    return 'manual'
  }

  function isPlainObject(value: unknown): value is Record<string, unknown> {
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

  const readGitMetadata = async (repoPath: string): Promise<GitMetadata | null> => {
    const resolved = path.resolve(repoPath)
    try {
      await fs.stat(resolved)
    } catch {
      return null
    }

    const readValue = async (args: string[]): Promise<string | null> => {
      try {
        const output = await runGitCommand(args, resolved)
        return output.trim()
      } catch {
        return null
      }
    }

    const [branch, commitHash, commitMessage, commitTimestamp, remotesRaw] = await Promise.all([
      readValue(['rev-parse', '--abbrev-ref', 'HEAD']),
      readValue(['rev-parse', 'HEAD']),
      readValue(['log', '-1', '--pretty=%s']),
      readValue(['log', '-1', '--pretty=%cI']),
      readValue(['remote', '-v'])
    ])

    const remotes: Array<{ name: string; url: string }> = []
    if (remotesRaw) {
      const seen = new Set<string>()
      remotesRaw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line) => {
          const parts = line.split(/\s+/)
          if (parts.length < 2) return
          const [name, url] = parts
          const key = `${name}:${url}`
          if (seen.has(key)) return
          seen.add(key)
          remotes.push({ name, url })
        })
    }

    return {
      repositoryPath: resolved,
      branch,
      commit: commitHash
        ? {
            hash: commitHash,
            message: commitMessage,
            timestamp: commitTimestamp
          }
        : null,
      remotes
    }
  }

  const collectGitMetadata = async (paths: string[]): Promise<Map<string, GitMetadata | null>> => {
    const unique = [...new Set(paths.map((entry) => path.resolve(entry)))]
    const results = await Promise.all(unique.map(async (entry) => ({ path: entry, git: await readGitMetadata(entry) })))
    const map = new Map<string, GitMetadata | null>()
    results.forEach((item) => {
      map.set(item.path, item.git)
    })
    return map
  }

  const isGitRepository = async (dirPath: string): Promise<boolean> => {
    try {
      await fs.access(path.join(dirPath, '.git'))
      return true
    } catch {
      return false
    }
  }

  const sortCommitsByTimestamp = (entries: GraphCommitNode[]): GraphCommitNode[] => {
    return entries.sort((a, b) => {
      const aTime = Date.parse(a.timestamp)
      const bTime = Date.parse(b.timestamp)
      if (!Number.isFinite(aTime) || !Number.isFinite(bTime)) {
        return a.timestamp.localeCompare(b.timestamp)
      }
      return aTime - bTime
    })
  }

  function extractCommitFromStep(
    step: WorkflowDetail['steps'][number]
  ): { commitHash: string; branch: string; message: string } | null {
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
      console.warn('Unable to launch code-server session', options.sessionId, error)
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

  function extractTerminalSessionId(rawUrl: string | undefined): string | null {
    if (!rawUrl) return null
    const match = rawUrl.match(/^\/ws\/terminal\/([^/?#]+)/)
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

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    })
    res.flushHeaders?.()
    req.socket?.setKeepAlive?.(true)

    let closed = false
    let sessionId: string | null = null
    let sessionDir: string | null = null
    let shouldShutdownCodeServer = !project
    res.on('close', () => {
      closed = true
      if (sessionId && shouldShutdownCodeServer) {
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

    console.log('session ready', sessionId)
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

      console.log('running loop', sessionId)
      const result = await runLoop({
        userInstructions: prompt,
        provider: providerToUse,
        model: modelToUse,
        maxRounds: normalizedMaxRounds,
        sessionDir: sessionDir ?? undefined,
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

  const radicleStatusHandler: RequestHandler = async (_req, res) => {
    try {
      const status = await radicleModule.getStatus()
      res.json({ status })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read Radicle status'
      res.status(500).json({ error: message })
    }
  }

  const radicleRepositoriesHandler: RequestHandler = async (_req, res) => {
    try {
      const projects = persistence.projects.list()
      const radicleRegistrations = persistence.radicleRegistrations.list()
      const projectMap = new Map(projects.map((project) => [path.resolve(project.repositoryPath), project]))
      const registrationMap = new Map(radicleRegistrations.map((entry) => [path.resolve(entry.repositoryPath), entry]))
      const uniquePaths = [...new Set([...projectMap.keys(), ...registrationMap.keys()])]
      if (!uniquePaths.length) {
        res.json({ repositories: [] })
        return
      }
      const gitMetadata = await collectGitMetadata(uniquePaths)
      const inspections = await Promise.all(
        uniquePaths.map(async (repoPath) => {
          try {
            const info = await radicleModule.inspectRepository(repoPath)
            if (info.registered) {
              const existingRegistration = registrationMap.get(repoPath)
              const stored = persistence.radicleRegistrations.upsert({
                repositoryPath: repoPath,
                name: existingRegistration?.name ?? projectMap.get(repoPath)?.name ?? path.basename(repoPath),
                description: existingRegistration?.description ?? undefined,
                visibility: existingRegistration?.visibility ?? undefined,
                defaultBranch: info.defaultBranch ?? existingRegistration?.defaultBranch ?? undefined
              })
              registrationMap.set(repoPath, stored)
            }
            return { path: repoPath, info }
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Radicle inspection failed'
            return { path: repoPath, info: null, error: message }
          }
        })
      )
      const inspectionMap = new Map<
        string,
        { info: Awaited<ReturnType<typeof radicleModule.inspectRepository>> | null; error?: string }
      >()
      inspections.forEach((entry) => {
        inspectionMap.set(entry.path, entry)
      })
      const payload = uniquePaths.map((repoPath) => {
        const project =
          projectMap.get(repoPath) ?? createSyntheticProjectRecord(repoPath, registrationMap.get(repoPath) ?? null)
        const inspection = inspectionMap.get(repoPath)
        return {
          project,
          radicle: inspection?.info ?? null,
          git: gitMetadata.get(repoPath) ?? null,
          error: inspection?.error ?? null
        }
      })
      payload.sort((a, b) => a.project.name.localeCompare(b.project.name))
      res.json({ repositories: payload })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list Radicle repositories'
      res.status(500).json({ error: message })
    }
  }

  const listOpencodeSessionsHandler: RequestHandler = async (req, res) => {
    try {
      const workspaceParam = req.query.workspacePath
      const workspacePath = typeof workspaceParam === 'string' ? workspaceParam : undefined
      const sessions = await opencodeStorage.listSessions({ workspacePath })
      res.json({ sessions })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list opencode sessions'
      res.status(500).json({ error: message })
    }
  }

  const getOpencodeSessionHandler: RequestHandler = async (req, res) => {
    const sessionId = req.params.sessionId
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' })
      return
    }
    try {
      const detail = await opencodeStorage.getSession(sessionId)
      if (!detail) {
        res.status(404).json({ error: 'Unknown session' })
        return
      }
      res.json(detail)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load opencode session'
      res.status(500).json({ error: message })
    }
  }

  const listOpencodeRunsHandler: RequestHandler = async (_req, res) => {
    try {
      const runs = await opencodeRunner.listRuns()
      res.json({ runs })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list opencode runs'
      res.status(500).json({ error: message })
    }
  }

  const startOpencodeSessionHandler: RequestHandler = async (req, res) => {
    const { workspacePath, prompt, title, model } = req.body ?? {}
    if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
      res.status(400).json({ error: 'workspacePath is required' })
      return
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'prompt is required' })
      return
    }
    const normalizedWorkspace = workspacePath.trim()
    try {
      await ensureWorkspaceDirectory(normalizedWorkspace)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Workspace path is unavailable'
      res.status(400).json({ error: message })
      return
    }
    try {
      const run = await opencodeRunner.startRun({
        workspacePath: normalizedWorkspace,
        prompt: prompt.trim(),
        title: typeof title === 'string' ? title : undefined,
        model: typeof model === 'string' ? model : undefined
      })
      res.status(202).json({ run })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start opencode session'
      res.status(500).json({ error: message })
    }
  }

  const killOpencodeSessionHandler: RequestHandler = async (req, res) => {
    const sessionId = req.params.sessionId
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' })
      return
    }
    try {
      const success = await opencodeRunner.killRun(sessionId)
      res.json({ success })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to terminate opencode session'
      res.status(500).json({ error: message })
    }
  }

  const repositoryGraphHandler: RequestHandler = async (req, res) => {
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

    try {
      const branchCandidates = [project.defaultBranch, ...(await listGitBranches(project.repositoryPath))]
      const gitBranches = [...new Set(branchCandidates)].slice(0, GRAPH_BRANCH_LIMIT)
      const branchCommits = await Promise.all(
        gitBranches.map(async (branch) => {
          const commits = await listBranchCommits({
            repoPath: project.repositoryPath,
            branch,
            limit: GRAPH_COMMITS_PER_BRANCH
          })
          return {
            branch,
            commits: commits.map<GraphCommitNode>((commit) => ({
              id: commit.hash,
              commitHash: commit.hash,
              branch,
              message: commit.message,
              label: commit.message || commit.hash,
              workflowId: null,
              stepId: null,
              timestamp: commit.timestamp,
              authorName: commit.authorName || null,
              authorEmail: commit.authorEmail || null,
              source: 'git'
            }))
          }
        })
      )

      const branchMap = new Map<string, GraphCommitNode[]>()
      branchCommits.forEach(({ branch, commits }) => {
        branchMap.set(branch, sortCommitsByTimestamp(commits))
      })
      if (!branchMap.size) {
        branchMap.set(project.defaultBranch, [])
      }

      const workflows = workflowRuntime.listWorkflows(projectId)
      workflows.forEach((workflow) => {
        const steps = persistence.workflowSteps.listByWorkflow(workflow.id)
        steps.forEach((step) => {
          const commit = extractCommitFromStep(step)
          if (!commit) return
          const branchName = commit.branch === 'unknown' ? project.defaultBranch : commit.branch
          const label =
            typeof step.data?.title === 'string' && step.data.title.length
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
            timestamp: step.updatedAt,
            authorName: 'Hyperagent Workflow',
            authorEmail: null,
            source: 'hyperagent'
          }
          const list = branchMap.get(branchName) ?? []
          const existingIndex = list.findIndex((entry) => entry.commitHash === node.commitHash)
          if (existingIndex >= 0) {
            const existing = list[existingIndex]
            list[existingIndex] = {
              ...existing,
              label: node.label,
              workflowId: node.workflowId,
              stepId: node.stepId,
              source: 'hyperagent',
              timestamp: node.timestamp,
              authorName: existing.authorName ?? node.authorName,
              authorEmail: existing.authorEmail ?? node.authorEmail
            }
          } else {
            list.push(node)
          }
          branchMap.set(branchName, sortCommitsByTimestamp(list).slice(-GRAPH_COMMITS_PER_BRANCH))
        })
      })

      const branches = [...branchMap.entries()].map(([name, commits]) => ({
        name,
        commits
      }))

      const edges: GraphEdge[] = []
      branches.forEach((branch) => {
        for (let index = 1; index < branch.commits.length; index++) {
          edges.push({ from: branch.commits[index - 1].id, to: branch.commits[index].id })
        }
      })

      res.json({ project, branches, edges })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to build repository graph'
      res.status(500).json({ error: message })
    }
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
        ':(exclude).hyperagent.json',
        ':(exclude).hyperagent/**',
        ':(exclude)**/.hyperagent.json',
        ':(exclude)**/.hyperagent/**'
      ]
      const diffText = await runGitCommand(diffArgs, project.repositoryPath)
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

  const listProjectsHandler: RequestHandler = async (_req, res) => {
    try {
      const projects = persistence.projects.list()
      const gitMap = await collectGitMetadata(projects.map((project) => project.repositoryPath))
      const payload = projects.map((project) => ({
        ...project,
        git: gitMap.get(path.resolve(project.repositoryPath)) ?? null
      }))
      res.json({ projects: payload })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list projects'
      res.status(500).json({ error: message })
    }
  }

  const projectDetailHandler: RequestHandler = async (req, res) => {
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
    try {
      const gitMap = await collectGitMetadata([project.repositoryPath])
      const payload = {
        ...project,
        git: gitMap.get(path.resolve(project.repositoryPath)) ?? null
      }
      res.json({ project: payload })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read project metadata'
      res.status(500).json({ error: message })
    }
  }

  const projectDevspaceHandler: RequestHandler = async (req, res) => {
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
    try {
      await ensureWorkspaceDirectory(project.repositoryPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Project repository path is unavailable'
      res.status(400).json({ error: message })
      return
    }
    const session = await ensureProjectCodeServer(project)
    if (!session) {
      res.status(500).json({ error: 'Failed to launch code-server for project' })
      return
    }
    res.json({
      projectId: project.id,
      sessionId: session.id,
      codeServerUrl: session.publicUrl,
      workspacePath: session.dir,
      branch: session.branch
    })
  }

  const projectDiffHandler: RequestHandler = async (req, res) => {
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
    const isRepo = await isGitRepository(project.repositoryPath)
    if (!isRepo) {
      res.status(400).json({ error: 'Project repository is not a Git repository' })
      return
    }
    try {
      const diffArgs = ['diff', '--stat', '--patch', '--unified=200']
      const diffText = await runGitCommand(diffArgs, project.repositoryPath)
      const statusText = await runGitCommand(['status', '-sb'], project.repositoryPath)
      res.json({
        projectId: project.id,
        diffText,
        hasChanges: diffText.trim().length > 0,
        status: statusText
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to compute project diff'
      res.status(500).json({ error: message })
    }
  }

  const registerRadicleRepositoryHandler: RequestHandler = async (req, res) => {
    const { repositoryPath, name, description, visibility } = req.body ?? {}
    if (!repositoryPath || typeof repositoryPath !== 'string') {
      res.status(400).json({ error: 'repositoryPath is required' })
      return
    }
    try {
      const resolvedPath = path.resolve(repositoryPath.trim())
      const repository = await radicleModule.registerRepository({
        repositoryPath: resolvedPath,
        name: typeof name === 'string' && name.length ? name : undefined,
        description: typeof description === 'string' && description.length ? description : undefined,
        visibility: visibility === 'public' || visibility === 'private' ? visibility : undefined
      })
      persistence.radicleRegistrations.upsert({
        repositoryPath: resolvedPath,
        name: typeof name === 'string' && name.length ? name : undefined,
        description: typeof description === 'string' && description.length ? description : undefined,
        visibility: visibility === 'public' || visibility === 'private' ? visibility : undefined,
        defaultBranch: repository.defaultBranch ?? undefined
      })
      res.json({ repository })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to register repository with Radicle'
      res.status(500).json({ error: message })
    }
  }

  const browseFilesystemHandler: RequestHandler = async (req, res) => {
    const requestedPath = typeof req.query.path === 'string' && req.query.path.length ? req.query.path : os.homedir()
    try {
      const resolved = path.resolve(requestedPath)
      const stats = await fs.stat(resolved)
      if (!stats.isDirectory()) {
        res.status(400).json({ error: 'Path is not a directory' })
        return
      }
      const entries = await fs.readdir(resolved, { withFileTypes: true })
      const directories = entries.filter((entry) => entry.isDirectory())
      const payload = await Promise.all(
        directories.map(async (entry) => {
          const absolute = path.join(resolved, entry.name)
          const gitRepo = await isGitRepository(absolute)
          let radicleRegistered = false
          let radicleRegistrationReason: string | null = null
          if (!gitRepo) {
            radicleRegistrationReason = 'Not a Git repository'
          } else {
            try {
              const info = await radicleModule.inspectRepository(absolute)
              radicleRegistered = info.registered
              if (radicleRegistered) {
                persistence.radicleRegistrations.upsert({
                  repositoryPath: absolute,
                  name: entry.name,
                  defaultBranch: info.defaultBranch ?? undefined
                })
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Failed to inspect repository for Radicle'
              radicleRegistrationReason = message
            }
          }
          return {
            name: entry.name,
            path: absolute,
            isGitRepository: gitRepo,
            radicleRegistered,
            radicleRegistrationReason
          }
        })
      )
      payload.sort((a, b) => a.name.localeCompare(b.name))
      const parent = path.dirname(resolved)
      const isRoot = resolved === path.parse(resolved).root
      res.json({
        path: resolved,
        parent: isRoot ? null : parent,
        entries: payload
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to browse filesystem'
      res.status(500).json({ error: message })
    }
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
    const payload = workflows.map((workflow) => ({
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
      res.json({
        logsPath,
        workspacePath,
        content: raw,
        parsed: safeParseJson(raw),
        workspaceEntries
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load provenance file'
      res.status(500).json({ error: message })
    }
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
    try {
      await workflowRuntime.runStepById({ workflowId, stepId, runnerInstanceId })
      res.json({ ok: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to execute workflow step'
      const normalized = message.toLowerCase()
      if (normalized.includes('unknown workflow step')) {
        res.status(404).json({ error: message })
        return
      }
      if (normalized.includes('not running') || normalized.includes('runner token')) {
        res.status(409).json({ error: message })
        return
      }
      if (normalized.includes('does not belong')) {
        res.status(400).json({ error: message })
        return
      }
      res.status(500).json({ error: message })
    }
  }

  const listCodeSessionsHandler: RequestHandler = (_req, res) => {
    res.json({ sessions: persistence.codeServerSessions.listActive() })
  }

  const listTerminalSessionsHandler: RequestHandler = async (req, res) => {
    try {
      const userId = resolveUserIdFromRequest(req)
      const sessions = await terminalModule.listSessions(userId)
      res.json({ sessions })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list terminal sessions'
      res.status(500).json({ error: message })
    }
  }

  const createTerminalSessionHandler: RequestHandler = async (req, res) => {
    const userId = resolveUserIdFromRequest(req)
    const { cwd, shell, projectId } = req.body ?? {}
    try {
      const session = await terminalModule.createSession(userId, {
        cwd: typeof cwd === 'string' && cwd.trim().length ? cwd : undefined,
        shell: typeof shell === 'string' && shell.trim().length ? shell : undefined,
        projectId: typeof projectId === 'string' && projectId.trim().length ? projectId : null
      })
      res.status(201).json({ session })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create terminal session'
      const statusCode = /too many active terminal sessions/i.test(message) ? 429 : 500
      res.status(statusCode).json({ error: message })
    }
  }

  const deleteTerminalSessionHandler: RequestHandler = async (req, res) => {
    const userId = resolveUserIdFromRequest(req)
    const sessionId = req.params.sessionId
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' })
      return
    }
    const record = await terminalModule.getSession(sessionId)
    if (!record || record.userId !== userId) {
      res.status(404).json({ error: 'Unknown terminal session' })
      return
    }
    await terminalModule.closeSession(sessionId, userId)
    res.status(204).end()
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true })
  })

  app.get('/api/radicle/status', radicleStatusHandler)
  app.get('/api/radicle/repositories', radicleRepositoriesHandler)
  app.post('/api/radicle/register', registerRadicleRepositoryHandler)
  app.get('/api/fs/browse', browseFilesystemHandler)
  app.get('/api/projects', listProjectsHandler)
  app.get('/api/projects/:projectId/graph', repositoryGraphHandler)
  app.get('/api/projects/:projectId/diff', projectDiffHandler)
  app.post('/api/projects/:projectId/devspace', projectDevspaceHandler)
  app.get('/api/projects/:projectId/pull-requests', listProjectPullRequestsHandler)
  app.get('/api/reviews/active', listActiveReviewsHandler)
  app.post('/api/projects/:projectId/pull-requests', createProjectPullRequestHandler)
  app.get('/api/projects/:projectId', projectDetailHandler)
  app.post('/api/projects', createProjectHandler)
  app.get('/api/pull-requests/:prId', pullRequestDetailHandler)
  app.get('/api/pull-requests/:prId/diff', pullRequestDiffHandler)
  app.get('/api/pull-requests/:prId/threads', pullRequestThreadsHandler)
  app.post('/api/pull-requests/:prId/reviews', triggerPullRequestReviewHandler)
  app.post('/api/pull-requests/:prId/merge', mergePullRequestHandler)
  app.post('/api/pull-requests/:prId/close', closePullRequestHandler)
  app.post('/api/pull-requests/:prId/apply-suggestion', applySuggestionHandler)
  app.post('/api/threads/:threadId/comments', addThreadCommentHandler)
  app.post('/api/threads/:threadId/resolve', resolveThreadHandler)
  app.post('/api/review-runs/:runId/callback', reviewRunCallbackHandler)
  app.get('/api/workflows', listWorkflowsHandler)
  app.post('/api/workflows', createWorkflowHandler)
  app.post('/api/workflows/:workflowId/start', startWorkflowHandler)
  app.get('/api/workflows/:workflowId', workflowDetailHandler)
  app.post('/api/workflows/:workflowId/steps/:stepId/callback', workflowRunnerCallbackHandler)
  app.get('/api/workflows/:workflowId/steps/:stepId/diff', workflowStepDiffHandler)
  app.get('/api/workflows/:workflowId/steps/:stepId/provenance', workflowStepProvenanceHandler)
  app.get('/api/code-server/sessions', listCodeSessionsHandler)
  app.get('/api/terminal/sessions', listTerminalSessionsHandler)
  app.post('/api/terminal/sessions', createTerminalSessionHandler)
  app.delete('/api/terminal/sessions/:sessionId', deleteTerminalSessionHandler)
  app.get('/api/opencode/sessions', listOpencodeSessionsHandler)
  app.get('/api/opencode/sessions/:sessionId', getOpencodeSessionHandler)
  app.get('/api/opencode/runs', listOpencodeRunsHandler)
  app.post('/api/opencode/sessions', startOpencodeSessionHandler)
  app.post('/api/opencode/sessions/:sessionId/kill', killOpencodeSessionHandler)
  app.post('/api/agent/run', agentRunHandler)

  const sendTerminalPayload = (socket: WebSocketType, payload: Record<string, unknown>) => {
    if (socket.readyState !== WebSocketCtor.OPEN) return
    socket.send(JSON.stringify(payload))
  }

  const rawDataToString = (raw: RawData): string => {
    if (typeof raw === 'string') return raw
    if (Buffer.isBuffer(raw)) return raw.toString('utf8')
    if (Array.isArray(raw)) {
      return Buffer.concat(raw.map((item) => (Buffer.isBuffer(item) ? item : Buffer.from(item)))).toString('utf8')
    }
    return Buffer.from(raw as ArrayBuffer).toString('utf8')
  }

  const handleTerminalSocketMessage = (raw: RawData, live: LiveTerminalSession) => {
    let parsed: any
    try {
      parsed = JSON.parse(rawDataToString(raw))
    } catch {
      return
    }
    if (parsed?.type === 'input' && typeof parsed.data === 'string') {
      live.pty.write(parsed.data)
      return
    }
    if (parsed?.type === 'resize') {
      const cols = typeof parsed.cols === 'number' && parsed.cols > 0 ? parsed.cols : undefined
      const rows = typeof parsed.rows === 'number' && parsed.rows > 0 ? parsed.rows : undefined
      if (cols || rows) {
        live.pty.resize(cols ?? live.pty.cols, rows ?? live.pty.rows)
      }
      return
    }
    if (parsed?.type === 'close') {
      void terminalModule.closeSession(live.id, live.userId)
    }
  }

  terminalWsServer.on('connection', (socket: WebSocketType, request: IncomingMessage) => {
    const sessionId = extractTerminalSessionId(request.url)
    if (!sessionId) {
      socket.close(1008, 'Missing terminal session id')
      return
    }
    const userId = resolveUserIdFromHeaders(request.headers)
    try {
      console.info(
        `[WS] terminal connected session=${sessionId} from=${request.socket?.remoteAddress ?? 'unknown'} (user=${userId})`
      )
    } catch {
      // ignore logging failures
    }
    ;(async () => {
      try {
        const live = await terminalModule.attachSession(sessionId, userId)
        sendTerminalPayload(socket, { type: 'ready', sessionId: live.id })
        const disposables: Array<() => void> = []
        const dataSubscription = live.pty.onData((data) => {
          try {
            console.info(
              `[WS] terminal -> client session=${sessionId} data=${typeof data === 'string' ? data.substring(0, 200) : '[binary]'}`
            )
          } catch {
            // ignore
          }
          sendTerminalPayload(socket, { type: 'output', data })
        })
        const exitSubscription = live.pty.onExit(({ exitCode, signal }) => {
          sendTerminalPayload(socket, {
            type: 'exit',
            exitCode,
            signal: typeof signal === 'number' ? signal : null
          })
          socket.close(1000)
        })
        disposables.push(() => dataSubscription.dispose())
        disposables.push(() => exitSubscription.dispose())

        const messageHandler = (raw: RawData) => handleTerminalSocketMessage(raw, live)
        socket.on('message', messageHandler)
        const cleanup = () => {
          if (!disposables.length) return
          while (disposables.length) {
            const dispose = disposables.pop()
            try {
              dispose?.()
            } catch {
              // ignore
            }
          }
          socket.off('message', messageHandler)
        }
        socket.on('close', cleanup)
        socket.on('error', cleanup)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to attach terminal session'
        sendTerminalPayload(socket, { type: 'error', message })
        socket.close(1011, message.slice(0, 120))
      }
    })()
  })

  app.use('/code-server/:sessionId', codeServerProxyHandler)

  const handleUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (extractTerminalSessionId(req.url)) {
      terminalWsServer.handleUpgrade(req, socket, head, (ws: WebSocketType) => {
        terminalWsServer.emit('connection', ws, req)
      })
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
      console.log(`UI server listening on https://localhost:${port}`)
    })
    return server
  }

  const shutdownApp = async () => {
    await shutdownAllCodeServers()
    terminalWsServer.clients.forEach((client: WebSocketType) => {
      try {
        client.close()
      } catch {
        // ignore
      }
    })
    await new Promise<void>((resolve) => terminalWsServer.close(() => resolve()))
    if (manageWorkerLifecycle) {
      await workflowRuntime.stopWorker()
    }
    await reviewScheduler.stopWorker()
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

function detectGitAuthorFromCli(): { name: string; email: string } | null {
  const name = readGitConfigValue('user.name')
  const email = readGitConfigValue('user.email')
  if (name && email) {
    return { name, email }
  }
  return null
}

const sanitizeRepoIdComponent = (repoPath: string): string => {
  const normalized = repoPath.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return normalized.length ? normalized : 'radicle-repo'
}

function createSyntheticProjectRecord(repoPath: string, registration: RadicleRegistrationRecord | null): ProjectRecord {
  return {
    id: `rad-only-${sanitizeRepoIdComponent(repoPath)}`,
    name: registration?.name ?? (path.basename(repoPath) || repoPath),
    description: registration?.description ?? null,
    repositoryPath: repoPath,
    repositoryProvider: 'radicle',
    defaultBranch: registration?.defaultBranch ?? 'main',
    createdAt: registration?.registeredAt ?? new Date().toISOString()
  }
}

function readGitConfigValue(key: string): string | null {
  const attempts: string[][] = [
    ['config', '--get', key],
    ['config', '--global', '--get', key],
    ['config', '--system', '--get', key]
  ]
  for (const args of attempts) {
    try {
      const result = spawnSync('git', args, { encoding: 'utf8' })
      if (result.status === 0) {
        const value = result.stdout.trim()
        if (value.length) {
          return value
        }
      }
    } catch {
      // ignore
    }
  }
  return null
}
