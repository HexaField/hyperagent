import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { createPersistence, type Persistence } from './database'
import type { ProjectRecord } from './projects'
import { createWorkflowRuntime, type AgentExecutor, type PlannerRun } from './workflows'
import type { WorkflowRunnerGateway, WorkflowRunnerPayload } from './workflowRunnerGateway'

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
      }
    ]
  }

  const createRuntime = (persistence: Persistence, runnerGateway: WorkflowRunnerGateway, agentExecutor?: AgentExecutor) => {
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
      pollIntervalMs: 25,
      commitAuthor
    })
  }

  const createProjectFixture = async (persistence: Persistence, name: string): Promise<{
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
      expect(detail?.steps[0].status).toBe('completed')
      expect(detail?.steps[0].runnerInstanceId).toBeNull()
      expect(detail?.steps[0].result?.summary).toBe('completed')
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
})
