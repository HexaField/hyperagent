import express from 'express'
import fs from 'fs/promises'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { createPersistence, type Persistence, type ProjectRecord } from '../../src/modules/database'
import { createRadicleModule } from '../../src/modules/radicle'
import type { CommitResult, RadicleModule } from '../../src/modules/radicle/types'
import { createPullRequestModule } from '../../src/modules/review/pullRequest'
import {
  createDockerWorkflowRunnerGateway,
  type DockerRunnerMount
} from '../../src/modules/workflowRunnerGateway'
import {
  createWorkflowRuntime,
  type AgentExecutor,
  type PlannerRun,
  type WorkflowDetail,
  type WorkflowRuntime
} from '../../src/modules/workflows'

const TEST_TIMEOUT_MS = 1_200_000
const RUNNER_IMAGE = process.env.WORKFLOW_E2E_RUNNER_IMAGE ?? 'hyperagent-workflow-runner:latest'

const plannerRun: PlannerRun = {
  id: `workflow-e2e-${Date.now()}`,
  kind: 'e2e-pr',
  tasks: [
    {
      id: 'task-1',
      title: 'Agentic PR flow',
      instructions: 'Implement the requested change using the multi-agent runner and prepare a PR-ready branch.'
    }
  ]
}

const multiStepPlannerRun: PlannerRun = {
  id: `workflow-e2e-multi-${Date.now()}`,
  kind: 'e2e-pr',
  tasks: [
    {
      id: 'task-bootstrap',
      title: 'Bootstrap workspace',
      instructions: 'Set up the environment.'
    },
    {
      id: 'task-build',
      title: 'Implement feature',
      instructions: 'Apply code changes.',
      dependsOn: ['task-bootstrap']
    }
  ]
}

