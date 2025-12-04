#!/usr/bin/env node
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { runVerifierWorkerLoop, type AgentStreamCallback } from '../modules/agent/agent'
import { createPersistence } from '../modules/database'
import { runGitCommandSync } from '../modules/git'
import { detectGitAuthorFromCli } from '../modules/gitAuthor'
import type { Provider } from '../modules/llm'
import { createRadicleModule } from '../modules/radicle'
import { createTestRadicleModule } from '../modules/radicle/testHarness'
import type { RadicleModule } from '../modules/radicle/types'
import { createPullRequestModule } from '../modules/review/pullRequest'
import { createAgentWorkflowExecutor } from '../modules/workflowAgentExecutor'
import { createWorkflowPolicyFromEnv } from '../modules/workflowPolicy'
import type { WorkflowRunnerGateway } from '../modules/workflowRunnerGateway'
import { createWorkflowRuntime, type AgentExecutor } from '../modules/workflows'

const extendRunnerPathFromEnv = () => {
  const extraPaths = process.env.WORKFLOW_RUNNER_EXTRA_PATHS?.trim()
  if (!extraPaths) {
    return
  }
  const sanitized = extraPaths
    .split(':')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length)
  if (!sanitized.length) {
    return
  }
  const current = process.env.PATH ?? ''
  const merged = [...new Set([...sanitized, ...current.split(':').filter((entry) => entry.length)])]
  process.env.PATH = merged.join(':')
}

extendRunnerPathFromEnv()

const ensureOpencodeGitHubAuth = async () => {
  const pat = process.env.WORKFLOW_GITHUB_COPILOT_PAT?.trim()
  if (!pat) return
  try {
    const authFilePath = getOpencodeAuthFilePath()
    await fs.mkdir(path.dirname(authFilePath), { recursive: true })
    const authData = await readOpencodeAuthFile(authFilePath)
    const providerEntry = authData['github-copilot']
    const expiresAt = typeof providerEntry?.expires === 'number' ? providerEntry.expires : null
    if (expiresAt && expiresAt - Date.now() > 120_000) {
      return
    }
    const token = await fetchCopilotTokens(pat)
    authData['github-copilot'] = {
      type: 'oauth',
      refresh: token.refreshToken,
      access: token.accessToken,
      expires: token.expiresAt
    }
    await fs.writeFile(authFilePath, JSON.stringify(authData, null, 2), 'utf8')
    runnerLogger('opencode_auth_refreshed', { provider: 'github-copilot', expiresAt: token.expiresAt })
  } catch (error) {
    runnerErrorLogger('opencode_auth_failed', error)
  }
}

type OpencodeAuthEntry = {
  type: string
  refresh?: string
  access?: string
  expires?: number
}

type OpencodeAuthFile = Record<string, OpencodeAuthEntry>

const getOpencodeAuthFilePath = (): string => {
  const home = os.homedir()
  return path.join(home, '.local', 'share', 'opencode', 'auth.json')
}

const readOpencodeAuthFile = async (filePath: string): Promise<OpencodeAuthFile> => {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    if (!raw.trim()) {
      return {}
    }
    return JSON.parse(raw)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}
    }
    throw error
  }
}

type CopilotTokenResponse = {
  token: string
  expires_at: string
  refresh_token?: string
}

const fetchCopilotTokens = async (
  pat: string
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> => {
  const response = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: {
      Authorization: `token ${pat}`,
      'User-Agent': 'hyperagent-workflow-runner',
      Accept: 'application/json'
    }
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`GitHub Copilot token fetch failed with ${response.status}: ${body}`)
  }
  const payload = (await response.json()) as CopilotTokenResponse
  if (!payload.token || !payload.expires_at) {
    throw new Error('GitHub Copilot token response missing token or expires_at')
  }
  const expiresAt = Date.parse(payload.expires_at)
  if (Number.isNaN(expiresAt)) {
    throw new Error(`GitHub Copilot token response has invalid expires_at: ${payload.expires_at}`)
  }
  return {
    accessToken: payload.token,
    refreshToken: payload.refresh_token ?? pat,
    expiresAt
  }
}

const runnerLogger = (event: string, metadata?: Record<string, unknown>) => {
  if (metadata) {
    console.log(`[workflow-runner] ${event}`, metadata)
    return
  }
  console.log(`[workflow-runner] ${event}`)
}

const AGENT_STREAM_PREFIX = '[agent-stream]'

const createAgentStreamLogger = (workflowId: string, stepId: string, runnerInstanceId: string): AgentStreamCallback => {
  return (event) => {
    try {
      const payload = {
        event: 'agent.stream',
        workflowId,
        stepId,
        runnerInstanceId,
        timestamp: new Date().toISOString(),
        data: {
          role: event.role,
          round: event.round,
          chunk: event.chunk,
          provider: event.provider,
          model: event.model,
          attempt: event.attempt,
          sessionId: event.sessionId ?? null
        }
      }
      console.log(`${AGENT_STREAM_PREFIX} ${JSON.stringify(payload)}`)
    } catch (error) {
      runnerErrorLogger('agent_stream_log_failed', error, { workflowId, stepId })
    }
  }
}

