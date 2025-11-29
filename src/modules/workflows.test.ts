import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { createPersistence, type Persistence } from './database'
import type { ProjectRecord } from './projects'
import type { WorkflowRunnerGateway, WorkflowRunnerPayload } from './workflowRunnerGateway'
import {
  createWorkflowRuntime,
  type AgentExecutor,
  type PlannerRun,
  type WorkflowRuntimeOptions
} from './workflows'
import type {
  CommitResult,
  RadicleModule,
  RadicleSessionHandle,
  RadicleSessionInit,
  WorkspaceInfo
} from './radicle/types'

const commitAuthor = { name: 'Test Workflow', email: 'workflow@test.local' }

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

  const createRadicleModuleStub = () => {
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
      commitAndPush: async () => commitResult,
      finish: async (message: string) => {
        finishCount += 1
        finishMessages.push(message)
        return commitResult
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

  const createRuntime = (
    persistence: Persistence,
    runnerGateway: WorkflowRunnerGateway,
    agentExecutor?: AgentExecutor,
    extra?: {
      runnerRetry?: WorkflowRuntimeOptions['runnerRetry']
      pollIntervalMs?: number
      radicle?: WorkflowRuntimeOptions['radicle']
    }
  ) => {
    return createWorkflowRuntime({
      persistence: {
        projects: persistence.projects,
        workflows: persistence.workflows,
        workflowSteps: persistence.workflowSteps,
        agentRuns: persistence.agentRuns
      },
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
      radicle: extra?.radicle
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
      expect(steps[0]?.id).toBe('task-1')
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
      expect(runnerCalls[0]?.stepId).toBe('task-1')
      expect(runnerCalls.some((call) => call.stepId === 'task-2')).toBe(false)
      await runtime.runStepById(runnerCalls[0] as WorkflowRunnerPayload)
      await waitFor(() => runnerCalls.length >= 2)
      expect(runnerCalls[1]?.stepId).toBe('task-2')
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
      expect(runnerCalls[0]?.stepId).toBe(singleTaskPlan.tasks[0].id)
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
    } finally {
      await runtime.stopWorker()
      await fs.rm(repoPath, { recursive: true, force: true })
      persistence.db.close()
    }
  }, 15000)

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
      expect(step?.result?.commit?.commitHash).toBe(radicleStub.commitResult.commitHash)
      const workspaceInfo = (step?.result as any)?.workspace
      expect(workspaceInfo?.workspacePath).toBe(radicleStub.workspace.workspacePath)
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
})