describe('workflow e2e', () => {
  it(
    'runs a real workflow on a temporary repository via the docker callback runner',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      ensureCommand('docker')

      const harness = await createWorkflowHarness()

      try {
        await harness.server.attachRuntime(harness.runtime)
        const workflow = harness.runtime.createWorkflowFromPlan({
          projectId: harness.project.id,
          plannerRun
        })

        harness.runtime.startWorkflow(workflow.id)
        harness.runtime.startWorker()

        const stepId = `${workflow.id}:${plannerRun.tasks[0]!.id}`

        await waitFor(
          () => harness.persistence.workflowSteps.getById(stepId)?.status === 'running',
          30_000,
          'workflow step never entered running state'
        )

        await waitFor(() => harness.server.getHitCount() > 0, 30_000, 'docker runner never called back')

        const detail = await waitForWorkflowCompletion(harness.runtime, workflow.id, 300_000)

        expect(detail.workflow.status).toBe('completed')
        expect(detail.steps).toHaveLength(1)
        expect(detail.steps[0].status).toBe('completed')
        const stepResult = detail.steps[0].result as StepResultShape | undefined
        expect(stepResult?.summary).toContain('agentic pr workflow complete')
        expect(stepResult?.provenance).toBeDefined()
        const logsPath = stepResult?.provenance?.logsPath
        expect(typeof logsPath).toBe('string')
        if (!logsPath) {
          throw new Error('logsPath missing from provenance result')
        }
        const logContent = JSON.parse(await fs.readFile(logsPath, 'utf8'))
        const repoRealPath = await fs.realpath(harness.repoPath)
        const logRepoRealPath = await fs.realpath(logContent.repositoryPath)
        expect(logContent.workflowId).toBe(workflow.id)
        expect(logContent.stepId).toBe(stepId)
        expect(logRepoRealPath).toBe(repoRealPath)
        const workspaceInfo = stepResult?.workspace
        expect(workspaceInfo?.workspacePath).toBeTruthy()
        if (!workspaceInfo) {
          throw new Error('workspace info missing in step result')
        }
        expect(path.resolve(workspaceInfo.workspacePath)).not.toBe(path.resolve(harness.repoPath))
        const agentOutcome = stepResult?.agent?.outcome
        expect(agentOutcome).toBe('approved')
        const commitResult = stepResult?.commit
        expect(commitResult?.branch).toMatch(/^wf-/)
        expect(commitResult?.commitHash).toMatch(/[0-9a-f]{6,}/)
        if (!commitResult) {
          throw new Error('Missing commit result')
        }
        const branchListing = runGit(['branch', '--list', commitResult.branch], harness.repoPath)
        expect(branchListing).toContain(commitResult.branch)
        const artifactContent = runGit(['show', `${commitResult.branch}:AGENTIC_RESULT.md`], harness.repoPath)
        expect(artifactContent).toContain(`workflow=${workflow.id}`)
        const pullRequests = harness.persistence.pullRequests.listByProject(harness.project.id)
        expect(pullRequests.length).toBe(1)
        const createdPr = pullRequests[0]
        expect(createdPr.sourceBranch).toBe(commitResult.branch)
        const resultPr = stepResult?.pullRequest
        expect(resultPr?.id).toBe(createdPr.id)
      } finally {
        await harness.teardown()
      }
    }
  )

  it(
    'pushes workflow commits to the rad remote through the docker runner image',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      ensureCommand('docker')
      let radCli: Awaited<ReturnType<typeof createRadCliSpy>> | null = null
      let radRemotePath: string | null = null

      const harness = await createWorkflowHarness({
        radicleFactory: async (repoPath) => {
          const radRemote = await createBareRemoteRepo(path.dirname(repoPath))
          radRemotePath = radRemote.dir
          runGit(['remote', 'add', 'rad', radRemote.dir], repoPath)
          radCli = await createRadCliSpy({ baseDir: repoPath })
          const module = createRadicleModule({
            defaultRemote: 'rad',
            radCliPath: radCli.binPath,
            tempRootDir: path.join(os.tmpdir(), 'radicle-e2e-workspaces')
          })
          return {
            module,
            cleanup: async () => {
              await module.cleanup()
              await radRemote.cleanup()
            },
            runnerEnv: {
              RADICLE_REMOTE: 'rad',
              RADICLE_CLI_PATH: radCli.binPath
            }
          }
        }
      })

      try {
        await harness.server.attachRuntime(harness.runtime)
        const workflow = harness.runtime.createWorkflowFromPlan({ projectId: harness.project.id, plannerRun })
        harness.runtime.startWorkflow(workflow.id)
        harness.runtime.startWorker()

        await waitFor(() => harness.server.getHitCount() >= 1, 30_000, 'docker runner never called back')

        const detail = await waitForWorkflowCompletion(harness.runtime, workflow.id, 300_000)
        expect(detail.workflow.status).toBe('completed')
        const [step] = detail.steps
        expect(step?.status).toBe('completed')
        const stepResult = step?.result as StepResultShape | undefined
        const commitResult = stepResult?.commit
        expect(commitResult?.branch).toBeDefined()
        expect(radRemotePath).toBeTruthy()
        expect(remoteHasBranch(radRemotePath ?? '', commitResult?.branch ?? '')).toBe(true)

        if (!radCli) {
          throw new Error('rad CLI spy not initialized')
        }
        const radLog = await fs.readFile(radCli.logPath, 'utf8')
        expect(radLog.trim().length).toBeGreaterThan(0)
        expect(radLog).toMatch(/push rad /)
      } finally {
        await harness.teardown()
        if (radCli) {
          await radCli.cleanup()
        }
      }
    }
  )

  it(
    'executes multi-step workflows through the docker runner in order',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      ensureCommand('docker')
      const harness = await createWorkflowHarness()
      try {
        const { detail } = await runWorkflowAndAwait(harness, multiStepPlannerRun, multiStepPlannerRun.tasks.length)
        expect(detail.steps).toHaveLength(multiStepPlannerRun.tasks.length)
        expect(detail.steps.every((step) => step.status === 'completed')).toBe(true)
        expect(harness.server.getHitCount()).toBeGreaterThanOrEqual(multiStepPlannerRun.tasks.length)
      } finally {
        await harness.teardown()
      }
    }
  )

  it(
    'recovers when the docker runner needs to retry after a failed callback',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      ensureCommand('docker')
      const harness = await createWorkflowHarness({ callbackOptions: { failInitialCallbacks: 1 } })
      try {
        const { workflow, detail } = await runWorkflowAndAwait(harness, plannerRun, 1)
        expect(detail.workflow.status).toBe('completed')
        expect(harness.server.getFailureCount()).toBe(1)
        const events = harness.persistence.workflowRunnerEvents.listByWorkflow(workflow.id, 10)
        const hasFailure = events.some(
          (event) => event.type === 'runner.callback' && event.status === 'failed'
        )
        expect(hasFailure).toBe(true)
      } finally {
        await harness.teardown()
      }
    }
  )

  it(
    'skips pull request creation when agents opt out of committing changes',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      ensureCommand('docker')
      const harness = await createWorkflowHarness({
        runnerEnv: {
          WORKFLOW_TEST_AGENT: 'deterministic',
          WORKFLOW_TEST_AGENT_BEHAVIOR: 'skip-commit'
        }
      })
      try {
        const { detail } = await runWorkflowAndAwait(harness, plannerRun, 1)
        const [step] = detail.steps
        expect(step?.result?.pullRequest).toBeUndefined()
        const prs = harness.persistence.pullRequests.listByProject(harness.project.id)
        expect(prs.length).toBe(0)
      } finally {
        await harness.teardown()
      }
    }
  )
})

