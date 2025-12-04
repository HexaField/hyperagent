import Database from 'better-sqlite3'
import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import type { AgentRunRecord, AgentRunsRepository } from './agent/agent'
import type { PersistenceContext, PersistenceModule, Timestamp } from './database'
import type { ProjectRecord, ProjectsRepository } from './projects'
import type {
  CommitResult,
  RadicleModule,
  RadicleSessionHandle,
  WorkspaceInfo as RadicleWorkspaceInfo
} from './radicle/types'
import type { PullRequestModule } from './review/pullRequest'
import { createAgentWorkflowExecutor, type AgentWorkflowExecutorOptions } from './workflowAgentExecutor'
import { allowAllWorkflowPolicy, type WorkflowPolicy, type WorkflowPolicyDecision } from './workflowPolicy'
import type { WorkflowRunnerGateway } from './workflowRunnerGateway'

export type WorkflowStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type WorkflowKind = 'new_project' | 'refactor' | 'bugfix' | 'custom'

export type WorkflowRecord = {
  id: string
  projectId: string
  plannerRunId: string | null
  kind: WorkflowKind | string
  status: WorkflowStatus
  data: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
}

export type WorkflowInput = {
  id?: string
  projectId: string
  plannerRunId?: string | null
  kind?: WorkflowKind | string
  status?: WorkflowStatus
  data?: Record<string, unknown>
}

export type WorkflowStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export type WorkflowStepRecord = {
  id: string
  workflowId: string
  taskId: string | null
  status: WorkflowStepStatus
  sequence: number
  dependsOn: string[]
  data: Record<string, unknown>
  result: Record<string, unknown> | null
  runnerInstanceId: string | null
  runnerAttempts: number
  readyAt: Timestamp | null
  updatedAt: Timestamp
}

export type WorkflowStepInput = {
  id?: string
  taskId?: string | null
  sequence: number
  dependsOn?: string[]
  data?: Record<string, unknown>
}

export type WorkflowsRepository = {
  insert: (input: WorkflowInput) => WorkflowRecord
  updateStatus: (id: string, status: WorkflowStatus) => void
  getById: (id: string) => WorkflowRecord | null
  list: (projectId?: string) => WorkflowRecord[]
}

export type WorkflowStepsRepository = {
  insertMany: (workflowId: string, steps: WorkflowStepInput[]) => WorkflowStepRecord[]
  listByWorkflow: (workflowId: string) => WorkflowStepRecord[]
  findReady: (limit?: number) => WorkflowStepRecord[]
  claim: (stepId: string) => boolean
  update: (
    stepId: string,
    patch: Partial<Pick<WorkflowStepRecord, 'status' | 'result' | 'runnerInstanceId' | 'runnerAttempts' | 'readyAt'>>
  ) => void
  getById: (stepId: string) => WorkflowStepRecord | null
  getQueueMetrics: () => WorkflowQueueMetrics
}

export type WorkflowQueueMetrics = {
  pending: number
  running: number
  stuck: number
  lastHeartbeatAt: Timestamp | null
}

export type WorkflowPolicyAudit = {
  runnerInstanceId: string | null
  decision: WorkflowPolicyDecision
  recordedAt: Timestamp
}

export type WorkflowRunnerDeadLetterRecord = {
  id: string
  workflowId: string
  stepId: string
  runnerInstanceId: string | null
  attempts: number
  error: string
  createdAt: Timestamp
}

export type WorkflowRunnerDeadLetterInput = {
  id?: string
  workflowId: string
  stepId: string
  runnerInstanceId?: string | null
  attempts: number
  error: string
}

export type WorkflowRunnerDeadLettersRepository = {
  insert: (input: WorkflowRunnerDeadLetterInput) => WorkflowRunnerDeadLetterRecord
  listRecent: (limit?: number) => WorkflowRunnerDeadLetterRecord[]
}

export type WorkflowRunnerEventRecord = {
  id: string
  workflowId: string
  stepId: string
  type: string
  status: string
  runnerInstanceId: string | null
  attempts: number
  latencyMs: number | null
  metadata: Record<string, unknown> | null
  createdAt: Timestamp
}

export type WorkflowRunnerEventInput = {
  id?: string
  workflowId: string
  stepId: string
  type: string
  status: string
  runnerInstanceId?: string | null
  attempts?: number
  latencyMs?: number | null
  metadata?: Record<string, unknown> | null
}

export type WorkflowRunnerEventsRepository = {
  insert: (input: WorkflowRunnerEventInput) => WorkflowRunnerEventRecord
  listRecent: (limit?: number) => WorkflowRunnerEventRecord[]
  listByWorkflow: (workflowId: string, limit?: number) => WorkflowRunnerEventRecord[]
}

export type WorkflowsBindings = {
  workflows: WorkflowsRepository
  workflowSteps: WorkflowStepsRepository
  workflowRunnerDeadLetters: WorkflowRunnerDeadLettersRepository
  workflowRunnerEvents: WorkflowRunnerEventsRepository
}

type WorkflowPersistenceAdapter = {
  projects: ProjectsRepository
  workflows: WorkflowsRepository
  workflowSteps: WorkflowStepsRepository
  agentRuns: AgentRunsRepository
  workflowRunnerDeadLetters: WorkflowRunnerDeadLettersRepository
  workflowRunnerEvents: WorkflowRunnerEventsRepository
  db?: Database.Database
}

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
  workspace?: RadicleWorkspaceInfo
  radicleSession?: RadicleSessionHandle
}

export type AgentExecutorResult = {
  stepResult?: Record<string, unknown>
  logsPath?: string | null
  commitMessage?: string
  skipCommit?: boolean
}

export type AgentExecutor = (args: AgentExecutorArgs) => Promise<AgentExecutorResult>

export type WorkflowStepCommit = {
  commitHash: string
  branch: string
  message: string
}

