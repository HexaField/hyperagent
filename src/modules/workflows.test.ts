import { describe, expect, it } from 'vitest'
import { createPersistence, type Persistence } from './database'
import { createWorkflowRuntime, type PlannerRun } from './workflows'
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

  const createRuntime = (persistence: Persistence, runnerGateway: WorkflowRunnerGateway) => {
    return createWorkflowRuntime({
      persistence: {
        projects: persistence.projects,
        workflows: persistence.workflows,
        workflowSteps: persistence.workflowSteps,
        agentRuns: persistence.agentRuns
      },
      agentExecutor: async () => ({
        stepResult: { summary: 'completed' },
        skipCommit: true
      }),
      runnerGateway,
      pollIntervalMs: 25,
      commitAuthor
    })
  }

  it('enqueues workflow steps through the runner gateway and executes via callback', async () => {
    const persistence = createPersistence({ file: ':memory:' })
    const project = persistence.projects.upsert({
      name: 'demo',
      repositoryPath: '/tmp/demo-repo'
    })
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
      persistence.db.close()
    }
  })

  it('rejects callbacks with mismatched runner instance ids', async () => {
    const persistence = createPersistence({ file: ':memory:' })
    const project = persistence.projects.upsert({
      name: 'demo',
      repositoryPath: '/tmp/demo-repo'
    })
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
      persistence.db.close()
    }
  })
})