function ensureCommand(cmd: string) {
  const result = spawnSync('which', [cmd])
  if (result.status !== 0) {
    throw new Error(`${cmd} CLI is required to run workflow e2e tests`)
  }
}

type WorkflowHarness = {
  repoPath: string
  runtime: WorkflowRuntime
  persistence: Persistence
  project: ProjectRecord
  server: CallbackServer
  radicle: RadicleModule
  pullRequestModule: ReturnType<typeof createPullRequestModule>
  teardown: () => Promise<void>
}

type CallbackServer = {
  baseUrl: string
  attachRuntime: (runtime: WorkflowRuntime) => Promise<void>
  getHitCount: () => number
  getFailureCount: () => number
  close: () => Promise<void>
}

type StepResultShape = {
  summary?: string
  provenance?: { logsPath?: string }
  workspace?: { workspacePath: string }
  agent?: { outcome?: string }
  commit?: { branch: string; commitHash: string }
  pullRequest?: { id: string }
}

type RadicleFactoryResult = {
  module: RadicleModule
  cleanup?: () => Promise<void>
  runnerEnv?: Record<string, string>
  runnerMounts?: DockerRunnerMount[]
}

type WorkflowHarnessOptions = {
  plannerRun?: PlannerRun
  agentExecutor?: AgentExecutor
  radicleFactory?: (repoPath: string) => Promise<RadicleFactoryResult>
  runnerImage?: string
  callbackOptions?: CallbackServerOptions
  runnerEnv?: Record<string, string>
}

type CallbackServerOptions = {
  failInitialCallbacks?: number
}

type WorkflowRunnerToolchain = {
  env: Record<string, string>
  mounts: DockerRunnerMount[]
  cleanup: () => Promise<void>
}

