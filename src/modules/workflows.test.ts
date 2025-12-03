import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { createPersistence, type Persistence } from './database'
import type { ProjectRecord } from './projects'
import type {
  CommitResult,
  RadicleModule,
  RadicleSessionHandle,
  RadicleSessionInit,
  WorkspaceInfo
} from './radicle/types'
import type { PullRequestModule } from './review/pullRequest'
import type { PullRequestRecord } from './review/types'
import type { WorkflowPolicy } from './workflowPolicy'
import type { WorkflowRunnerGateway, WorkflowRunnerPayload } from './workflowRunnerGateway'
import { createWorkflowRuntime, type AgentExecutor, type PlannerRun, type WorkflowRuntimeOptions } from './workflows'

const commitAuthor = { name: 'Test Workflow', email: 'workflow@test.local' }

const workflowStepId = (workflowId: string, taskId: string) => `${workflowId}:${taskId}`

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (condition()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for condition')
}

describe('workflow runtime docker runner integration', () => {
  const plannerRun: PlannerRun = {
    id: 'plan-1',
    kind: 'custom',
    tasks: [
      {
        id: 'task-1',
        title: 'Initial task',
        instructions: 'Do the important work'
      },
      {
        id: 'task-2',
        title: 'Follow up task',
        instructions: 'Finish the job',
        dependsOn: ['task-1']
      }
    ]
  }

  const singleTaskPlan: PlannerRun = {
    id: 'plan-single',
    kind: 'custom',
    tasks: [
      {
        id: 'solo-task',
        title: 'Solo task',
        instructions: 'Just one step'
      }
    ]
  }

  const createRadicleModuleStub = (overrides?: { finishThrows?: boolean }) => {
    const workspace: WorkspaceInfo = {
      workspacePath: '/tmp/radicle-workspace',
      branchName: 'wf-feature',
      baseBranch: 'main'
    }
    const commitResult: CommitResult = {
      branch: workspace.branchName,
      commitHash: 'abc1234',
      message: 'workflow commit',
      changedFiles: ['app.ts']
    }
    let startCount = 0
    let finishCount = 0
    let abortCount = 0
    const finishMessages: string[] = []
    const createSessionCalls: RadicleSessionInit[] = []

    const session: RadicleSessionHandle = {
      start: async () => {
        startCount += 1
        return workspace
      },
      getWorkspace: () => workspace,
      commitAndPush: async () => ({ ...commitResult }),
      finish: async (message: string) => {
        finishCount += 1
        finishMessages.push(message)
        if (overrides?.finishThrows) {
          throw new Error('rad push failed')
        }
        return { ...commitResult, message }
      },
      abort: async () => {
        abortCount += 1
      }
    }

    const module: RadicleModule = {
      createSession: async (init) => {
        createSessionCalls.push(init)
        return session
      },
      cleanup: async () => {},
      inspectRepository: async (repositoryPath) => ({
        repositoryPath,
        radicleProjectId: null,
        remoteUrl: null,
        defaultBranch: null,
        registered: false
      }),
      registerRepository: async (options) => ({
        repositoryPath: options.repositoryPath,
        radicleProjectId: null,
        remoteUrl: null,
        defaultBranch: null,
        registered: true
      }),
      getStatus: async () => ({
        reachable: true,
        loggedIn: true,
        identity: 'test',
        alias: 'test',
        message: null
      })
    }

    return {
      module,
      workspace,
      commitResult,
      stats: {
        get startCount() {
          return startCount
        },
        get finishCount() {
          return finishCount
        },
        get abortCount() {
          return abortCount
        },
        get finishMessages() {
          return [...finishMessages]
        },
        get createSessionCalls() {
          return [...createSessionCalls]
        }
      }
    }
  }

  const createPullRequestModuleStub = (record: PullRequestRecord) => {
    const createPullRequestSpy = vi.fn(async () => record)
    const module: PullRequestModule = {
      createPullRequest: createPullRequestSpy,
      listPullRequests: vi.fn(() => [record]),
      getPullRequestWithCommits: vi.fn(async () => null),
      updatePullRequestCommits: vi.fn(async () => {}),
      mergePullRequest: vi.fn(async () => {}),
      closePullRequest: vi.fn(async () => {})
    }
    return {
      module,
      spies: {
        createPullRequest: createPullRequestSpy
      }
    }
  }

  const createRuntime = (
    persistence: Persistence,
    runnerGateway: WorkflowRunnerGateway,
    agentExecutor?: AgentExecutor,
    extra?: {
      runnerRetry?: WorkflowRuntimeOptions['runnerRetry']
      pollIntervalMs?: number
      radicle?: WorkflowRuntimeOptions['radicle']
      pullRequestModule?: WorkflowRuntimeOptions['pullRequestModule']
      pullRequestAuthorUserId?: WorkflowRuntimeOptions['pullRequestAuthorUserId']
      policy?: WorkflowRuntimeOptions['policy']
    }
  ) => {
    return createWorkflowRuntime({
      persistence,
      persistenceFilePath: persistence.db.name,
      agentExecutor:
        agentExecutor ??
        (async () => ({
          stepResult: { summary: 'completed' },
          skipCommit: true
        })),
      runnerGateway,
      pollIntervalMs: extra?.pollIntervalMs ?? 25,
      commitAuthor,
      runnerRetry: extra?.runnerRetry,
      radicle: extra?.radicle,
      pullRequestModule: extra?.pullRequestModule,
      pullRequestAuthorUserId: extra?.pullRequestAuthorUserId,
      policy: extra?.policy
    })
  }

  const createProjectFixture = async (
    persistence: Persistence,
    name: string
  ): Promise<{
    project: ProjectRecord
    repoPath: string
  }> => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-runtime-'))
    await fs.mkdir(path.join(repoPath, '.hyperagent'), { recursive: true })
    persistence.radicleRegistrations.upsert({
      repositoryPath: repoPath,
      name,
      defaultBranch: 'main'
    })
    const project = persistence.projects.getByRepositoryPath(repoPath)
    if (!project) {
      throw new Error('Failed to register project fixture')
    }
    return { project, repoPath }
  }

  it('enqueues workflow steps through the runner gateway and executes via callback', async () => {
    const persistence = createPersistence({ file: ':memory:' })
    const { project, repoPath } = await createProjectFixture(persistence, 'demo')
    const runnerCalls: WorkflowRunnerPayload[] = []
    const runnerGateway: WorkflowRunnerGateway = {
      enqueue: async (payload) => {
        runnerCalls.push(payload)
      }
    }
    const runtime = createRuntime(persistence, runnerGateway)
    try {
      const workflow = runtime.createWorkflowFromPlan({ projectId: project.id, plannerRun })
      runtime.startWorkflow(workflow.id)
      runtime.startWorker()
      await waitFor(() => runnerCalls.length >= 1)
      const payload = runnerCalls[0]
      expect(payload.workflowId).toBe(workflow.id)
      await runtime.runStepById(payload)
      const detail = runtime.getWorkflowDetail(workflow.id)
      expect(detail).not.toBeNull()
      const steps = detail?.steps ?? []
      expect(steps[0]?.id).toBe(workflowStepId(workflow.id, 'task-1'))
      expect(steps[0]?.taskId).toBe('task-1')
      expect(steps[0]?.status).toBe('completed')
      expect(steps[0]?.runnerInstanceId).toBeNull()
      expect(steps[0]?.result?.summary).toBe('completed')
    } finally {
      await runtime.stopWorker()
      await fs.rm(repoPath, { recursive: true, force: true })
      persistence.db.close()
    }
  })

  it('respects dependsOn ordering and only enqueues ready steps', async () => {
    const persistence = createPersistence({ file: ':memory:' })
    const { project, repoPath } = await createProjectFixture(persistence, 'demo')
    const runnerCalls: WorkflowRunnerPayload[] = []
    const runnerGateway: WorkflowRunnerGateway = {
      enqueue: async (payload) => {
        runnerCalls.push(payload)
      }
    }
    const runtime = createRuntime(persistence, runnerGateway)
    try {
      const workflow = runtime.createWorkflowFromPlan({ projectId: project.id, plannerRun })
      runtime.startWorkflow(workflow.id)
      runtime.startWorker()
      await waitFor(() => runnerCalls.length >= 1)
      expect(runnerCalls[0]?.stepId).toBe(workflowStepId(workflow.id, 'task-1'))
      expect(runnerCalls.some((call) => call.stepId === workflowStepId(workflow.id, 'task-2'))).toBe(false)
      await runtime.runStepById(runnerCalls[0] as WorkflowRunnerPayload)
      await waitFor(() => runnerCalls.length >= 2)
      expect(runnerCalls[1]?.stepId).toBe(workflowStepId(workflow.id, 'task-2'))
    } finally {
      await runtime.stopWorker()
      await fs.rm(repoPath, { recursive: true, force: true })
      persistence.db.close()
    }
  })

  it('throws when planner dependencies reference unknown tasks', async () => {
    const persistence = createPersistence({ file: ':memory:' })
    const { project, repoPath } = await createProjectFixture(persistence, 'demo')
    const runnerGateway: WorkflowRunnerGateway = {
      enqueue: async () => {}
    }
    const runtime = createRuntime(persistence, runnerGateway)
    const invalidRun: PlannerRun = {
      id: 'plan-invalid',
      kind: 'bugfix',
      tasks: [
        { id: 'task-a', title: 'first', instructions: 'do it' },
        { id: 'task-b', title: 'second', instructions: 'later', dependsOn: ['missing'] }
      ]
    }
    try {
      expect(() => runtime.createWorkflowFromPlan({ projectId: project.id, plannerRun: invalidRun })).toThrow(
        /depends on unknown task/i
      )
    } finally {
      await runtime.stopWorker()
      await fs.rm(repoPath, { recursive: true, force: true })
      persistence.db.close()
    }
  })

  it('marks workflow and agent run as failed when agent outcome is not approved', async () => {
    const persistence = createPersistence({ file: ':memory:' })
    const { project, repoPath } = await createProjectFixture(persistence, 'demo')
    const runnerCalls: WorkflowRunnerPayload[] = []
    const runnerGateway: WorkflowRunnerGateway = {
      enqueue: async (payload) => {
        runnerCalls.push(payload)
      }
    }
    const agentExecutor: AgentExecutor = async () => ({
      stepResult: {
        summary: 'Rejected by verifier',
        agent: {
          outcome: 'failed',
          reason: 'Verifier rejected the work'
        }
      },
      skipCommit: true
    })
    const runtime = createRuntime(persistence, runnerGateway, agentExecutor)
    try {
      const workflow = runtime.createWorkflowFromPlan({ projectId: project.id, plannerRun })
      runtime.startWorkflow(workflow.id)
      runtime.startWorker()
      await waitFor(() => runnerCalls.length >= 1)
      const payload = runnerCalls[0]
      await runtime.runStepById(payload)
      const detail = runtime.getWorkflowDetail(workflow.id)
      expect(detail?.workflow.status).toBe('failed')
      expect(detail?.steps[0].status).toBe('failed')
      const runs = persistence.agentRuns.listByWorkflow(workflow.id)
      expect(runs[0]?.status).toBe('failed')
    } finally {
      await runtime.stopWorker()
      await fs.rm(repoPath, { recursive: true, force: true })
      persistence.db.close()
    }
  })

  it('rejects callbacks with mismatched runner instance ids', async () => {
    const persistence = createPersistence({ file: ':memory:' })
    const { project, repoPath } = await createProjectFixture(persistence, 'demo')
    const runnerGateway: WorkflowRunnerGateway = {
      enqueue: async () => {}
    }
    const runtime = createRuntime(persistence, runnerGateway)
    try {
      const workflow = runtime.createWorkflowFromPlan({ projectId: project.id, plannerRun })
      runtime.startWorkflow(workflow.id)
      const detail = runtime.getWorkflowDetail(workflow.id)
      const step = detail?.steps[0]
      expect(step).toBeDefined()
      if (!step) {
        throw new Error('step not created')
      }
      persistence.workflowSteps.update(step.id, { status: 'running', runnerInstanceId: 'expected' })
      await expect(
        runtime.runStepById({ workflowId: workflow.id, stepId: step.id, runnerInstanceId: 'wrong' })
      ).rejects.toThrow('Workflow runner token mismatch')
    } finally {
      await runtime.stopWorker()
      await fs.rm(repoPath, { recursive: true, force: true })
      persistence.db.close()
    }
  })

  it('retries enqueue attempts with backoff and eventually succeeds', async () => {
    const persistence = createPersistence({ file: ':memory:' })
    const { project, repoPath } = await createProjectFixture(persistence, 'demo')
    const runnerCalls: WorkflowRunnerPayload[] = []
    let attempts = 0
    const runnerGateway: WorkflowRunnerGateway = {
      enqueue: async (payload) => {
        attempts += 1
        if (attempts === 1) {
          throw new Error('docker unavailable')
        }
        runnerCalls.push(payload)
      }
    }
    const runtime = createRuntime(persistence, runnerGateway, undefined, {
      runnerRetry: { maxAttempts: 3, backoffMs: () => 20 }
    })
    try {
      const workflow = runtime.createWorkflowFromPlan({ projectId: project.id, plannerRun: singleTaskPlan })
      runtime.startWorkflow(workflow.id)
      runtime.startWorker()
      await waitFor(() => attempts >= 1)
      const stepAfterFailure = persistence.workflowSteps.listByWorkflow(workflow.id)[0]
      expect(stepAfterFailure.status).toBe('pending')
      expect(stepAfterFailure.runnerAttempts).toBe(1)
      expect(stepAfterFailure.readyAt).not.toBeNull()
      expect(new Date(stepAfterFailure.readyAt as string).getTime()).toBeGreaterThan(Date.now())
      await waitFor(() => attempts >= 2)
      expect(runnerCalls[0]?.stepId).toBe(workflowStepId(workflow.id, singleTaskPlan.tasks[0].id!))
    } finally {
      await runtime.stopWorker()
      await fs.rm(repoPath, { recursive: true, force: true })
      persistence.db.close()
    }
  }, 15000)

  it('marks steps as failed after exhausting enqueue attempts', async () => {
    const persistence = createPersistence({ file: ':memory:' })
    const { project, repoPath } = await createProjectFixture(persistence, 'demo')
    let attempts = 0
    const runnerGateway: WorkflowRunnerGateway = {
      enqueue: async () => {
        attempts += 1
        throw new Error('still failing')
      }
    }
    const runtime = createRuntime(persistence, runnerGateway, undefined, {
      runnerRetry: { maxAttempts: 3, backoffMs: () => 10 }
    })
    try {
      const workflow = runtime.createWorkflowFromPlan({ projectId: project.id, plannerRun: singleTaskPlan })
      runtime.startWorkflow(workflow.id)
      runtime.startWorker()
      await waitFor(() => attempts >= 3, 2000)
      const step = persistence.workflowSteps.listByWorkflow(workflow.id)[0]
      expect(step.status).toBe('failed')
      expect(step.runnerAttempts).toBeGreaterThanOrEqual(3)
      expect(step.readyAt).toBeNull()
      expect(step.result?.error).toContain('Failed to enqueue workflow runner')
      const workflowRecord = persistence.workflows.getById(workflow.id)
      expect(workflowRecord?.status).toBe('failed')
      const deadLetters = persistence.workflowRunnerDeadLetters.listRecent()
      expect(deadLetters.length).toBeGreaterThanOrEqual(1)
      expect(deadLetters[0]?.workflowId).toBe(workflow.id)
      expect(deadLetters[0]?.stepId).toBe(step.id)
      expect(deadLetters[0]?.attempts).toBeGreaterThanOrEqual(3)
      expect(deadLetters[0]?.error).toContain('still failing')
    } finally {
      await runtime.stopWorker()
      await fs.rm(repoPath, { recursive: true, force: true })
      persistence.db.close()
    }
  }, 15000)

  it('records runner enqueue failure events with error metadata', async () => {
    const persistence = createPersistence({ file: ':memory:' })
    const { project, repoPath } = await createProjectFixture(persistence, 'runner-events')
    let attempts = 0
    const runnerGateway: WorkflowRunnerGateway = {
      enqueue: async () => {
        attempts += 1
        throw new Error('docker callback timeout')
      }
    }
    const runtime = createRuntime(persistence, runnerGateway, undefined, {
      runnerRetry: { maxAttempts: 1, backoffMs: () => 5 }
    })
    try {
      const workflow = runtime.createWorkflowFromPlan({ projectId: project.id, plannerRun: singleTaskPlan })
      runtime.startWorkflow(workflow.id)
      runtime.startWorker()
      await waitFor(() => attempts >= 1)
      await waitFor(() => persistence.workflowRunnerEvents.listByWorkflow(workflow.id).length >= 1)
      const events = persistence.workflowRunnerEvents.listByWorkflow(workflow.id)
      const enqueueFailure = events.find((event) => event.type === 'runner.enqueue' && event.status === 'failed')
      expect(enqueueFailure).toBeDefined()
      const metadata = enqueueFailure?.metadata as { error?: string } | null
      expect(metadata?.error).toContain('docker callback timeout')
    } finally {
      await runtime.stopWorker()
      await fs.rm(repoPath, { recursive: true, force: true })
      persistence.db.close()
    }
  })

  it('finishes radicle sessions when commits are produced', async () => {
    const persistence = createPersistence({ file: ':memory:' })
    const { project, repoPath } = await createProjectFixture(persistence, 'demo')
    const runnerCalls: WorkflowRunnerPayload[] = []
    const runnerGateway: WorkflowRunnerGateway = {
      enqueue: async (payload) => {
        runnerCalls.push(payload)
      }
    }
    const radicleStub = createRadicleModuleStub()
    const agentExecutor: AgentExecutor = async () => ({
      stepResult: { summary: 'radicle success' },
      skipCommit: false,
      commitMessage: 'workflow: solo-task'
    })
    const runtime = createRuntime(persistence, runnerGateway, agentExecutor, { radicle: radicleStub.module })
    try {
      const workflow = runtime.createWorkflowFromPlan({ projectId: project.id, plannerRun: singleTaskPlan })
      runtime.startWorkflow(workflow.id)
      runtime.startWorker()
      await waitFor(() => runnerCalls.length >= 1)
      await runtime.runStepById(runnerCalls[0] as WorkflowRunnerPayload)
      expect(radicleStub.stats.startCount).toBe(1)
      expect(radicleStub.stats.finishCount).toBe(1)
      expect(radicleStub.stats.abortCount).toBe(0)
      expect(radicleStub.stats.finishMessages[0]).toBe('workflow: solo-task')
      const detail = runtime.getWorkflowDetail(workflow.id)
      const step = detail?.steps[0]
      const stepResult = (step?.result ?? {}) as {
        commit?: { commitHash?: string }
        workspace?: { workspacePath?: string }
      }
      expect(stepResult.commit?.commitHash).toBe(radicleStub.commitResult.commitHash)
      expect(stepResult.workspace?.workspacePath).toBe(radicleStub.workspace.workspacePath)
    } finally {
      await runtime.stopWorker()
      await fs.rm(repoPath, { recursive: true, force: true })
      persistence.db.close()
    }
  })

  it('aborts radicle sessions when execution fails', async () => {
    const persistence = createPersistence({ file: ':memory:' })
    const { project, repoPath } = await createProjectFixture(persistence, 'demo')
    const runnerCalls: WorkflowRunnerPayload[] = []
    const runnerGateway: WorkflowRunnerGateway = {
      enqueue: async (payload) => {
        runnerCalls.push(payload)
      }
    }
    const radicleStub = createRadicleModuleStub()
    const agentExecutor: AgentExecutor = async () => {
      throw new Error('agent crash')
    }
    const runtime = createRuntime(persistence, runnerGateway, agentExecutor, { radicle: radicleStub.module })
    try {
      const workflow = runtime.createWorkflowFromPlan({ projectId: project.id, plannerRun: singleTaskPlan })
      runtime.startWorkflow(workflow.id)
      runtime.startWorker()
      await waitFor(() => runnerCalls.length >= 1)
      await runtime.runStepById(runnerCalls[0] as WorkflowRunnerPayload)
      expect(radicleStub.stats.abortCount).toBe(1)
      expect(radicleStub.stats.finishCount).toBe(0)
      const detail = runtime.getWorkflowDetail(workflow.id)
      const step = detail?.steps[0]
      expect(step?.status).toBe('failed')
      expect(step?.result?.error).toContain('agent crash')
    } finally {
      await runtime.stopWorker()
      await fs.rm(repoPath, { recursive: true, force: true })
      persistence.db.close()
    }
  })

  it('aborts radicle sessions when the agent requests a skip-commit fallback', async () => {
    const persistence = createPersistence({ file: ':memory:' })
    const { project, repoPath } = await createProjectFixture(persistence, 'radicle-skip')
    const runnerCalls: WorkflowRunnerPayload[] = []
    const runnerGateway: WorkflowRunnerGateway = {
      enqueue: async (payload) => {
        runnerCalls.push(payload)
      }
    }
    const radicleStub = createRadicleModuleStub()
    const agentExecutor: AgentExecutor = async () => ({
      stepResult: { summary: 'skipped commit run' },
      skipCommit: true
    })
    const runtime = createRuntime(persistence, runnerGateway, agentExecutor, { radicle: radicleStub.module })
    try {
      const workflow = runtime.createWorkflowFromPlan({ projectId: project.id, plannerRun: singleTaskPlan })
      runtime.startWorkflow(workflow.id)
      runtime.startWorker()
      await waitFor(() => runnerCalls.length >= 1)
      await runtime.runStepById(runnerCalls[0] as WorkflowRunnerPayload)
      expect(radicleStub.stats.abortCount).toBe(1)
      expect(radicleStub.stats.finishCount).toBe(0)
      const detail = runtime.getWorkflowDetail(workflow.id)
      const step = detail?.steps[0]
      expect(step?.result?.commit).toBeUndefined()
      expect(step?.status).toBe('completed')
    } finally {
      await runtime.stopWorker()
      await fs.rm(repoPath, { recursive: true, force: true })
      persistence.db.close()
    }
  })

  it('reports failures when radicle pushes fail after commit production', async () => {
    const persistence = createPersistence({ file: ':memory:' })
    const { project, repoPath } = await createProjectFixture(persistence, 'radicle-push-failure')
    const runnerCalls: WorkflowRunnerPayload[] = []
    const runnerGateway: WorkflowRunnerGateway = {
      enqueue: async (payload) => {
        runnerCalls.push(payload)
      }
    }
    const radicleStub = createRadicleModuleStub({ finishThrows: true })
    const agentExecutor: AgentExecutor = async () => ({
      stepResult: { summary: 'commit ready' },
      skipCommit: false,
      commitMessage: 'workflow: push failure'
    })
    const runtime = createRuntime(persistence, runnerGateway, agentExecutor, { radicle: radicleStub.module })
    try {
      const workflow = runtime.createWorkflowFromPlan({ projectId: project.id, plannerRun: singleTaskPlan })
      runtime.startWorkflow(workflow.id)
      runtime.startWorker()
      await waitFor(() => runnerCalls.length >= 1)
      await runtime.runStepById(runnerCalls[0] as WorkflowRunnerPayload)
      expect(radicleStub.stats.finishCount).toBe(1)
      expect(radicleStub.stats.abortCount).toBe(1)
      const detail = runtime.getWorkflowDetail(workflow.id)
      const step = detail?.steps[0]
      expect(step?.status).toBe('failed')
      expect(step?.result?.error).toContain('rad push failed')
    } finally {
      await runtime.stopWorker()
      await fs.rm(repoPath, { recursive: true, force: true })
      persistence.db.close()
    }
  })

  it('creates pull requests when commits are produced', async () => {
    const persistence = createPersistence({ file: ':memory:' })
    const { project, repoPath } = await createProjectFixture(persistence, 'demo')
    const runnerCalls: WorkflowRunnerPayload[] = []
    const runnerGateway: WorkflowRunnerGateway = {
      enqueue: async (payload) => {
        runnerCalls.push(payload)
      }
    }
    const radicleStub = createRadicleModuleStub()
    const timestamp = new Date().toISOString()
    const pullRequestRecord: PullRequestRecord = {
      id: 'pr-1',
      projectId: project.id,
      title: radicleStub.commitResult.message,
      description: null,
      sourceBranch: radicleStub.commitResult.branch,
      targetBranch: radicleStub.workspace.baseBranch,
      radiclePatchId: null,
      status: 'open',
      authorUserId: 'workflow-automation',
      createdAt: timestamp,
      updatedAt: timestamp,
      mergedAt: null,
      closedAt: null
    }
    const pullRequestStub = createPullRequestModuleStub(pullRequestRecord)
    const agentExecutor: AgentExecutor = async () => ({
      stepResult: { summary: 'ready for review' },
      skipCommit: false,
      commitMessage: 'workflow: solo-task'
    })
    const runtime = createRuntime(persistence, runnerGateway, agentExecutor, {
      radicle: radicleStub.module,
      pullRequestModule: pullRequestStub.module,
      pullRequestAuthorUserId: 'workflow-automation'
    })
    try {
      const workflow = runtime.createWorkflowFromPlan({ projectId: project.id, plannerRun: singleTaskPlan })
      runtime.startWorkflow(workflow.id)
      runtime.startWorker()
      await waitFor(() => runnerCalls.length >= 1)
      await runtime.runStepById(runnerCalls[0] as WorkflowRunnerPayload)
      expect(pullRequestStub.spies.createPullRequest).toHaveBeenCalledTimes(1)
      expect(pullRequestStub.spies.createPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: project.id,
          description: 'ready for review',
          sourceBranch: radicleStub.commitResult.branch,
          targetBranch: radicleStub.workspace.baseBranch,
          authorUserId: 'workflow-automation'
        })
      )
      const detail = runtime.getWorkflowDetail(workflow.id)
      const step = detail?.steps[0]
      const stepResult = (step?.result ?? {}) as { pullRequest?: { id?: string } }
      expect(stepResult.pullRequest?.id).toBe(pullRequestRecord.id)
    } finally {
      await runtime.stopWorker()
      await fs.rm(repoPath, { recursive: true, force: true })
      persistence.db.close()
    }
  })

  it('skips pull request creation when no commit is produced', async () => {
    const persistence = createPersistence({ file: ':memory:' })
    const { project, repoPath } = await createProjectFixture(persistence, 'demo')
    const runnerCalls: WorkflowRunnerPayload[] = []
    const runnerGateway: WorkflowRunnerGateway = {
      enqueue: async (payload) => {
        runnerCalls.push(payload)
      }
    }
    const timestamp = new Date().toISOString()
    const pullRequestRecord: PullRequestRecord = {
      id: 'pr-2',
      projectId: project.id,
      title: 'unused',
      description: null,
      sourceBranch: 'wf-unused',
      targetBranch: 'main',
      radiclePatchId: null,
      status: 'open',
      authorUserId: 'workflow-automation',
      createdAt: timestamp,
      updatedAt: timestamp,
      mergedAt: null,
      closedAt: null
    }
    const pullRequestStub = createPullRequestModuleStub(pullRequestRecord)
    const agentExecutor: AgentExecutor = async () => ({
      stepResult: { summary: 'nothing to commit' },
      skipCommit: true
    })
    const runtime = createRuntime(persistence, runnerGateway, agentExecutor, {
      pullRequestModule: pullRequestStub.module
    })
    try {
      const workflow = runtime.createWorkflowFromPlan({ projectId: project.id, plannerRun: singleTaskPlan })
      runtime.startWorkflow(workflow.id)
      runtime.startWorker()
      await waitFor(() => runnerCalls.length >= 1)
      await runtime.runStepById(runnerCalls[0] as WorkflowRunnerPayload)
      expect(pullRequestStub.spies.createPullRequest).not.toHaveBeenCalled()
      const detail = runtime.getWorkflowDetail(workflow.id)
      const step = detail?.steps[0]
      expect(step?.result?.pullRequest).toBeUndefined()
    } finally {
      await runtime.stopWorker()
      await fs.rm(repoPath, { recursive: true, force: true })
      persistence.db.close()
    }
  })

  it('records provenance logs when no agent logs are provided', async () => {
    const persistence = createPersistence({ file: ':memory:' })
    const { project, repoPath } = await createProjectFixture(persistence, 'demo')
    const runnerCalls: WorkflowRunnerPayload[] = []
    const runnerGateway: WorkflowRunnerGateway = {
      enqueue: async (payload) => {
        runnerCalls.push(payload)
      }
    }
    const agentExecutor: AgentExecutor = async () => ({
      stepResult: { summary: 'logless step' },
      skipCommit: true
    })
    const runtime = createRuntime(persistence, runnerGateway, agentExecutor)
    try {
      const workflow = runtime.createWorkflowFromPlan({ projectId: project.id, plannerRun: singleTaskPlan })
      runtime.startWorkflow(workflow.id)
      runtime.startWorker()
      await waitFor(() => runnerCalls.length >= 1)
      await runtime.runStepById(runnerCalls[0] as WorkflowRunnerPayload)
      const detail = runtime.getWorkflowDetail(workflow.id)
      const step = detail?.steps[0]
      const provenance = (step?.result ?? {}) as { provenance?: { logsPath?: string } }
      const logsPath = provenance.provenance?.logsPath
      expect(typeof logsPath).toBe('string')
      if (!logsPath) {
        throw new Error('logsPath missing')
      }
      const payload = JSON.parse(await fs.readFile(logsPath, 'utf8'))
      expect(payload.workflowId).toBe(workflow.id)
      expect(payload.stepId).toBe(workflowStepId(workflow.id, singleTaskPlan.tasks[0].id))
      expect(payload.repositoryPath).toBe(project.repositoryPath)
    } finally {
      await runtime.stopWorker()
      await fs.rm(repoPath, { recursive: true, force: true })
      persistence.db.close()
    }
  })

  it('skips steps when workflows are cancelled before runner callbacks arrive', async () => {
    const persistence = createPersistence({ file: ':memory:' })
    const { project, repoPath } = await createProjectFixture(persistence, 'demo')
    const runnerCalls: WorkflowRunnerPayload[] = []
    const runnerGateway: WorkflowRunnerGateway = {
      enqueue: async (payload) => {
        runnerCalls.push(payload)
      }
    }
    const runtime = createRuntime(persistence, runnerGateway)
    try {
      const workflow = runtime.createWorkflowFromPlan({ projectId: project.id, plannerRun: singleTaskPlan })
      runtime.startWorkflow(workflow.id)
      runtime.startWorker()
      await waitFor(() => runnerCalls.length >= 1)
      runtime.cancelWorkflow(workflow.id)
      await runtime.runStepById(runnerCalls[0] as WorkflowRunnerPayload)
      const detail = runtime.getWorkflowDetail(workflow.id)
      expect(detail?.workflow.status).toBe('cancelled')
      const [step] = detail?.steps ?? []
      expect(step?.status).toBe('skipped')
      expect(step?.result?.note).toContain('cancelled')
      expect(step?.runnerInstanceId).toBeNull()
    } finally {
      await runtime.stopWorker()
      await fs.rm(repoPath, { recursive: true, force: true })
      persistence.db.close()
    }
  })

  it('fails steps when agent runs cannot be recorded', async () => {
    const persistence = createPersistence({ file: ':memory:' })
    const { project, repoPath } = await createProjectFixture(persistence, 'demo')
    const runnerCalls: WorkflowRunnerPayload[] = []
    const runnerGateway: WorkflowRunnerGateway = {
      enqueue: async (payload) => {
        runnerCalls.push(payload)
      }
    }
    const runtime = createRuntime(persistence, runnerGateway)
    const agentRunSpy = vi.spyOn(persistence.agentRuns, 'create').mockImplementation(() => {
      throw new Error('db locked')
    })
    try {
      const workflow = runtime.createWorkflowFromPlan({ projectId: project.id, plannerRun: singleTaskPlan })
      runtime.startWorkflow(workflow.id)
      runtime.startWorker()
      await waitFor(() => runnerCalls.length >= 1)
      await expect(runtime.runStepById(runnerCalls[0] as WorkflowRunnerPayload)).rejects.toThrow('db locked')
      const detail = runtime.getWorkflowDetail(workflow.id)
      const [step] = detail?.steps ?? []
      expect(step?.status).toBe('failed')
      expect(step?.result?.error).toBe('Failed to start agent run')
      expect(step?.result?.detail).toContain('db locked')
      const workflowRecord = persistence.workflows.getById(workflow.id)
      expect(workflowRecord?.status).toBe('failed')
    } finally {
      agentRunSpy.mockRestore()
      await runtime.stopWorker()
      await fs.rm(repoPath, { recursive: true, force: true })
      persistence.db.close()
    }
  })

  it('enforces workflow policy decisions before starting agent runs', async () => {
    const persistence = createPersistence({ file: ':memory:' })
    const { project, repoPath } = await createProjectFixture(persistence, 'policy-demo')
    const runnerCalls: WorkflowRunnerPayload[] = []
    const runnerGateway: WorkflowRunnerGateway = {
      enqueue: async (payload) => {
        runnerCalls.push(payload)
      }
    }
    const denyingPolicy: WorkflowPolicy = {
      authorizeStep: async ({ branchInfo }) => ({
        allowed: false,
        reason: 'Approval token required',
        metadata: {
          branch: branchInfo.name,
          baseBranch: branchInfo.baseBranch,
          protected: true
        }
      })
    }
    const protectedPlan: PlannerRun = {
      id: 'plan-policy',
      kind: 'custom',
      data: {
        branch: 'protected-feature',
        baseBranch: project.defaultBranch
      },
      tasks: singleTaskPlan.tasks
    }
    const runtime = createRuntime(persistence, runnerGateway, undefined, {
      policy: denyingPolicy
    })
    try {
      const workflow = runtime.createWorkflowFromPlan({ projectId: project.id, plannerRun: protectedPlan })
      runtime.startWorkflow(workflow.id)
      runtime.startWorker()
      await waitFor(() => runnerCalls.length >= 1)
      await runtime.runStepById(runnerCalls[0] as WorkflowRunnerPayload)
      const detail = runtime.getWorkflowDetail(workflow.id)
      const [step] = detail?.steps ?? []
      expect(step?.status).toBe('failed')
      expect(step?.result?.error).toContain('Approval token required')
      const policyAudit = step?.result?.policyAudit as
        | { decision?: { allowed?: boolean; metadata?: Record<string, unknown> } }
        | undefined
      const metadata = policyAudit?.decision?.metadata as Record<string, unknown> | undefined
      expect(policyAudit?.decision?.allowed).toBe(false)
      expect(metadata?.branch).toBe('protected-feature')
      expect(persistence.agentRuns.listByWorkflow(workflow.id)).toHaveLength(0)
    } finally {
      await runtime.stopWorker()
      await fs.rm(repoPath, { recursive: true, force: true })
      persistence.db.close()
    }
  })
})
