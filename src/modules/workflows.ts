import type Database from 'better-sqlite3'
import crypto from 'crypto'
import type { AgentRunRecord, AgentRunsRepository } from './agent'
import type { PersistenceContext, PersistenceModule, Timestamp } from './database'
import type { ProjectRecord, ProjectsRepository } from './projects'
import type {
  CommitResult,
  RadicleModule,
  RadicleSessionHandle,
  WorkspaceInfo as RadicleWorkspaceInfo
} from './radicle/types'
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
  update: (stepId: string, patch: Partial<Pick<WorkflowStepRecord, 'status' | 'result' | 'runnerInstanceId'>>) => void
  getById: (stepId: string) => WorkflowStepRecord | null
}

export type WorkflowsBindings = {
  workflows: WorkflowsRepository
  workflowSteps: WorkflowStepsRepository
}

type WorkflowPersistenceAdapter = {
  projects: ProjectsRepository
  workflows: WorkflowsRepository
  workflowSteps: WorkflowStepsRepository
  agentRuns: AgentRunsRepository
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

export type WorkflowRuntimeOptions = {
  persistence: WorkflowPersistenceAdapter
  agentExecutor?: AgentExecutor
  pollIntervalMs?: number
  radicle?: RadicleModule
  commitAuthor?: {
    name: string
    email: string
  }
  runnerGateway: WorkflowRunnerGateway
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

export function createWorkflowRuntime(options: WorkflowRuntimeOptions): WorkflowRuntime {
  const persistence = options.persistence
  const agentExecutor = options.agentExecutor ?? createDefaultExecutor()
  const pollInterval = options.pollIntervalMs ?? 1000
  const radicle = options.radicle
  const commitAuthor = options.commitAuthor ?? {
    name: 'Hyperagent Workflow',
    email: 'workflow@hyperagent.local'
  }
  const runnerGateway = options.runnerGateway

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

  async function runWorkerLoop() {
    while (workerRunning) {
      await processReadySteps(persistence.workflowSteps)
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
    const runnerInstanceId = `wf-runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    persistence.workflowSteps.update(step.id, { runnerInstanceId })
    try {
      await runnerGateway.enqueue({ workflowId: latest.workflowId, stepId: latest.id, runnerInstanceId })
    } catch (error) {
      persistence.workflowSteps.update(step.id, { runnerInstanceId: null })
      throw error
    }
  }

  async function runStepById(input: { workflowId: string; stepId: string; runnerInstanceId: string }): Promise<void> {
    const { workflowId, stepId, runnerInstanceId } = input
    const step = persistence.workflowSteps.getById(stepId)
    if (!step) {
      throw new Error('Unknown workflow step')
    }
    if (step.workflowId !== workflowId) {
      throw new Error('Workflow step does not belong to requested workflow')
    }
    if (step.status !== 'running') {
      throw new Error('Workflow step is not running')
    }
    if (!step.runnerInstanceId) {
      throw new Error('Workflow step has no runner assigned')
    }
    if (step.runnerInstanceId !== runnerInstanceId) {
      throw new Error('Workflow runner token mismatch')
    }
    await executeStep(step)
  }

  async function executeStep(step: WorkflowStepRecord): Promise<void> {
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

    let workspace: RadicleWorkspaceInfo | undefined
    let radicleSession: RadicleSessionHandle | undefined
    let commitResult: CommitResult | null = null
    let provenanceLogsPath: string | null = null

    try {
      if (radicle) {
        const branchInfo = buildBranchInfo(project, workflow, step)
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
      const enrichedResult = {
        ...baseResult,
        ...(workspace ? { workspace } : {}),
        ...(commitResult ? { commit: commitResult } : {}),
        ...(provenanceLogsPath ? { provenance: { logsPath: provenanceLogsPath } } : {})
      }
      persistence.workflowSteps.update(step.id, {
        status: agentFailure.failed ? 'failed' : 'completed',
        result: enrichedResult,
        runnerInstanceId: null
      })
      persistence.agentRuns.update(agentRun.id, {
        status: agentFailure.failed ? 'failed' : 'succeeded',
        finishedAt: new Date().toISOString(),
        logsPath: result.logsPath ?? null
      })
    } catch (error) {
      if (radicleSession) {
        await radicleSession.abort().catch(() => undefined)
      }
      const failureResult: Record<string, unknown> = {
        error: error instanceof Error ? error.message : String(error)
      }
      if (provenanceLogsPath) {
        failureResult.provenance = { logsPath: provenanceLogsPath }
      }
      persistence.workflowSteps.update(step.id, {
        status: 'failed',
        result: failureResult,
        runnerInstanceId: null
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
    stopWorker,
    runStepById
  }
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export const workflowsPersistence: PersistenceModule<WorkflowsBindings> = {
  name: 'workflows',
  applySchema: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        planner_run_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

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
        updated_at TEXT NOT NULL
      );
    `)
    const workflowStepColumns = db
      .prepare("PRAGMA table_info('workflow_steps')")
      .all() as Array<{ name: string }>
    const hasRunnerInstanceId = workflowStepColumns.some((column) => column.name === 'runner_instance_id')
    if (!hasRunnerInstanceId) {
      db.exec('ALTER TABLE workflow_steps ADD COLUMN runner_instance_id TEXT')
    }
  },
  createBindings: ({ db }: PersistenceContext) => ({
    workflows: createWorkflowsRepository(db),
    workflowSteps: createWorkflowStepsRepository(db)
  })
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
        `INSERT INTO workflow_steps (id, workflow_id, task_id, status, sequence, depends_on, data, result, runner_instance_id, updated_at)
         VALUES (@id, @workflowId, @taskId, @status, @sequence, @dependsOn, @data, NULL, NULL, @updatedAt)`
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
      const rows = db
        .prepare(
          `SELECT ws.*, w.status as workflow_status
           FROM workflow_steps ws
           JOIN workflows w ON ws.workflow_id = w.id
           WHERE ws.status = 'pending'
           ORDER BY ws.sequence ASC`
        )
        .all()
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
           SET status = 'running', runner_instance_id = NULL, updated_at = ?
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
        patch.runnerInstanceId === undefined ? current.runner_instance_id ?? null : patch.runnerInstanceId
      db.prepare(
        `UPDATE workflow_steps
         SET status = ?, result = ?, runner_instance_id = ?, updated_at = ?
         WHERE id = ?`
      ).run(nextStatus, nextResult, nextRunnerInstanceId, new Date().toISOString(), stepId)
    },
    getById: (stepId) => {
      const row = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(stepId)
      return row ? mapWorkflowStep(row) : null
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
    updatedAt: row.updated_at
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