async function createWorkflowHarness(options: WorkflowHarnessOptions = {}): Promise<WorkflowHarness> {
  const tmpRoot = await makeWorkspaceTempDir('workflow-e2e-')
  const repoPath = path.join(tmpRoot, 'repo')
  await fs.mkdir(repoPath, { recursive: true })
  await initializeRepository(repoPath)
  const originRemotePath = path.join(tmpRoot, 'origin.git')
  await initializeBareRemote(originRemotePath)
  runGit(['remote', 'add', 'origin', originRemotePath], repoPath)
  runGit(['push', '-u', 'origin', 'main'], repoPath)
  const persistenceFile = path.join(tmpRoot, 'runtime.db')
  const persistence = createPersistence({ file: persistenceFile })
  const persistenceRealPath = await fs.realpath(persistenceFile)
  persistence.radicleRegistrations.upsert({
    repositoryPath: repoPath,
    name: 'workflow-e2e',
    defaultBranch: 'main'
  })
  const project = persistence.projects.getByRepositoryPath(repoPath)
  if (!project) {
    throw new Error('Failed to register workflow e2e project')
  }
  const radicleHandle = options.radicleFactory
    ? await options.radicleFactory(repoPath)
    : { module: createTestRadicleModule(repoPath) }
  const radicle = radicleHandle.module
  const radicleCleanup = radicleHandle.cleanup
    ? radicleHandle.cleanup
    : async () => {
        await radicle.cleanup()
      }
  const callbackToken = `workflow-runner-${Date.now()}`
  const server = await startCallbackServer(callbackToken, options.callbackOptions)
  const runnerEnvOverrides = {
    ...(radicleHandle.runnerEnv ?? {}),
    ...(options.runnerEnv ?? {})
  }
  const runnerToolchain = await prepareWorkflowRunnerToolchain({ envOverrides: runnerEnvOverrides })
  const runnerGateway = createDockerWorkflowRunnerGateway({
    image: options.runnerImage ?? RUNNER_IMAGE,
    callbackBaseUrl: server.baseUrl,
    callbackToken,
    timeoutMs: 300_000,
    extraEnv: runnerToolchain.env,
    mounts: [...(radicleHandle.runnerMounts ?? []), ...runnerToolchain.mounts]
  })
  const pullRequestModule = createPullRequestModule({
    projects: persistence.projects,
    pullRequests: persistence.pullRequests,
    pullRequestCommits: persistence.pullRequestCommits,
    pullRequestEvents: persistence.pullRequestEvents
  })
  const agentExecutor: AgentExecutor =
    options.agentExecutor ??
    (async ({ workflow, step, workspace, project }) => {
      const workspacePath = workspace?.workspacePath ?? project.repositoryPath
      const artifactPath = path.join(workspacePath, 'AGENTIC_RESULT.md')
      await fs.writeFile(artifactPath, `# PR Artifact\nworkflow=${workflow.id}\nstep=${step.id}\n`, 'utf8')
      runGit(['add', 'AGENTIC_RESULT.md'], workspacePath)
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
        commitMessage: `${workflow.kind}: ${typeof step.data.title === 'string' ? step.data.title : step.id}`,
        skipCommit: false
      }
    })
  const runtime = createWorkflowRuntime({
    persistence: {
      projects: persistence.projects,
      workflows: persistence.workflows,
      workflowSteps: persistence.workflowSteps,
      agentRuns: persistence.agentRuns,
      workflowRunnerDeadLetters: persistence.workflowRunnerDeadLetters,
      workflowRunnerEvents: persistence.workflowRunnerEvents
    },
    persistenceFilePath: persistenceRealPath,
    runnerGateway,
    agentExecutor,
    pollIntervalMs: 50,
    commitAuthor: { name: 'Workflow E2E', email: 'workflow-e2e@hyperagent.local' },
    radicle,
    pullRequestModule
  })
  const teardown = async () => {
    await runtime.stopWorker()
    await server.close()
    await radicleCleanup()
    await runnerToolchain.cleanup()
    persistence.db.close()
    await fs.rm(tmpRoot, { recursive: true, force: true })
  }
  return {
    repoPath,
    runtime,
    persistence,
    project,
    server,
    radicle,
    pullRequestModule,
    teardown
  }
}

async function initializeRepository(repoPath: string) {
  await fs.mkdir(path.join(repoPath, '.hyperagent'), { recursive: true })
  runGit(['init'], repoPath)
  runGit(['checkout', '-B', 'main'], repoPath)
  runGit(['config', 'user.name', 'Workflow E2E'], repoPath)
  runGit(['config', 'user.email', 'workflow-e2e@hyperagent.local'], repoPath)
  await fs.writeFile(path.join(repoPath, 'README.md'), '# Workflow E2E\n', 'utf8')
  runGit(['add', '.'], repoPath)
  runGit(['commit', '-m', 'initial commit'], repoPath)
}

async function initializeBareRemote(remotePath: string) {
  await fs.mkdir(path.dirname(remotePath), { recursive: true })
  runGit(['init', '--bare', remotePath], process.cwd())
}