const runnerErrorLogger = (event: string, error: unknown, metadata?: Record<string, unknown>) => {
  const payload = {
    ...(metadata ?? {}),
    error:
      error instanceof Error
        ? { message: error.message, stack: error.stack }
        : typeof error === 'string'
          ? { message: error }
          : error
  }
  console.error(`[workflow-runner] ${event}`, payload)
}

const requireEnv = (key: string): string => {
  const value = process.env[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing required environment variable: ${key}`)
  }
  return value.trim()
}

const ensurePathExists = async (targetPath: string, description: string) => {
  try {
    const stats = await fs.stat(targetPath)
    if (!stats.isDirectory() && !stats.isFile()) {
      throw new Error(`${description} is not accessible: ${targetPath}`)
    }
  } catch (error) {
    throw new Error(`${description} is unavailable at ${targetPath}: ${error instanceof Error ? error.message : error}`)
  }
}

const noopRunnerGateway: WorkflowRunnerGateway = {
  enqueue: async () => {
    throw new Error('Standalone workflow runner cannot enqueue workflow steps')
  }
}

const resolveCommitAuthor = () => {
  const detected = detectGitAuthorFromCli()
  if (detected) return detected
  return {
    name: process.env.WORKFLOW_AUTHOR_NAME?.trim() || 'Hyperagent Workflow',
    email: process.env.WORKFLOW_AUTHOR_EMAIL?.trim() || 'workflow@hyperagent.local'
  }
}

const resolveAgentOptions = () => {
  const provider = (process.env.WORKFLOW_AGENT_PROVIDER?.trim() || 'opencode') as Provider
  const model = process.env.WORKFLOW_AGENT_MODEL?.trim() || 'github-copilot/gpt-5-mini'
  const maxRoundsEnv = process.env.WORKFLOW_AGENT_MAX_ROUNDS
  const maxRounds = maxRoundsEnv && Number.isFinite(Number(maxRoundsEnv)) ? Number(maxRoundsEnv) : undefined
  return { provider, model, maxRounds }
}

const resolveCallbackUrl = (baseUrl: string | undefined, workflowId: string, stepId: string): string | null => {
  if (!baseUrl) return null
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  return `${trimmed}/api/workflows/${encodeURIComponent(workflowId)}/steps/${encodeURIComponent(stepId)}/callback`
}

const sendCallbackNotification = async (options: {
  url: string | null
  token?: string
  runnerInstanceId: string
  status: 'completed' | 'failed'
  error?: string
}) => {
  if (!options.url) return
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.token) {
    headers['x-workflow-runner-token'] = options.token
  }
  const payload = {
    runnerInstanceId: options.runnerInstanceId,
    mode: 'finished',
    status: options.status,
    error: options.error
  }
  const maxAttempts = 3
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(options.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      })
      if (!response.ok) {
        throw new Error(`Callback responded with ${response.status}`)
      }
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt < maxAttempts) {
        await sleep(500 * attempt)
        continue
      }
      throw lastError
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const workflowId = requireEnv('WORKFLOW_ID')
  const stepId = requireEnv('WORKFLOW_STEP_ID')
  const runnerInstanceId = requireEnv('WORKFLOW_RUNNER_ID')
  const dbPath = requireEnv('WORKFLOW_DB_PATH')
  const repositoryPath = requireEnv('WORKFLOW_REPO_PATH')
  const callbackBase = process.env.WORKFLOW_CALLBACK_BASE_URL?.trim()
  const callbackUrl = resolveCallbackUrl(callbackBase, workflowId, stepId)
  const callbackToken = process.env.WORKFLOW_CALLBACK_TOKEN?.trim()

  await ensurePathExists(path.dirname(dbPath), 'Workflow database directory')
  await ensurePathExists(repositoryPath, 'Workflow repository path')
  await ensureOpencodeGitHubAuth()

  runnerLogger('starting', {
    workflowId,
    stepId,
    runnerInstanceId,
    dbPath,
    repositoryPath,
    callbackUrlPresent: Boolean(callbackUrl)
  })

  const radicleTempRoot = process.env.RADICLE_TEMP_DIR
  const useTestRadicleModule = (process.env.WORKFLOW_TEST_RADICLE ?? '').trim().toLowerCase() === 'worktree'
  const radicle: RadicleModule = useTestRadicleModule
    ? createTestRadicleModule(repositoryPath, {
        makeTempDir: radicleTempRoot ? (prefix) => makeTempDirAtRoot(radicleTempRoot, prefix) : undefined
      })
    : createRadicleModule({
        defaultRemote: process.env.RADICLE_REMOTE ?? 'origin',
        tempRootDir: radicleTempRoot,
        radCliPath: process.env.RADICLE_CLI_PATH
      })

  const persistence = createPersistence({ file: dbPath })
  const pullRequestModule = createPullRequestModule({
    projects: persistence.projects,
    pullRequests: persistence.pullRequests,
    pullRequestCommits: persistence.pullRequestCommits,
    pullRequestEvents: persistence.pullRequestEvents
  })
  const workflowPolicy = createWorkflowPolicyFromEnv(process.env)
  const commitAuthor = resolveCommitAuthor()
  const workflowTestAgent = (process.env.WORKFLOW_TEST_AGENT ?? '').trim().toLowerCase()
  const useDeterministicAgent = workflowTestAgent === 'deterministic'
  const useFallbackAgent = workflowTestAgent === 'fallback'
  const testAgentBehavior = (process.env.WORKFLOW_TEST_AGENT_BEHAVIOR ?? 'default').trim().toLowerCase()
  const agentOptions = useDeterministicAgent || useFallbackAgent ? null : resolveAgentOptions()

  const workflowRuntime = createWorkflowRuntime({
    persistence,
    persistenceFilePath: dbPath,
    runnerGateway: noopRunnerGateway,
    radicle,
    pullRequestModule,
    commitAuthor,
    ...(useFallbackAgent
      ? { agentExecutor: createFallbackAgentExecutor(testAgentBehavior) }
      : useDeterministicAgent
        ? { agentExecutor: createDeterministicAgentExecutor(testAgentBehavior) }
        : {
            agentExecutorOptions: {
              runLoop: runVerifierWorkerLoop,
              provider: agentOptions!.provider,
              model: agentOptions!.model,
              maxRounds: agentOptions!.maxRounds,
              onStream: createAgentStreamLogger(workflowId, stepId, runnerInstanceId)
            }
          }),
    policy: workflowPolicy
  })

  let status: 'completed' | 'failed' = 'completed'
  let errorMessage: string | undefined
  let executionError: Error | null = null

  try {
    await workflowRuntime.runStepById({ workflowId, stepId, runnerInstanceId })
    runnerLogger('completed', { workflowId, stepId })
  } catch (error) {
    executionError = error instanceof Error ? error : new Error(String(error))
    status = 'failed'
    errorMessage = executionError.message
    runnerErrorLogger('execution_failed', executionError, { workflowId, stepId })
    throw executionError
  } finally {
    try {
      await sendCallbackNotification({
        url: callbackUrl,
        token: callbackToken,
        runnerInstanceId,
        status,
        error: errorMessage
      })
    } catch (error) {
      const callbackFailure = error instanceof Error ? error : new Error(String(error))
      runnerErrorLogger('callback_failed', callbackFailure, {
        workflowId,
        stepId,
        callbackUrlPresent: Boolean(callbackUrl)
      })
      try {
        persistence.workflowRunnerEvents.insert({
          workflowId,
          stepId,
          type: 'runner.callback',
          status: 'failed',
          runnerInstanceId,
          metadata: {
            error: callbackFailure.message
          }
        })
      } catch (persistError) {
        runnerErrorLogger('callback_event_persist_failed', persistError, {
          workflowId,
          stepId
        })
      }
    }
    await workflowRuntime.stopWorker().catch(() => undefined)
    persistence.db.close()
    await radicle.cleanup()
  }
}

main().catch((error) => {
  runnerErrorLogger('fatal', error)
  process.exitCode = 1
})

const createDeterministicAgentExecutor = (behavior: string): AgentExecutor => {
  return async ({ workflow, step, workspace, project }) => {
    const workspacePath = workspace?.workspacePath ?? project.repositoryPath
    const artifactPath = path.join(workspacePath, 'AGENTIC_RESULT.md')
    await fs.writeFile(artifactPath, `# PR Artifact\nworkflow=${workflow.id}\nstep=${step.id}\n`, 'utf8')
    if (behavior !== 'skip-commit') {
      runGitCommandSync(['add', 'AGENTIC_RESULT.md'], workspacePath)
    }
    const summary = 'agentic pr workflow complete'
    return {
      stepResult: {
        summary,
        agent: {
          outcome: 'approved',
          reason: 'deterministic workflow harness'
        },
        artifactPath
      },
      commitMessage:
        behavior === 'skip-commit'
          ? undefined
          : `${workflow.kind}: ${typeof step.data.title === 'string' ? step.data.title : step.id}`,
      skipCommit: behavior === 'skip-commit'
    }
  }
}

const createFallbackAgentExecutor = (behavior: string): AgentExecutor => {
  const message =
    behavior === 'invalid-json'
      ? 'verifier returned invalid JSON: SyntaxError: Unterminated string in JSON at position 1803'
      : 'workflow agent provider unavailable during test fallback'
  const failingRunLoop = async () => {
    throw new Error(message)
  }
  return createAgentWorkflowExecutor({
    runLoop: failingRunLoop,
    maxRounds: 1
  })
}

const makeTempDirAtRoot = async (root: string, prefix: string): Promise<string> => {
  await fs.mkdir(root, { recursive: true })
  return fs.mkdtemp(path.join(root, prefix))
}
