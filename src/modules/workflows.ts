import type {
  AgentRunRecord,
  Persistence,
  ProjectRecord,
  WorkflowInput,
  WorkflowRecord,
  WorkflowStepInput,
  WorkflowStepRecord,
  WorkflowStepsRepository
} from './persistence'

export type PlannerTask = {
  id: string
  title: string
  instructions: string
  agentType?: string
  dependsOn?: string[]
  metadata?: Record<string, unknown>
}

export type PlannerRun = {
  id: string
  kind?: string
  tasks: PlannerTask[]
  data?: Record<string, unknown>
}

export type WorkflowDetail = {
  workflow: WorkflowRecord
  steps: WorkflowStepRecord[]
  runs: AgentRunRecord[]
}

export type AgentExecutorArgs = {
  project: ProjectRecord
  workflow: WorkflowRecord
  step: WorkflowStepRecord
}

export type AgentExecutorResult = {
  stepResult?: Record<string, unknown>
  logsPath?: string | null
}

export type AgentExecutor = (args: AgentExecutorArgs) => Promise<AgentExecutorResult>

export type WorkflowRuntimeOptions = {
  persistence: Persistence
  agentExecutor?: AgentExecutor
  pollIntervalMs?: number
}

export type WorkflowRuntime = {
  createWorkflowFromPlan: (input: { projectId: string; plannerRun: PlannerRun }) => WorkflowRecord
  startWorkflow: (workflowId: string) => void
  pauseWorkflow: (workflowId: string) => void
  cancelWorkflow: (workflowId: string) => void
  getWorkflowDetail: (workflowId: string) => WorkflowDetail | null
  listWorkflows: (projectId?: string) => WorkflowRecord[]
  startWorker: () => void
  stopWorker: () => Promise<void>
}

export function createWorkflowRuntime (options: WorkflowRuntimeOptions): WorkflowRuntime {
  const persistence = options.persistence
  const agentExecutor = options.agentExecutor ?? createDefaultExecutor()
  const pollInterval = options.pollIntervalMs ?? 1000

  let workerRunning = false
  let workerPromise: Promise<void> | null = null

  const startWorker = () => {
    if (workerRunning) return
    workerRunning = true
    workerPromise = runWorkerLoop()
  }

  const stopWorker = async () => {
    workerRunning = false
    if (workerPromise) {
      await workerPromise
      workerPromise = null
    }
  }

  const createWorkflowFromPlan = (input: { projectId: string; plannerRun: PlannerRun }): WorkflowRecord => {
    const plannerRun = input.plannerRun
    const workflowPayload: WorkflowInput = {
      projectId: input.projectId,
      plannerRunId: plannerRun.id,
      kind: plannerRun.kind ?? 'custom',
      status: 'pending',
      data: plannerRun.data ?? {}
    }
    const workflow = persistence.workflows.insert(workflowPayload)
    const steps: WorkflowStepInput[] = plannerRun.tasks.map((task, index) => ({
      taskId: task.id,
      sequence: index + 1,
      dependsOn: task.dependsOn ?? [],
      data: {
        title: task.title,
        instructions: task.instructions,
        agentType: task.agentType ?? 'coding',
        metadata: task.metadata ?? {}
      }
    }))
    persistence.workflowSteps.insertMany(workflow.id, steps)
    return workflow
  }

  const startWorkflow = (workflowId: string) => {
    persistence.workflows.updateStatus(workflowId, 'running')
  }

  const pauseWorkflow = (workflowId: string) => {
    persistence.workflows.updateStatus(workflowId, 'paused')
  }

  const cancelWorkflow = (workflowId: string) => {
    persistence.workflows.updateStatus(workflowId, 'cancelled')
  }

  const getWorkflowDetail = (workflowId: string): WorkflowDetail | null => {
    const workflow = persistence.workflows.getById(workflowId)
    if (!workflow) return null
    const steps = persistence.workflowSteps.listByWorkflow(workflow.id)
    const runs = persistence.agentRuns.listByWorkflow(workflow.id)
    return { workflow, steps, runs }
  }

  const listWorkflows = (projectId?: string) => persistence.workflows.list(projectId)

  async function runWorkerLoop () {
    while (workerRunning) {
      await processReadySteps(persistence.workflowSteps, agentExecutor)
      await delay(pollInterval)
    }
  }

  async function processReadySteps (
    stepsRepo: WorkflowStepsRepository,
    executor: AgentExecutor
  ): Promise<void> {
    const readySteps = stepsRepo.findReady()
    for (const step of readySteps) {
      const claimed = stepsRepo.claim(step.id)
      if (!claimed) continue
      await executeStep(step, executor)
    }
  }

  async function executeStep (step: WorkflowStepRecord, executor: AgentExecutor): Promise<void> {
    const workflow = persistence.workflows.getById(step.workflowId)
    if (!workflow) return
    if (workflow.status !== 'running') return
    const project = persistence.projects.getById(workflow.projectId)
    if (!project) return

    const branch = (workflow.data.branch as string) ?? project.defaultBranch
    const agentRun = persistence.agentRuns.create({
      workflowStepId: step.id,
      projectId: project.id,
      branch,
      type: (step.data.agentType as string) ?? 'coding'
    })

    try {
      const result = await executor({ project, workflow, step })
      persistence.workflowSteps.update(step.id, {
        status: 'completed',
        result: result.stepResult ?? {
          note: 'No stepResult returned'
        }
      })
      persistence.agentRuns.update(agentRun.id, {
        status: 'succeeded',
        finishedAt: new Date().toISOString(),
        logsPath: result.logsPath ?? null
      })
    } catch (error) {
      persistence.workflowSteps.update(step.id, {
        status: 'failed',
        result: {
          error: error instanceof Error ? error.message : String(error)
        }
      })
      persistence.agentRuns.update(agentRun.id, {
        status: 'failed',
        finishedAt: new Date().toISOString()
      })
    } finally {
      refreshWorkflowStatus(workflow.id, persistence.workflowSteps, persistence.workflows)
    }
  }

  return {
    createWorkflowFromPlan,
    startWorkflow,
    pauseWorkflow,
    cancelWorkflow,
    getWorkflowDetail,
    listWorkflows,
    startWorker,
    stopWorker
  }
}

function refreshWorkflowStatus (
  workflowId: string,
  stepsRepo: WorkflowStepsRepository,
  workflowRepo: Persistence['workflows']
): void {
  const steps = stepsRepo.listByWorkflow(workflowId)
  if (!steps.length) return
  if (steps.every(step => step.status === 'completed')) {
    workflowRepo.updateStatus(workflowId, 'completed')
    return
  }
  if (steps.some(step => step.status === 'failed')) {
    workflowRepo.updateStatus(workflowId, 'failed')
    return
  }
}

function createDefaultExecutor (): AgentExecutor {
  return async ({ step }) => {
    await delay(250)
    return {
      stepResult: {
        summary: `Auto-completed step "${step.data.title ?? step.id}"`,
        instructions: step.data.instructions
      }
    }
  }
}

function delay (ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