function runGit(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return (result.stdout ?? '').trim()
}

async function startCallbackServer(expectedToken: string, options: CallbackServerOptions = {}): Promise<CallbackServer> {
  const app = express()
  app.use(express.json())
  let runtimeRef: WorkflowRuntime | null = null
  let hits = 0
  let failuresRemaining = options.failInitialCallbacks ?? 0
  let failureCount = 0

  app.post('/api/workflows/:workflowId/steps/:stepId/callback', async (req, res) => {
    if (req.header('x-workflow-runner-token') !== expectedToken) {
      res.status(401).json({ error: 'Invalid runner token' })
      return
    }
    if (failuresRemaining > 0) {
      failuresRemaining -= 1
      failureCount += 1
      res.status(500).json({ error: 'runner initialization failed' })
      return
    }
    if (!runtimeRef) {
      res.status(503).json({ error: 'Runtime not ready' })
      return
    }
    const runnerInstanceId = typeof req.body?.runnerInstanceId === 'string' ? req.body.runnerInstanceId : ''
    if (!runnerInstanceId) {
      res.status(400).json({ error: 'runnerInstanceId is required' })
      return
    }
    const workflowId = req.params.workflowId
    const stepId = req.params.stepId
    try {
      hits += 1
      await runtimeRef.runStepById({ workflowId, stepId, runnerInstanceId })
      res.json({ ok: true })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Step execution failed' })
    }
  })

  const server = app.listen(0, '0.0.0.0')
  await once(server, 'listening')
  const address = server.address() as AddressInfo | null
  if (!address) {
    throw new Error('Unable to start callback server')
  }
  const callbackHost = process.env.WORKFLOW_E2E_CALLBACK_HOST ?? 'host.docker.internal'
  const baseUrl = `http://${callbackHost}:${address.port}`

  return {
    baseUrl,
    attachRuntime: async (runtime) => {
      runtimeRef = runtime
    },
    getHitCount: () => hits,
    getFailureCount: () => failureCount,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  }
}