export function extractCommitFromWorkflowStep(step: WorkflowStepRecord): WorkflowStepCommit | null {
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

export type WorkflowRuntimeOptions = {
  persistence: WorkflowPersistenceAdapter
  agentExecutor?: AgentExecutor
  agentExecutorOptions?: AgentWorkflowExecutorOptions
  pollIntervalMs?: number
  radicle?: RadicleModule
  pullRequestModule?: PullRequestModule
  pullRequestAuthorUserId?: string
  commitAuthor?: {
    name: string
    email: string
  }
  runnerGateway: WorkflowRunnerGateway
  runnerRetry?: {
    maxAttempts?: number
    backoffMs?: (attempt: number) => number
  }
  policy?: WorkflowPolicy
  persistenceFilePath?: string
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
  runStepById: (input: { workflowId: string; stepId: string; runnerInstanceId: string }) => Promise<void>
}

function ensurePlannerDependencies(tasks: PlannerTask[]): void {
  const taskIds = new Set<string>()
  for (const task of tasks) {
    if (!task.id || typeof task.id !== 'string') {
      throw new Error('Planner tasks must include a stable id')
    }
    if (taskIds.has(task.id)) {
      throw new Error(`Duplicate planner task id detected: ${task.id}`)
    }
    taskIds.add(task.id)
  }

  for (const task of tasks) {
    const deps = task.dependsOn ?? []
    for (const dep of deps) {
      if (!taskIds.has(dep)) {
        throw new Error(`Planner task ${task.id} depends on unknown task ${dep}`)
      }
    }
  }
}

function computeRetryDelayMs(attempt: number): number {
  const base = 2_000
  const max = 60_000
  const exponent = Math.max(attempt - 1, 0)
  const delay = base * Math.pow(2, exponent)
  const jitterMultiplier = 0.5 + Math.random()
  return Math.min(delay * jitterMultiplier, max)
}

const DEFAULT_MAX_ENQUEUE_ATTEMPTS = 5

export function createWorkflowRuntime(options: WorkflowRuntimeOptions): WorkflowRuntime {
  const persistence = options.persistence
  const agentExecutor =
    options.agentExecutor ??
    (options.agentExecutorOptions ? createAgentWorkflowExecutor(options.agentExecutorOptions) : createDefaultExecutor())
  const pollInterval = options.pollIntervalMs ?? 1000
  const radicle = options.radicle
  const pullRequestModule = options.pullRequestModule
  const pullRequestAuthorUserId = options.pullRequestAuthorUserId ?? 'workflow-automation'
  const commitAuthor = options.commitAuthor ?? {
    name: 'Hyperagent Workflow',
    email: 'workflow@hyperagent.local'
  }
  const runnerGateway = options.runnerGateway
  const workflowPolicy = options.policy ?? allowAllWorkflowPolicy
  const runnerRetry = {
    maxAttempts: options.runnerRetry?.maxAttempts ?? DEFAULT_MAX_ENQUEUE_ATTEMPTS,
    backoffMs: options.runnerRetry?.backoffMs ?? computeRetryDelayMs
  }
  const persistenceFilePath = resolvePersistenceFilePath(options.persistenceFilePath, persistence)
  const persistenceDb = (persistence as { db?: Database.Database }).db
  const checkpointPersistence = () => {
    if (!persistenceDb) return
    try {
      persistenceDb.pragma('wal_checkpoint(TRUNCATE)')
    } catch (error) {
      console.warn('[workflow]', {
        action: 'persistence_checkpoint_failed',
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const recordRunnerEvent = (input: WorkflowRunnerEventInput) => {
    try {
      persistence.workflowRunnerEvents.insert({
        ...input,
        runnerInstanceId: input.runnerInstanceId ?? null,
        attempts: input.attempts ?? 0,
        latencyMs: typeof input.latencyMs === 'number' ? input.latencyMs : null,
        metadata: input.metadata ?? null
      })
    } catch (error) {
      console.warn('[workflow]', {
        action: 'workflow_event_persist_failed',
        workflowId: input.workflowId,
        stepId: input.stepId,
        type: input.type,
        status: input.status,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const readWorkflowDetailFromDisk = (
    workflowId: string
  ): { workflow: WorkflowRecord; steps: WorkflowStepRecord[] } | null => {
    if (!persistenceFilePath) {
      return null
    }
    let reader: Database.Database | null = null
    try {
      reader = new Database(persistenceFilePath, { readonly: true })
      reader.pragma('journal_mode = WAL')
      const workflowRow = reader.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId)
      if (!workflowRow) {
        return null
      }
      const workflow = mapWorkflow(workflowRow)
      const stepRows = reader
        .prepare('SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY sequence ASC')
        .all(workflowId)
      const steps = stepRows.map(mapWorkflowStep)
      return { workflow, steps }
    } catch (error) {
      console.warn('[workflow]', {
        action: 'workflow_detail_disk_read_failed',
        workflowId,
        error: error instanceof Error ? error.message : String(error)
      })
      return null
    } finally {
      reader?.close()
    }
  }

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
    ensurePlannerDependencies(plannerRun.tasks)
    const stepIdMap = new Map<string, string>()
    for (const task of plannerRun.tasks) {
      const stepId = buildWorkflowStepId(workflow.id, task.id)
      stepIdMap.set(task.id, stepId)
    }
    const steps: WorkflowStepInput[] = plannerRun.tasks.map((task, index) => ({
      id: stepIdMap.get(task.id)!,
      taskId: task.id,
      sequence: index + 1,
      dependsOn: (task.dependsOn ?? []).map((dep) => stepIdMap.get(dep)!),
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
    checkpointPersistence()
    let workflow: WorkflowRecord | null = null
    let steps: WorkflowStepRecord[] | null = null
    let runs: AgentRunRecord[] = []
    try {
      workflow = persistence.workflows.getById(workflowId)
      steps = workflow ? persistence.workflowSteps.listByWorkflow(workflow.id) : null
      runs = workflow ? persistence.agentRuns.listByWorkflow(workflow.id) : []
    } catch (error) {
      if (!isSqliteIoError(error)) {
        throw error
      }
      console.warn('[workflow]', {
        action: 'workflow_detail_read_retry',
        workflowId,
        error: error instanceof Error ? error.message : 'sqlite io error'
      })
      workflow = null
      steps = null
      runs = []
    }
    const hasDetail = workflow && steps
    const diskDetail = readWorkflowDetailFromDisk(workflowId)
    if (diskDetail) {
      const currentUpdatedAt = hasDetail ? new Date(workflow!.updatedAt).getTime() : 0
      const diskUpdatedAt = new Date(diskDetail.workflow.updatedAt).getTime()
      if (!hasDetail || diskUpdatedAt > currentUpdatedAt) {
        return {
          workflow: diskDetail.workflow,
          steps: diskDetail.steps,
          runs
        }
      }
    }
    if (!hasDetail) {
      return null
    }
    return { workflow: workflow!, steps: steps!, runs }
  }

  const listWorkflows = (projectId?: string) => {
    checkpointPersistence()
    return persistence.workflows.list(projectId)
  }

  const finalizeStepWithoutExecution = (
    step: WorkflowStepRecord,
    update: { status: WorkflowStepStatus; result: Record<string, unknown> },
    workflowId?: string | null
  ) => {
    persistence.workflowSteps.update(step.id, {
      status: update.status,
      result: update.result,
      runnerInstanceId: null,
      readyAt: null
    })
    checkpointPersistence()
    if (workflowId) {
      refreshWorkflowStatus(workflowId, persistence.workflowSteps, persistence.workflows)
    }
  }

  async function runWorkerLoop() {
    while (workerRunning) {
      try {
        await processReadySteps(persistence.workflowSteps)
      } catch (error) {
        console.error('[workflow]', { action: 'worker_loop_error', error })
      }
      await delay(pollInterval)
    }
  }

  async function processReadySteps(stepsRepo: WorkflowStepsRepository): Promise<void> {
    const readySteps = stepsRepo.findReady()
    for (const step of readySteps) {
      const claimed = stepsRepo.claim(step.id)
      if (!claimed) continue
      await enqueueStepRun(step)
    }
  }

  async function enqueueStepRun(step: WorkflowStepRecord): Promise<void> {
    if (!runnerGateway) {
      throw new Error('Workflow runner gateway is required')
    }
    const latest = persistence.workflowSteps.getById(step.id)
    if (!latest) return
    if (latest.runnerInstanceId) return
    const workflow = persistence.workflows.getById(step.workflowId)
    if (!workflow) {
      throw new Error(`Workflow ${step.workflowId} not found for runner enqueue`)
    }
    const project = persistence.projects.getById(workflow.projectId)
    if (!project) {
      throw new Error(`Project ${workflow.projectId} not found for runner enqueue`)
    }
    const runnerInstanceId = `wf-runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    persistence.workflowSteps.update(step.id, { status: 'running', runnerInstanceId, readyAt: null })
    checkpointPersistence()
    const enqueueLatencyMs = Math.max(Date.now() - new Date(step.updatedAt).getTime(), 0)
    try {
      await runnerGateway.enqueue({
        workflowId: latest.workflowId,
        stepId: latest.id,
        runnerInstanceId,
        repositoryPath: project.repositoryPath,
        persistencePath: persistenceFilePath
      })
      console.info('[workflow]', {
        action: 'enqueue_step',
        workflowId: latest.workflowId,
        stepId: latest.id,
        runnerInstanceId,
        latencyMs: enqueueLatencyMs
      })
      recordRunnerEvent({
        workflowId: latest.workflowId,
        stepId: latest.id,
        type: 'runner.enqueue',
        status: 'succeeded',
        runnerInstanceId,
        attempts: latest.runnerAttempts ?? 0,
        latencyMs: enqueueLatencyMs
      })
    } catch (error) {
      const nextAttempt = (latest.runnerAttempts ?? 0) + 1
      if (nextAttempt >= runnerRetry.maxAttempts) {
        persistence.workflowSteps.update(step.id, {
          status: 'failed',
          runnerInstanceId: null,
          runnerAttempts: nextAttempt,
          readyAt: null,
          result: {
            error: 'Failed to enqueue workflow runner',
            attempts: nextAttempt,
            detail: error instanceof Error ? error.message : String(error)
          }
        })
        checkpointPersistence()
        persistence.workflowRunnerDeadLetters.insert({
          workflowId: latest.workflowId,
          stepId: latest.id,
          runnerInstanceId,
          attempts: nextAttempt,
          error: error instanceof Error ? error.message : String(error)
        })
        refreshWorkflowStatus(latest.workflowId, persistence.workflowSteps, persistence.workflows)
      } else {
        const retryAt = new Date(Date.now() + runnerRetry.backoffMs(nextAttempt)).toISOString()
        persistence.workflowSteps.update(step.id, {
          status: 'pending',
          runnerInstanceId: null,
          runnerAttempts: nextAttempt,
          readyAt: retryAt
        })
        checkpointPersistence()
      }
      console.warn('[workflow]', {
        action: 'enqueue_step_failed',
        workflowId: latest.workflowId,
        stepId: latest.id,
        runnerInstanceId,
        attempts: nextAttempt,
        maxAttempts: runnerRetry.maxAttempts,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: enqueueLatencyMs
      })
      recordRunnerEvent({
        workflowId: latest.workflowId,
        stepId: latest.id,
        type: 'runner.enqueue',
        status: 'failed',
        runnerInstanceId,
        attempts: nextAttempt,
        latencyMs: enqueueLatencyMs,
        metadata: {
          error: error instanceof Error ? error.message : String(error)
        }
      })
      throw error
    }
  }

  async function runStepById(input: { workflowId: string; stepId: string; runnerInstanceId: string }): Promise<void> {
    const { workflowId, stepId, runnerInstanceId } = input
    let step = persistence.workflowSteps.getById(stepId)
    if (!step) {
      throw new Error('Unknown workflow step')
    }
    if (step.workflowId !== workflowId) {
      throw new Error('Workflow step does not belong to requested workflow')
    }
    if (step.status !== 'running' || step.runnerInstanceId !== runnerInstanceId) {
      const awaited = await waitForRunnerAssignment(stepId, runnerInstanceId)
      if (awaited) {
        step = awaited
      }
      if (step && step.status === 'pending' && (!step.runnerInstanceId || step.runnerInstanceId === runnerInstanceId)) {
        persistence.workflowSteps.update(step.id, { status: 'running', runnerInstanceId, readyAt: null })
        checkpointPersistence()
        const reassigned = persistence.workflowSteps.getById(step.id)
        if (reassigned) {
          console.warn('[workflow]', {
            action: 'runner_assignment_self_heal',
            workflowId,
            stepId,
            runnerInstanceId
          })
          step = reassigned
        }
      }
    }
    if (step.status !== 'running') {
      console.error('[workflow]', {
        action: 'runner_invalid_step_status',
        workflowId,
        stepId,
        status: step.status,
        runnerInstanceId: step.runnerInstanceId
      })
      throw new Error('Workflow step is not running')
    }
    if (!step.runnerInstanceId) {
      throw new Error('Workflow step has no runner assigned')
    }
    if (step.runnerInstanceId !== runnerInstanceId) {
      throw new Error('Workflow runner token mismatch')
    }
    const executionLatencyMs = Math.max(Date.now() - new Date(step.updatedAt).getTime(), 0)
    console.info('[workflow]', {
      action: 'execute_step',
      workflowId: step.workflowId,
      stepId: step.id,
      runnerInstanceId,
      latencyMs: executionLatencyMs
    })
    recordRunnerEvent({
      workflowId: step.workflowId,
      stepId: step.id,
      type: 'runner.execute',
      status: 'started',
      runnerInstanceId,
      latencyMs: executionLatencyMs,
      attempts: step.runnerAttempts ?? 0
    })
    await executeStep(step)
  }

  async function waitForRunnerAssignment(stepId: string, runnerInstanceId: string): Promise<WorkflowStepRecord | null> {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const current = persistence.workflowSteps.getById(stepId)
      if (!current) {
        return null
      }
      if (current.status === 'running' && current.runnerInstanceId === runnerInstanceId) {
        return current
      }
      const awaitingAssignment =
        current.status === 'pending' && (!current.runnerInstanceId || current.runnerInstanceId === runnerInstanceId)
      if (!awaitingAssignment) {
        return current
      }
      await delay(50)
    }
    return persistence.workflowSteps.getById(stepId)
  }

  async function executeStep(step: WorkflowStepRecord): Promise<void> {
    const runnerTokenForEvent = step.runnerInstanceId ?? null
    const logExecutionState = (status: string, metadata?: Record<string, unknown>) => {
      recordRunnerEvent({
        workflowId: step.workflowId,
        stepId: step.id,
        type: 'runner.execute',
        status,
        runnerInstanceId: runnerTokenForEvent,
        metadata
      })
    }
    const workflow = persistence.workflows.getById(step.workflowId)
    if (!workflow) {
      finalizeStepWithoutExecution(step, { status: 'failed', result: { error: 'Workflow not found' } })
      logExecutionState('failed', { reason: 'workflow_missing' })
      return
    }
    if (workflow.status === 'cancelled') {
      finalizeStepWithoutExecution(
        step,
        {
          status: 'skipped',
          result: { note: 'Workflow was cancelled before the runner executed.' }
        },
        workflow.id
      )
      logExecutionState('skipped', { reason: 'workflow_cancelled' })
      return
    }
    if (workflow.status !== 'running') {
      finalizeStepWithoutExecution(
        step,
        { status: 'failed', result: { error: `Workflow is ${workflow.status}, cannot execute step.` } },
        workflow.id
      )
      logExecutionState('failed', { reason: 'workflow_not_running', status: workflow.status })
      return
    }
    const project = persistence.projects.getById(workflow.projectId)
    if (!project) {
      finalizeStepWithoutExecution(step, { status: 'failed', result: { error: 'Project not found' } }, workflow.id)
      logExecutionState('failed', { reason: 'project_missing' })
      return
    }

    const branchInfo = buildBranchInfo(project, workflow, step)
    let policyDecision: WorkflowPolicyDecision | null = null
    try {
      policyDecision = await workflowPolicy.authorizeStep({ workflow, project, step, branchInfo })
    } catch (error) {
      finalizeStepWithoutExecution(
        step,
        {
          status: 'failed',
          result: {
            error: 'Workflow policy evaluation failed',
            detail: error instanceof Error ? error.message : String(error)
          }
        },
        workflow.id
      )
      logExecutionState('failed', { reason: 'policy_evaluation_failed' })
      return
    }

    if (!policyDecision.allowed) {
      finalizeStepWithoutExecution(
        step,
        {
          status: 'failed',
          result: {
            error: policyDecision.reason ?? 'Workflow policy rejected this step.',
            policyAudit: buildPolicyAudit(step, policyDecision)
          }
        },
        workflow.id
      )
      logExecutionState('failed', { reason: 'policy_rejected' })
      return
    }

    let agentRun: AgentRunRecord | null = null
    try {
      agentRun = persistence.agentRuns.create({
        workflowStepId: step.id,
        projectId: project.id,
        branch: branchInfo.name,
        type: (step.data.agentType as string) ?? 'coding'
      })
    } catch (error) {
      finalizeStepWithoutExecution(
        step,
        {
          status: 'failed',
          result: {
            error: 'Failed to start agent run',
            detail: error instanceof Error ? error.message : String(error),
            policyAudit: buildPolicyAudit(step, policyDecision)
          }
        },
        workflow.id
      )
      logExecutionState('failed', { reason: 'agent_run_start_failed' })
      throw error
    }

    let workspace: RadicleWorkspaceInfo | undefined
    let radicleSession: RadicleSessionHandle | undefined
    let commitResult: CommitResult | null = null
    let provenanceLogsPath: string | null = null

    try {
      if (radicle) {
        radicleSession = await radicle.createSession({
          taskId: step.id,
          branchInfo,
          repositoryPath: project.repositoryPath,
          author: commitAuthor,
          metadata: {
            workflowId: workflow.id,
            projectId: project.id,
            stepId: step.id
          }
        })
        workspace = await radicleSession.start()
      }

      const result = await agentExecutor({ project, workflow, step, workspace, radicleSession })
      provenanceLogsPath = result.logsPath ?? null
      const agentFailure = detectAgentFailure(result.stepResult)

      if (workspace?.workspacePath) {
        await syncWorkspaceArtifactsIntoRepo(workspace.workspacePath, project.repositoryPath)
      }

      if (radicleSession) {
        if (result.skipCommit) {
          await radicleSession.abort()
        } else {
          const message = result.commitMessage ?? defaultCommitMessage(workflow, step)
          commitResult = await radicleSession.finish(message)
        }
      }

      const baseResult = result.stepResult ?? {
        note: 'No stepResult returned'
      }
      if (!provenanceLogsPath) {
        provenanceLogsPath = await createWorkflowProvenanceLog(project.repositoryPath, {
          workflowId: workflow.id,
          projectId: project.id,
          stepId: step.id,
          repositoryPath: project.repositoryPath,
          workspacePath: workspace?.workspacePath ?? null,
          agentRunId: agentRun?.id ?? null,
          commitHash: commitResult?.commitHash ?? null,
          createdAt: new Date().toISOString()
        })
      }
      let pullRequestRecord: { id: string } | null = null
      if (commitResult && pullRequestModule) {
        const description = typeof baseResult.summary === 'string' ? baseResult.summary : null
        const targetBranch = branchInfo.baseBranch
        const pullRequest = await pullRequestModule.createPullRequest({
          projectId: project.id,
          title: commitResult.message,
          description,
          sourceBranch: commitResult.branch,
          targetBranch,
          authorUserId: pullRequestAuthorUserId
        })
        pullRequestRecord = { id: pullRequest.id }
      }
      const policyAudit = buildPolicyAudit(step, policyDecision)
      const enrichedResult = {
        ...baseResult,
        ...(workspace ? { workspace } : {}),
        ...(commitResult ? { commit: commitResult } : {}),
        ...(pullRequestRecord ? { pullRequest: pullRequestRecord } : {}),
        ...(provenanceLogsPath ? { provenance: { logsPath: provenanceLogsPath } } : {}),
        ...(policyAudit ? { policyAudit } : {})
      }
      persistence.workflowSteps.update(step.id, {
        status: agentFailure.failed ? 'failed' : 'completed',
        result: enrichedResult,
        runnerInstanceId: null
      })
      checkpointPersistence()
      if (agentRun) {
        persistence.agentRuns.update(agentRun.id, {
          status: agentFailure.failed ? 'failed' : 'succeeded',
          finishedAt: new Date().toISOString(),
          logsPath: result.logsPath ?? null
        })
      }
      logExecutionState(agentFailure.failed ? 'failed' : 'completed', {
        commitHash: commitResult?.commitHash ?? null,
        branch: commitResult?.branch ?? null
      })
    } catch (error) {
      if (radicleSession) {
        if (workspace?.workspacePath) {
          await syncWorkspaceArtifactsIntoRepo(workspace.workspacePath, project.repositoryPath)
        }
        await radicleSession.abort().catch(() => undefined)
      }
      const failureResult: Record<string, unknown> = {
        error: error instanceof Error ? error.message : String(error)
      }
      if (provenanceLogsPath) {
        failureResult.provenance = { logsPath: provenanceLogsPath }
      }
      if (policyDecision) {
        failureResult.policyAudit = buildPolicyAudit(step, policyDecision)
      }
      persistence.workflowSteps.update(step.id, {
        status: 'failed',
        result: failureResult,
        runnerInstanceId: null
      })
      checkpointPersistence()
      if (agentRun) {
        persistence.agentRuns.update(agentRun.id, {
          status: 'failed',
          finishedAt: new Date().toISOString()
        })
      }
      logExecutionState('failed', {
        error: error instanceof Error ? error.message : String(error)
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
    stopWorker,
    runStepById
  }
}

function resolvePersistenceFilePath(provided: string | undefined, persistence: WorkflowPersistenceAdapter): string {
  if (provided && provided.trim().length) {
    return normalizePersistencePath(provided.trim())
  }
  const maybeDb = (persistence as { db?: { name?: string } | undefined }).db
  if (maybeDb && typeof maybeDb.name === 'string' && maybeDb.name.trim().length) {
    return normalizePersistencePath(maybeDb.name.trim())
  }
  return ':memory:'
}

function normalizePersistencePath(candidate: string): string {
  if (candidate === ':memory:') {
    return ':memory:'
  }
  return path.resolve(candidate)
}

function isSqliteIoError(error: unknown): error is Database.SqliteError {
  return (
    error instanceof Database.SqliteError && typeof error.code === 'string' && error.code.startsWith('SQLITE_IOERR')
  )
}

function detectAgentFailure(stepResult?: Record<string, unknown> | null): { failed: boolean } {
  if (!stepResult || typeof stepResult !== 'object') {
    return { failed: false }
  }
  const agent = stepResult.agent as { outcome?: string } | undefined
  if (!agent || typeof agent.outcome !== 'string') {
    return { failed: false }
  }
  const outcome = agent.outcome.trim().toLowerCase()
  if (!outcome) {
    return { failed: false }
  }
  return { failed: outcome !== 'approved' }
}

function buildPolicyAudit(
  step: WorkflowStepRecord,
  decision: WorkflowPolicyDecision | null
): WorkflowPolicyAudit | undefined {
  if (!decision) return undefined
  return {
    runnerInstanceId: step.runnerInstanceId ?? null,
    decision,
    recordedAt: new Date().toISOString()
  }
}

function buildWorkflowStepId(workflowId: string, taskId: string): string {
  return `${workflowId}:${taskId}`
}

function refreshWorkflowStatus(
  workflowId: string,
  stepsRepo: WorkflowStepsRepository,
  workflowRepo: WorkflowsRepository
): void {
  const steps = stepsRepo.listByWorkflow(workflowId)
  if (!steps.length) return
  if (steps.every((step) => step.status === 'completed')) {
    workflowRepo.updateStatus(workflowId, 'completed')
    return
  }
  if (steps.some((step) => step.status === 'failed')) {
    workflowRepo.updateStatus(workflowId, 'failed')
    return
  }
}

function createDefaultExecutor(): AgentExecutor {
  return async ({ step, workspace }) => {
    await delay(250)
    return {
      stepResult: {
        summary: `Prepared workspace for "${step.data.title ?? step.id}"`,
        instructions: step.data.instructions,
        workspacePath: workspace?.workspacePath
      },
      skipCommit: true
    }
  }
}

function buildBranchInfo(
  project: ProjectRecord,
  workflow: WorkflowRecord,
  step: WorkflowStepRecord
): { name: string; baseBranch: string } {
  const explicitStepBranch = typeof step.data.branch === 'string' && step.data.branch.length ? step.data.branch : null
  const workflowBranch =
    typeof workflow.data.branch === 'string' && workflow.data.branch.length ? (workflow.data.branch as string) : null
  const baseBranch =
    typeof workflow.data.baseBranch === 'string' && workflow.data.baseBranch.length
      ? (workflow.data.baseBranch as string)
      : project.defaultBranch
  const fallback = `wf-${slugify(workflow.id)}-${step.sequence}`
  return {
    name: explicitStepBranch ?? workflowBranch ?? fallback,
    baseBranch
  }
}

function defaultCommitMessage(workflow: WorkflowRecord, step: WorkflowStepRecord): string {
  const workflowLabel = workflow.kind ?? 'workflow'
  const stepLabel = (step.data.title as string) ?? step.id
  return `${workflowLabel}: ${stepLabel}`
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'branch'
  )
}

async function createWorkflowProvenanceLog(
  repositoryPath: string | null | undefined,
  payload: Record<string, unknown>
): Promise<string | null> {
  if (!repositoryPath) return null
  const resolvedRepoPath = path.resolve(repositoryPath)
  const dir = path.join(resolvedRepoPath, '.hyperagent', 'workflow-logs')
  const fileName = `workflow-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  const filePath = path.join(dir, fileName)
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8')
    return filePath
  } catch (error) {
    console.warn('[workflow]', {
      action: 'provenance_log_failed',
      repositoryPath: resolvedRepoPath,
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

async function syncWorkspaceArtifactsIntoRepo(
  workspacePath: string | null | undefined,
  repositoryPath: string | null | undefined
): Promise<void> {
  if (!workspacePath || !repositoryPath) return
  const sourceDir = path.join(workspacePath, '.hyperagent')
  const targetDir = path.join(path.resolve(repositoryPath), '.hyperagent')
  try {
    const stats = await fs.stat(sourceDir)
    if (!stats.isDirectory()) return
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      console.warn('[workflow]', {
        action: 'workspace_log_probe_failed',
        workspacePath,
        error: error instanceof Error ? error.message : String(error)
      })
    }
    return
  }
  try {
    await copyDirectory(sourceDir, targetDir)
  } catch (error) {
    console.warn('[workflow]', {
      action: 'workspace_log_sync_failed',
      workspacePath,
      repositoryPath,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true })
  const entries = await fs.readdir(source, { withFileTypes: true })
  await Promise.all(
    entries.map(async (entry) => {
      const srcPath = path.join(source, entry.name)
      const destPath = path.join(destination, entry.name)
      if (entry.isDirectory()) {
        await copyDirectory(srcPath, destPath)
        return
      }
      if (entry.isSymbolicLink()) {
        const target = await fs.readlink(srcPath)
        await fs.symlink(target, destPath).catch(async () => {
          await fs.unlink(destPath).catch(() => undefined)
          await fs.symlink(target, destPath)
        })
        return
      }
      await fs.copyFile(srcPath, destPath)
    })
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export const workflowsPersistence: PersistenceModule<WorkflowsBindings> = {
  name: 'workflows',
  applySchema: (db) => {
    ensureWorkflowsTable(db)
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_steps (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflows(id),
        task_id TEXT,
        status TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        depends_on TEXT NOT NULL,
        data TEXT NOT NULL,
        result TEXT,
        runner_instance_id TEXT,
        runner_attempts INTEGER NOT NULL DEFAULT 0,
        ready_at TEXT,
        updated_at TEXT NOT NULL
      );
    `)
    const workflowStepColumns = db.prepare("PRAGMA table_info('workflow_steps')").all() as Array<{ name: string }>
    const hasRunnerInstanceId = workflowStepColumns.some((column) => column.name === 'runner_instance_id')
    if (!hasRunnerInstanceId) {
      db.exec('ALTER TABLE workflow_steps ADD COLUMN runner_instance_id TEXT')
    }
    const hasRunnerAttempts = workflowStepColumns.some((column) => column.name === 'runner_attempts')
    if (!hasRunnerAttempts) {
      db.exec('ALTER TABLE workflow_steps ADD COLUMN runner_attempts INTEGER NOT NULL DEFAULT 0')
    }
    const hasReadyAt = workflowStepColumns.some((column) => column.name === 'ready_at')
    if (!hasReadyAt) {
      db.exec('ALTER TABLE workflow_steps ADD COLUMN ready_at TEXT')
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_runner_dead_letters (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        runner_instance_id TEXT,
        attempts INTEGER NOT NULL,
        error TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_runner_events (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        runner_instance_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER,
        metadata TEXT,
        created_at TEXT NOT NULL
      );
    `)
  },
  createBindings: ({ db }: PersistenceContext) => ({
    workflows: createWorkflowsRepository(db),
    workflowSteps: createWorkflowStepsRepository(db),
    workflowRunnerDeadLetters: createWorkflowRunnerDeadLettersRepository(db),
    workflowRunnerEvents: createWorkflowRunnerEventsRepository(db)
  })
}

function ensureWorkflowsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      planner_run_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  const foreignKeys = db.prepare("PRAGMA foreign_key_list('workflows')").all() as Array<{ table: string }>
  const referencesProjects = foreignKeys.some((fk) => fk.table === 'projects')
  if (referencesProjects) {
    migrateWorkflowsTableWithoutProjectFk(db)
  }
}

function migrateWorkflowsTableWithoutProjectFk(db: Database.Database): void {
  const foreignKeysEnabled = Boolean(db.pragma('foreign_keys', { simple: true }))
  if (foreignKeysEnabled) {
    db.pragma('foreign_keys = OFF')
  }
  const migrate = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS workflows_migration')
    db.exec(`
      CREATE TABLE workflows_migration (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        planner_run_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    db.exec(`
      INSERT INTO workflows_migration (id, project_id, planner_run_id, kind, status, data, created_at, updated_at)
      SELECT id, project_id, planner_run_id, kind, status, data, created_at, updated_at FROM workflows;
    `)
    db.exec('DROP TABLE workflows')
    db.exec('ALTER TABLE workflows_migration RENAME TO workflows')
  })
  migrate()
  if (foreignKeysEnabled) {
    db.pragma('foreign_keys = ON')
  }
}

function createWorkflowsRepository(db: Database.Database): WorkflowsRepository {
  return {
    insert: (input) => {
      const now = new Date().toISOString()
      const id = input.id ?? crypto.randomUUID()
      db.prepare(
        `INSERT INTO workflows (id, project_id, planner_run_id, kind, status, data, created_at, updated_at)
         VALUES (@id, @projectId, @plannerRunId, @kind, @status, @data, @createdAt, @updatedAt)`
      ).run({
        id,
        projectId: input.projectId,
        plannerRunId: input.plannerRunId ?? null,
        kind: input.kind ?? 'custom',
        status: input.status ?? 'pending',
        data: JSON.stringify(input.data ?? {}),
        createdAt: now,
        updatedAt: now
      })
      const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id)
      return mapWorkflow(row)
    },
    updateStatus: (id, status) => {
      db.prepare('UPDATE workflows SET status = ?, updated_at = ? WHERE id = ?').run(
        status,
        new Date().toISOString(),
        id
      )
    },
    getById: (id) => {
      const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id)
      return row ? mapWorkflow(row) : null
    },
    list: (projectId) => {
      const rows = projectId
        ? db.prepare('SELECT * FROM workflows WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
        : db.prepare('SELECT * FROM workflows ORDER BY created_at DESC').all()
      return rows.map(mapWorkflow)
    }
  }
}

function createWorkflowStepsRepository(db: Database.Database): WorkflowStepsRepository {
  return {
    insertMany: (workflowId, steps) => {
      const insert = db.prepare(
        `INSERT INTO workflow_steps (id, workflow_id, task_id, status, sequence, depends_on, data, result, runner_instance_id, runner_attempts, ready_at, updated_at)
          VALUES (@id, @workflowId, @taskId, @status, @sequence, @dependsOn, @data, NULL, NULL, @runnerAttempts, @readyAt, @updatedAt)`
      )
      const now = new Date().toISOString()
      const records: WorkflowStepRecord[] = []
      const tx = db.transaction((batch: WorkflowStepInput[]) => {
        for (const step of batch) {
          const id = step.id ?? crypto.randomUUID()
          insert.run({
            id,
            workflowId,
            taskId: step.taskId ?? null,
            status: 'pending',
            sequence: step.sequence,
            dependsOn: JSON.stringify(step.dependsOn ?? []),
            data: JSON.stringify(step.data ?? {}),
            runnerAttempts: 0,
            readyAt: now,
            updatedAt: now
          })
          const row = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(id)
          records.push(mapWorkflowStep(row))
        }
      })
      tx(steps)
      return records
    },
    listByWorkflow: (workflowId) => {
      const rows = db
        .prepare('SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY sequence ASC')
        .all(workflowId)
      return rows.map(mapWorkflowStep)
    },
    findReady: (limit = 10) => {
      const now = new Date().toISOString()
      const rows = db
        .prepare(
          `SELECT ws.*, w.status as workflow_status
           FROM workflow_steps ws
           JOIN workflows w ON ws.workflow_id = w.id
           WHERE ws.status = 'pending' AND (ws.ready_at IS NULL OR ws.ready_at <= ?)
           ORDER BY ws.sequence ASC`
        )
        .all(now)
      const steps = (rows as Array<Record<string, unknown> & { workflow_status: WorkflowStatus }>)
        .filter((row) => row.workflow_status === 'running')
        .map(mapWorkflowStep)
      const ready: WorkflowStepRecord[] = []
      for (const step of steps) {
        if (ready.length >= limit) break
        const deps = step.dependsOn
        if (!deps.length) {
          ready.push(step)
          continue
        }
        const depStatuses = db
          .prepare(
            `SELECT status FROM workflow_steps WHERE workflow_id = ? AND id IN (${deps.map(() => '?').join(',')})`
          )
          .all(step.workflowId, ...deps) as Array<{ status: WorkflowStepStatus }>
        const satisfied = depStatuses.every((dep) => dep.status === 'completed')
        if (satisfied) {
          ready.push(step)
        }
      }
      return ready
    },
    claim: (stepId) => {
      const res = db
        .prepare(
          `UPDATE workflow_steps
           SET status = 'running', runner_instance_id = NULL, ready_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'pending'`
        )
        .run(new Date().toISOString(), stepId)
      return res.changes > 0
    },
    update: (stepId, patch) => {
      const current = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(stepId) as any
      if (!current) return
      const nextStatus = patch.status ?? current.status
      const nextResult =
        patch.result === undefined ? current.result : patch.result ? JSON.stringify(patch.result) : null
      const nextRunnerInstanceId =
        patch.runnerInstanceId === undefined ? (current.runner_instance_id ?? null) : patch.runnerInstanceId
      const nextRunnerAttempts =
        patch.runnerAttempts === undefined ? (current.runner_attempts ?? 0) : patch.runnerAttempts
      const nextReadyAt = patch.readyAt === undefined ? (current.ready_at ?? null) : patch.readyAt
      db.prepare(
        `UPDATE workflow_steps
         SET status = ?, result = ?, runner_instance_id = ?, runner_attempts = ?, ready_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        nextStatus,
        nextResult,
        nextRunnerInstanceId,
        nextRunnerAttempts,
        nextReadyAt,
        new Date().toISOString(),
        stepId
      )
    },
    getById: (stepId) => {
      const row = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(stepId)
      return row ? mapWorkflowStep(row) : null
    },
    getQueueMetrics: () => {
      const counts = db
        .prepare(
          `SELECT status, COUNT(*) as count
           FROM workflow_steps
           WHERE status IN ('pending', 'running')
           GROUP BY status`
        )
        .all() as Array<{ status: WorkflowStepStatus; count: number }>
      let pending = 0
      let running = 0
      for (const entry of counts) {
        if (entry.status === 'pending') pending = entry.count
        if (entry.status === 'running') running = entry.count
      }
      const staleThreshold = new Date(Date.now() - 15 * 60 * 1000).toISOString()
      const stuckRow = db
        .prepare(`SELECT COUNT(1) as count FROM workflow_steps WHERE status = 'running' AND updated_at <= ?`)
        .get(staleThreshold) as { count?: number }
      const heartbeatRow = db
        .prepare(`SELECT MAX(updated_at) as last FROM workflow_steps WHERE status = 'running'`)
        .get() as { last?: string | null }
      return {
        pending,
        running,
        stuck: typeof stuckRow.count === 'number' ? stuckRow.count : 0,
        lastHeartbeatAt: heartbeatRow?.last ?? null
      }
    }
  }
}

function createWorkflowRunnerDeadLettersRepository(db: Database.Database): WorkflowRunnerDeadLettersRepository {
  return {
    insert: (input) => {
      const now = new Date().toISOString()
      const id = input.id ?? crypto.randomUUID()
      db.prepare(
        `INSERT INTO workflow_runner_dead_letters (id, workflow_id, step_id, runner_instance_id, attempts, error, created_at)
         VALUES (@id, @workflowId, @stepId, @runnerInstanceId, @attempts, @error, @createdAt)`
      ).run({
        id,
        workflowId: input.workflowId,
        stepId: input.stepId,
        runnerInstanceId: input.runnerInstanceId ?? null,
        attempts: input.attempts,
        error: input.error,
        createdAt: now
      })
      const row = db.prepare('SELECT * FROM workflow_runner_dead_letters WHERE id = ?').get(id)
      return mapWorkflowRunnerDeadLetter(row)
    },
    listRecent: (limit = 25) => {
      const rows = db.prepare('SELECT * FROM workflow_runner_dead_letters ORDER BY created_at DESC LIMIT ?').all(limit)
      return rows.map(mapWorkflowRunnerDeadLetter)
    }
  }
}

function createWorkflowRunnerEventsRepository(db: Database.Database): WorkflowRunnerEventsRepository {
  return {
    insert: (input) => {
      const now = new Date().toISOString()
      const id = input.id ?? crypto.randomUUID()
      db.prepare(
        `INSERT INTO workflow_runner_events (id, workflow_id, step_id, type, status, runner_instance_id, attempts, latency_ms, metadata, created_at)
         VALUES (@id, @workflowId, @stepId, @type, @status, @runnerInstanceId, @attempts, @latencyMs, @metadata, @createdAt)`
      ).run({
        id,
        workflowId: input.workflowId,
        stepId: input.stepId,
        type: input.type,
        status: input.status,
        runnerInstanceId: input.runnerInstanceId ?? null,
        attempts: input.attempts ?? 0,
        latencyMs: input.latencyMs ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        createdAt: now
      })
      const row = db.prepare('SELECT * FROM workflow_runner_events WHERE id = ?').get(id)
      return mapWorkflowRunnerEvent(row)
    },
    listRecent: (limit = 100) => {
      const rows = db.prepare('SELECT * FROM workflow_runner_events ORDER BY created_at DESC LIMIT ?').all(limit)
      return rows.map(mapWorkflowRunnerEvent)
    },
    listByWorkflow: (workflowId, limit = 100) => {
      const rows = db
        .prepare('SELECT * FROM workflow_runner_events WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(workflowId, limit)
      return rows.map(mapWorkflowRunnerEvent)
    }
  }
}

function mapWorkflow(row: any): WorkflowRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    plannerRunId: row.planner_run_id ?? null,
    kind: row.kind,
    status: row.status,
    data: parseJsonField<Record<string, unknown>>(row.data, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapWorkflowStep(row: any): WorkflowStepRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    taskId: row.task_id ?? null,
    status: row.status,
    sequence: row.sequence,
    dependsOn: parseJsonField<string[]>(row.depends_on, []),
    data: parseJsonField<Record<string, unknown>>(row.data, {}),
    result: row.result ? parseJsonField<Record<string, unknown>>(row.result, {}) : null,
    runnerInstanceId: row.runner_instance_id ?? null,
    runnerAttempts: typeof row.runner_attempts === 'number' ? row.runner_attempts : 0,
    readyAt: row.ready_at ?? null,
    updatedAt: row.updated_at
  }
}

function mapWorkflowRunnerDeadLetter(row: any): WorkflowRunnerDeadLetterRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    stepId: row.step_id,
    runnerInstanceId: row.runner_instance_id ?? null,
    attempts: row.attempts,
    error: row.error,
    createdAt: row.created_at
  }
}

function mapWorkflowRunnerEvent(row: any): WorkflowRunnerEventRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    stepId: row.step_id,
    type: row.type,
    status: row.status,
    runnerInstanceId: row.runner_instance_id ?? null,
    attempts: typeof row.attempts === 'number' ? row.attempts : 0,
    latencyMs:
      typeof row.latency_ms === 'number' ? row.latency_ms : row.latency_ms == null ? null : Number(row.latency_ms),
    metadata: row.metadata ? parseJsonField<Record<string, unknown>>(row.metadata, {}) : null,
    createdAt: row.created_at
  }
}

function parseJsonField<T>(value: string | null, fallback: T): T {
  if (value == null || value === '') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