async function waitForWorkflowCompletion(
  runtime: WorkflowRuntime,
  workflowId: string,
  timeoutMs: number
): Promise<WorkflowDetail> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const detail = runtime.getWorkflowDetail(workflowId)
    if (detail) {
      if (detail.workflow.status === 'completed') {
        return detail
      }
      if (detail.workflow.status === 'failed') {
        throw new Error(`Workflow failed: ${JSON.stringify(detail.steps[0]?.result ?? {})}`)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out waiting for workflow completion')
}

async function waitFor(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(message)
}

async function runWorkflowAndAwait(
  harness: WorkflowHarness,
  plan: PlannerRun,
  expectedRunnerHits: number,
  timeoutMs = 300_000
): Promise<{ workflow: WorkflowDetail['workflow']; detail: WorkflowDetail }> {
  await harness.server.attachRuntime(harness.runtime)
  const workflow = harness.runtime.createWorkflowFromPlan({ projectId: harness.project.id, plannerRun: plan })
  harness.runtime.startWorkflow(workflow.id)
  harness.runtime.startWorker()
  await waitFor(() => harness.server.getHitCount() >= expectedRunnerHits, 60_000, 'docker runner never called back')
  const detail = await waitForWorkflowCompletion(harness.runtime, workflow.id, timeoutMs)
  return { workflow: detail.workflow, detail }
}

function createTestRadicleModule(repoPath: string): RadicleModule {
  const activeWorkspaces = new Map<string, string>()
  const cleanupWorkspace = async (workspacePath: string) => {
    if (!activeWorkspaces.has(workspacePath)) return
    try {
      runGit(['worktree', 'remove', '--force', workspacePath], repoPath)
    } catch {
      // ignore missing worktree failures during cleanup
    }
    await fs.rm(path.dirname(workspacePath), { recursive: true, force: true }).catch(() => undefined)
    activeWorkspaces.delete(workspacePath)
  }

  return {
    createSession: async (init) => {
      let workspaceInfo: { workspacePath: string; branchName: string; baseBranch: string } | null = null
      let closed = false
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), `radicle-workspace-${init.taskId}-`))
      const workspacePath = path.join(workspaceRoot, 'worktree')

      const start = async () => {
        if (workspaceInfo) return workspaceInfo
        await fs.mkdir(workspaceRoot, { recursive: true })
        runGit(['worktree', 'add', '-B', init.branchInfo.name, workspacePath, init.branchInfo.baseBranch], repoPath)
        workspaceInfo = {
          workspacePath,
          branchName: init.branchInfo.name,
          baseBranch: init.branchInfo.baseBranch
        }
        activeWorkspaces.set(workspacePath, workspacePath)
        return workspaceInfo
      }

      const getWorkspace = () => {
        if (!workspaceInfo) {
          throw new Error('Radicle session has not been started')
        }
        return workspaceInfo
      }

      const commit = async (message: string): Promise<CommitResult | null> => {
        const workspace = getWorkspace()
        const status = runGit(['status', '--porcelain'], workspace.workspacePath)
        if (!status.trim()) {
          return null
        }
        runGit(['config', 'user.name', init.author.name], workspace.workspacePath)
        runGit(['config', 'user.email', init.author.email], workspace.workspacePath)
        runGit(['add', '--all'], workspace.workspacePath)
        runGit(['commit', '-m', message], workspace.workspacePath)
        const commitHash = runGit(['rev-parse', 'HEAD'], workspace.workspacePath)
        const changedFilesRaw = runGit(['show', '--pretty=', '--name-only', 'HEAD'], workspace.workspacePath)
        const changedFiles = changedFilesRaw
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
        return {
          branch: workspace.branchName,
          commitHash,
          message,
          changedFiles
        }
      }

      const finish = async (message: string) => {
        const result = await commit(message)
        await cleanup()
        return result
      }

      const abort = async () => {
        await cleanup()
      }

      const cleanup = async () => {
        if (closed || !workspaceInfo) return
        closed = true
        await cleanupWorkspace(workspaceInfo.workspacePath)
        workspaceInfo = null
      }

      return {
        start,
        getWorkspace,
        commitAndPush: commit,
        finish,
        abort
      }
    },
    cleanup: async () => {
      for (const workspacePath of activeWorkspaces.keys()) {
        await cleanupWorkspace(workspacePath)
      }
    },
    inspectRepository: async () => ({
      repositoryPath: repoPath,
      radicleProjectId: 'rad:e2e',
      remoteUrl: repoPath,
      defaultBranch: 'main',
      registered: true
    }),
    registerRepository: async () => ({
      repositoryPath: repoPath,
      radicleProjectId: 'rad:e2e',
      remoteUrl: repoPath,
      defaultBranch: 'main',
      registered: true
    }),
    getStatus: async () => ({ reachable: true, loggedIn: true, identity: 'rad-e2e', alias: 'rad-e2e' })
  }
}

async function prepareWorkflowRunnerToolchain(options: { envOverrides?: Record<string, string> } = {}): Promise<WorkflowRunnerToolchain> {
  const env: Record<string, string> = {
    WORKFLOW_TEST_AGENT: process.env.WORKFLOW_E2E_AGENT_MODE?.trim() || 'deterministic',
    RADICLE_REMOTE: process.env.WORKFLOW_E2E_RAD_REMOTE?.trim() || 'origin'
  }
  if (options.envOverrides) {
    for (const [key, value] of Object.entries(options.envOverrides)) {
      if (typeof value === 'string' && value.length) {
        env[key] = value
      }
    }
  }
  const mounts: DockerRunnerMount[] = []
  const cleanupTasks: Array<() => Promise<void>> = []

  const radHomeBinding = await prepareRadHomeMount()
  if (radHomeBinding) {
    env.RAD_HOME = radHomeBinding.envValue
    mounts.push(radHomeBinding.mount)
    cleanupTasks.push(radHomeBinding.cleanup)
  }

  return {
    env,
    mounts,
    cleanup: async () => {
      for (const task of cleanupTasks.reverse()) {
        try {
          await task()
        } catch {
          // ignore cleanup errors to avoid masking test failures
        }
      }
    }
  }
}

type RadHomeMountBinding = {
  envValue: string
  mount: DockerRunnerMount
  cleanup: () => Promise<void>
}

async function prepareRadHomeMount(): Promise<RadHomeMountBinding | null> {
  const resolved = await resolveRadHomePath()
  if (!resolved) {
    return null
  }
  const mount: DockerRunnerMount = {
    hostPath: resolved.path,
    containerPath: resolved.path,
    readOnly: false
  }
  return {
    envValue: resolved.path,
    mount,
    cleanup: resolved.cleanup
  }
}

type ResolvedRadHomePath = {
  path: string
  cleanup: () => Promise<void>
}

async function resolveRadHomePath(): Promise<ResolvedRadHomePath | null> {
  const rawExistingRadHome = process.env.RAD_HOME?.trim()
  if (rawExistingRadHome) {
    const resolved = path.resolve(rawExistingRadHome)
    await fs.mkdir(resolved, { recursive: true })
    return {
      path: resolved,
      cleanup: async () => {
        /* caller owns RAD_HOME, nothing to clean */
      }
    }
  }

  const fallbackRadHome = process.env.WORKFLOW_E2E_RAD_HOME?.trim()
  if (fallbackRadHome) {
    const resolved = path.resolve(fallbackRadHome)
    await fs.mkdir(resolved, { recursive: true })
    const previousRadHome = process.env.RAD_HOME
    process.env.RAD_HOME = resolved
    return {
      path: resolved,
      cleanup: async () => {
        if (previousRadHome === undefined) {
          delete process.env.RAD_HOME
        } else {
          process.env.RAD_HOME = previousRadHome
        }
      }
    }
  }

  const radHomePath = await makeWorkspaceTempDir('workflow-rad-home-')
  const previousRadHome = process.env.RAD_HOME
  const hadRadHome = typeof previousRadHome === 'string' && previousRadHome.trim().length > 0
  if (!hadRadHome) {
    process.env.RAD_HOME = radHomePath
  }
  return {
    path: radHomePath,
    cleanup: async () => {
      if (!hadRadHome) {
        if (previousRadHome === undefined) {
          delete process.env.RAD_HOME
        } else {
          process.env.RAD_HOME = previousRadHome
        }
      }
      await fs.rm(radHomePath, { recursive: true, force: true })
    }
  }
}

async function makeWorkspaceTempDir(prefix: string): Promise<string> {
  const baseDir = path.join(process.cwd(), '.tmp')
  await fs.mkdir(baseDir, { recursive: true })
  return fs.mkdtemp(path.join(baseDir, prefix))
}

type RadCliSpy = {
  binPath: string
  logPath: string
  cleanup: () => Promise<void>
}

async function createRadCliSpy(options: { baseDir?: string } = {}): Promise<RadCliSpy> {
  const rootDir = options.baseDir ? path.resolve(options.baseDir) : os.tmpdir()
  if (options.baseDir) {
    await fs.mkdir(rootDir, { recursive: true })
  }
  const dir = await fs.mkdtemp(path.join(rootDir, 'rad-cli-spy-'))
  const logPath = path.join(dir, 'rad.log')
  const binPath = path.join(dir, 'rad')
  const script = `#!/usr/bin/env bash
set -euo pipefail
echo "$@" >> "${logPath}"
`
  await fs.writeFile(binPath, script, { mode: 0o755 })
  return {
    binPath,
    logPath,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }
}

async function createBareRemoteRepo(baseDir?: string) {
  const root = baseDir ?? os.tmpdir()
  await fs.mkdir(root, { recursive: true })
  const dir = await fs.mkdtemp(path.join(root, 'rad-remote-'))
  runGit(['init', '--bare'], dir)
  return {
    dir,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }
}

function remoteHasBranch(remoteDir: string, branch: string): boolean {
  if (!branch.trim()) return false
  const result = spawnSync(
    'git',
    ['--git-dir', remoteDir, 'rev-parse', `refs/heads/${branch}`],
    { encoding: 'utf8' }
  )
  return result.status === 0
}
