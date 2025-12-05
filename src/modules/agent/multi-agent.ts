import { Part, Session } from '@opencode-ai/sdk'
import crypto from 'crypto'
import type { PersistenceContext, PersistenceModule, Timestamp } from '../database'
import { appendLogEntry, loadSessionMeta } from '../provenance/provenance'
import { createSession, extractResponseText, promptSession } from './opencode'

type WorkerStatus = 'working' | 'done' | 'blocked'
type VerifierVerdict = 'instruct' | 'approve' | 'fail'

const MAX_JSON_ATTEMPTS = 3

const WORKER_SYSTEM_PROMPT = `You are a meticulous senior engineer agent focused on producing concrete, technically sound deliverables. Follow verifier instructions with discipline.

Always return STRICT JSON with the shape:
{
	"status": "working" | "done" | "blocked",
	"plan": "short bullet-style plan clarifying approach",
	"work": "precise description of what you produced or analysed",
	"requests": "questions or additional info you need (empty string if none)"
}

Rules:
- Think aloud inside the plan field; keep "work" actionable (code, commands, or decisions).
- Use status "done" only when you believe the user instructions are satisfied.
- Use status "blocked" when you cannot proceed without missing info; include what is missing in requests.
- Never include Markdown fences or commentary outside the JSON object.`

const VERIFIER_SYSTEM_PROMPT = `You are a staff-level instructor verifying a worker agent's output for a demanding software task.

Responsibilities:
1. Internalize the user's objectives and acceptance criteria.
2. Examine the worker's most recent JSON response for correctness, completeness, safety, and alignment with the user request.
3. Provide laser-focused guidance that unblocks or sharpens the worker's next move.

Response policy:
- Always return STRICT JSON with the shape:
{
	"verdict": "instruct" | "approve" | "fail",
	"critique": "succinct reasoning referencing concrete requirements",
	"instructions": "ordered guidance for the worker to follow next",
	"priority": number (1-5, where 1 is critical blocker)
}
- Use verdict "approve" ONLY when the worker's latest submission fully satisfies the user instructions.
- Use "fail" when the worker is off-track or violating constraints; clearly state blockers in critique.
- Otherwise respond with "instruct" and provide the next best set of actions in the instructions field.
- Keep critiques grounded in evidence and reference specific user needs or defects.
- Assume future turns depend solely on your guidance—be explicit about quality bars, edge cases, and verification steps.`

export type WorkerTurn = {
  round: number
  raw: string
  parsed: WorkerStructuredResponse
}

export type VerifierTurn = {
  round: number
  raw: string
  parsed: VerifierStructuredResponse
}

export type WorkerStructuredResponse = {
  status: WorkerStatus
  plan: string
  work: string
  requests: string
}

export type VerifierStructuredResponse = {
  verdict: VerifierVerdict
  critique: string
  instructions: string
  priority: number
}

export type ConversationRound = {
  worker: WorkerTurn
  verifier: VerifierTurn
}

export type AgentLoopOptions = {
  userInstructions: string
  model?: string
  maxRounds?: number
  sessionDir?: string
  workerSessionId?: string
  verifierSessionId?: string
  onStream?: AgentStreamCallback
}

export type AgentLoopResult = {
  outcome: 'approved' | 'failed' | 'max-rounds'
  reason: string
  bootstrap: VerifierTurn
  rounds: ConversationRound[]
}

export type AgentStreamEvent = {
  role: 'worker' | 'verifier'
  round: number
  parts: Part[]
  model: string
  attempt: number
  sessionId?: string
}

export type AgentStreamCallback = (event: AgentStreamEvent) => void

export async function runVerifierWorkerLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const model = options.model ?? 'llama3.2'
  const maxRounds = options.maxRounds ?? 10
  const directory = options.sessionDir
  if (!directory) throw new Error('sessionDir is required for runVerifierWorkerLoop')

  const streamCallback = options.onStream

  const runId = `run-${Date.now()}`
  const workerSession = await createSession(directory)
  const verifierSession = await createSession(directory)

  const rounds: ConversationRound[] = []

  const bootstrap = await invokeVerifier({
    model,
    session: verifierSession,
    userInstructions: options.userInstructions,
    workerTurn: null,
    round: 0,
    onStream: streamCallback,
    runId,
    directory
  })

  let pendingInstructions = bootstrap.parsed.instructions || options.userInstructions
  let latestCritique = bootstrap.parsed.critique

  for (let round = 1; round <= maxRounds; round++) {
    const workerTurn = await invokeWorker({
      model,
      session: workerSession,
      userInstructions: options.userInstructions,
      verifierInstructions: pendingInstructions,
      verifierCritique: latestCritique,
      round,
      onStream: streamCallback,
      runId,
      directory
    })

    if (workerTurn.parsed.status === 'blocked') {
      return {
        outcome: 'failed',
        reason: workerTurn.parsed.requests || 'worker reported blocked status',
        bootstrap,
        rounds: [...rounds, { worker: workerTurn, verifier: minimalVerifierEcho(workerTurn, round) }]
      }
    }

    const verifierTurn = await invokeVerifier({
      model,
      session: verifierSession,
      userInstructions: options.userInstructions,
      workerTurn,
      round,
      onStream: streamCallback,
      runId,
      directory
    })

    rounds.push({ worker: workerTurn, verifier: verifierTurn })

    if (verifierTurn.parsed.verdict === 'approve') {
      return {
        outcome: 'approved',
        reason: verifierTurn.parsed.critique || 'Verifier approved the work',
        bootstrap,
        rounds
      }
    }

    if (verifierTurn.parsed.verdict === 'fail') {
      return {
        outcome: 'failed',
        reason: verifierTurn.parsed.critique || 'Verifier rejected the work',
        bootstrap,
        rounds
      }
    }

    pendingInstructions = verifierTurn.parsed.instructions || pendingInstructions
    latestCritique = verifierTurn.parsed.critique
  }

  return {
    outcome: 'max-rounds',
    reason: `Verifier never approved within ${maxRounds} rounds`,
    bootstrap,
    rounds
  }
}

type WorkerInvokeArgs = {
  model: string
  session: Session
  userInstructions: string
  verifierInstructions: string
  verifierCritique?: string
  round: number
  onStream?: AgentStreamCallback
  runId: string
  directory: string
}

type VerifierInvokeArgs = {
  model: string
  session: Session
  userInstructions: string
  workerTurn: WorkerTurn | null
  round: number
  onStream?: AgentStreamCallback
  runId: string
  directory: string
}

async function invokeWorker(args: WorkerInvokeArgs): Promise<WorkerTurn> {
  const query = buildWorkerPrompt(args.userInstructions, args.verifierInstructions, args.verifierCritique, args.round)
  const { raw, parsed } = await invokeStructuredJsonCall({
    role: 'worker',
    systemPrompt: WORKER_SYSTEM_PROMPT,
    basePrompt: query,
    model: args.model,
    session: args.session,
    runId: args.runId,
    directory: args.directory,
    onStream: args.onStream,
    parseResponse: (response) => parseWorkerResponse('worker', response)
  })
  console.log(raw, parsed)
  return { round: args.round, raw, parsed }
}

async function invokeVerifier(args: VerifierInvokeArgs): Promise<VerifierTurn> {
  const query = buildVerifierPrompt(args.userInstructions, args.workerTurn, args.round)
  const { raw, parsed } = await invokeStructuredJsonCall({
    role: 'verifier',
    systemPrompt: VERIFIER_SYSTEM_PROMPT,
    basePrompt: query,
    model: args.model,
    session: args.session,
    runId: args.runId,
    directory: args.directory,
    onStream: args.onStream,
    parseResponse: (response) => parseVerifierResponse('verifier', response)
  })
  console.log(raw, parsed)
  return { round: args.round, raw, parsed }
}

function buildWorkerPrompt(
  userInstructions: string,
  verifierInstructions: string,
  verifierCritique: string | undefined,
  round: number
): string {
  const critiqueSection = verifierCritique ? `Verifier critique to remember: \n${verifierCritique}` : ''
  return [
    `Primary task from the user:\n${userInstructions}`,
    `Verifier guidance for round #${round}:\n${verifierInstructions}`,
    critiqueSection,
    'Deliver concrete progress that can be validated immediately.'
  ]
    .filter(Boolean)
    .join('\n\n')
}

function buildVerifierPrompt(userInstructions: string, workerTurn: WorkerTurn | null, round: number): string {
  if (!workerTurn) {
    return [
      `User instructions:\n${userInstructions}`,
      'The worker has not produced any output yet. Provide the first set of instructions that sets them up for success.'
    ].join('\n\n')
  }

  return [
    `User instructions:\n${userInstructions}`,
    `Latest worker JSON (round #${round}):\n${workerTurn.raw}`,
    'Evaluate the worker output, note gaps, and craft the next set of instructions. '
  ].join('\n\n')
}

function parseWorkerResponse(role: 'worker', res: string): WorkerStructuredResponse {
  const obj = parseJsonPayload(role, res)
  const status = normalizeWorkerStatus(obj.status)
  return {
    status,
    plan: coerceString(obj.plan ?? obj.analysis ?? obj.summary ?? obj.reasoning ?? obj.work ?? ''),
    work: coerceString(obj.work ?? obj.output ?? obj.result ?? obj.answer ?? obj.plan ?? ''),
    requests: coerceString(obj.requests ?? obj.questions ?? obj.blockers ?? '')
  }
}

function parseVerifierResponse(role: 'verifier', res: string): VerifierStructuredResponse {
  const obj = parseJsonPayload(role, res)
  const verdict = normalizeVerifierVerdict(obj.verdict ?? obj.status)
  const priority = Number.isInteger(obj.priority) ? obj.priority : 3
  return {
    verdict,
    critique: coerceString(obj.critique ?? obj.feedback ?? ''),
    instructions: coerceString(obj.instructions ?? obj.next_steps ?? obj.plan ?? obj.guidance ?? ''),
    priority: priority as number
  }
}

function parseJsonPayload(role: string, res: string): any {
  // if (!res.success || !res.data) {
  //   throw new Error(`${role} LLM call failed: ${res.error || 'unknown error'}`)
  // }
  const jsonText = extractJson(res)
  try {
    return JSON.parse(jsonText)
  } catch (error) {
    throw new Error(`${role} returned invalid JSON: ${error}`)
  }
}

function extractJson(raw: string): string {
  const match = raw.match(/```json\s*([\s\S]*?)```/i)
  if (match && match[1]) {
    return match[1].trim()
  }
  return raw.trim()
}

function coerceString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function normalizeWorkerStatus(value: unknown): WorkerStatus {
  const asString = typeof value === 'string' ? value.toLowerCase() : 'working'
  if (asString === 'done' || asString === 'blocked') {
    return asString
  }
  return 'working'
}

function normalizeVerifierVerdict(value: unknown): VerifierVerdict {
  const asString = typeof value === 'string' ? value.toLowerCase() : 'instruct'
  if (asString === 'approve' || asString === 'fail') {
    return asString
  }
  return 'instruct'
}

function minimalVerifierEcho(workerTurn: WorkerTurn, round: number): VerifierTurn {
  return {
    round,
    raw: JSON.stringify({ verdict: 'fail', critique: workerTurn.parsed.requests, instructions: '', priority: 1 }),
    parsed: {
      verdict: 'fail',
      critique: workerTurn.parsed.requests,
      instructions: '',
      priority: 1
    }
  }
}

type StructuredJsonCallOptions<T> = {
  role: 'worker' | 'verifier'
  systemPrompt: string
  basePrompt: string
  model: string
  session: Session
  runId: string
  directory: string
  onStream?: AgentStreamCallback
  parseResponse: (res: string) => T
}

async function invokeStructuredJsonCall<T>(options: StructuredJsonCallOptions<T>): Promise<{ raw: string; parsed: T }> {
  let prompt = options.basePrompt
  let lastError: Error | null = null

  const meta = loadSessionMeta(options.runId, options.directory)

  for (let attempt = 1; attempt <= MAX_JSON_ATTEMPTS; attempt++) {
    const response = await promptSession(options.session, [options.systemPrompt, prompt], options.model)
    const raw = extractResponseText(response.parts)

    appendLogEntry(
      options.runId,
      meta,
      {
        provider: 'opencode',
        model: options.model,
        role: options.role,
        payload: {
          attempt,
          prompt,
          rawResponse: raw
        }
      },
      options.directory
    )

    try {
      const parsed = options.parseResponse(raw)

      options.onStream?.({
        role: options.role,
        round: attempt,
        parts: response.parts,
        model: options.model,
        attempt: 1,
        sessionId: options.session.id
      })
      return { raw, parsed }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      console.warn('[agent] structured JSON call failed', {
        role: options.role,
        attempt,
        error: lastError.message
      })
      if (attempt === MAX_JSON_ATTEMPTS) {
        throw lastError
      }
      prompt = buildRetryPrompt(options.basePrompt, lastError.message)
    }
  }

  throw lastError ?? new Error('Structured agent call failed')
}

function buildRetryPrompt(basePrompt: string, errorMessage: string): string {
  return `${basePrompt}

IMPORTANT: Your previous response was invalid JSON (${errorMessage}). Respond again with STRICT JSON only, without code fences or commentary.`
}

export type AgentRunStatus = 'running' | 'succeeded' | 'failed'

export type AgentRunRecord = {
  id: string
  workflowStepId: string | null
  projectId: string
  branch: string
  type: string
  status: AgentRunStatus
  startedAt: Timestamp
  finishedAt: Timestamp | null
  logsPath: string | null
}

export type AgentRunInput = {
  id?: string
  workflowStepId?: string | null
  projectId: string
  branch: string
  type: string
  status?: AgentRunStatus
  logsPath?: string | null
}

export type AgentRunsRepository = {
  create: (input: AgentRunInput) => AgentRunRecord
  update: (id: string, patch: Partial<Pick<AgentRunRecord, 'status' | 'finishedAt' | 'logsPath'>>) => void
  listByWorkflow: (workflowId: string) => AgentRunRecord[]
}

export type AgentRunsBindings = {
  agentRuns: AgentRunsRepository
}

export const agentRunsPersistence: PersistenceModule<AgentRunsBindings> = {
  name: 'agentRuns',
  applySchema: (db) => {
    ensureAgentRunsTable(db)
  },
  createBindings: ({ db }: PersistenceContext) => ({
    agentRuns: createAgentRunsRepository(db)
  })
}

function ensureAgentRunsTable(db: PersistenceContext['db']): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      workflow_step_id TEXT REFERENCES workflow_steps(id),
      project_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      logs_path TEXT
    );
  `)
  const foreignKeys = db.prepare("PRAGMA foreign_key_list('agent_runs')").all() as Array<{ table: string }>
  const referencesProjects = foreignKeys.some((fk) => fk.table === 'projects')
  if (referencesProjects) {
    migrateAgentRunsTableWithoutProjectFk(db)
  }
}

function migrateAgentRunsTableWithoutProjectFk(db: PersistenceContext['db']): void {
  const foreignKeysEnabled = Boolean(db.pragma('foreign_keys', { simple: true }))
  if (foreignKeysEnabled) {
    db.pragma('foreign_keys = OFF')
  }
  const migrate = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS agent_runs_migration')
    db.exec(`
      CREATE TABLE agent_runs_migration (
        id TEXT PRIMARY KEY,
        workflow_step_id TEXT REFERENCES workflow_steps(id),
        project_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        logs_path TEXT
      );
    `)
    db.exec(`
      INSERT INTO agent_runs_migration (id, workflow_step_id, project_id, branch, type, status, started_at, finished_at, logs_path)
      SELECT id, workflow_step_id, project_id, branch, type, status, started_at, finished_at, logs_path FROM agent_runs;
    `)
    db.exec('DROP TABLE agent_runs')
    db.exec('ALTER TABLE agent_runs_migration RENAME TO agent_runs')
  })
  migrate()
  if (foreignKeysEnabled) {
    db.pragma('foreign_keys = ON')
  }
}

function createAgentRunsRepository(db: PersistenceContext['db']): AgentRunsRepository {
  return {
    create: (input) => {
      const id = input.id ?? crypto.randomUUID()
      const startedAt = new Date().toISOString()
      db.prepare(
        `INSERT INTO agent_runs (id, workflow_step_id, project_id, branch, type, status, started_at, finished_at, logs_path)
         VALUES (@id, @workflowStepId, @projectId, @branch, @type, @status, @startedAt, NULL, @logsPath)`
      ).run({
        id,
        workflowStepId: input.workflowStepId ?? null,
        projectId: input.projectId,
        branch: input.branch,
        type: input.type,
        status: input.status ?? 'running',
        startedAt,
        logsPath: input.logsPath ?? null
      })
      const row = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id)
      return mapAgentRun(row)
    },
    update: (id, patch) => {
      const record = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as any
      if (!record) return
      db.prepare(
        `UPDATE agent_runs
         SET status = ?, finished_at = ?, logs_path = ?
         WHERE id = ?`
      ).run(
        patch.status ?? record.status,
        patch.finishedAt ?? record.finished_at,
        patch.logsPath ?? record.logs_path,
        id
      )
    },
    listByWorkflow: (workflowId) => {
      const rows = db
        .prepare(
          `SELECT ar.*
           FROM agent_runs ar
           JOIN workflow_steps ws ON ar.workflow_step_id = ws.id
           WHERE ws.workflow_id = ?
           ORDER BY ar.started_at DESC`
        )
        .all(workflowId)
      return rows.map(mapAgentRun)
    }
  }
}

function mapAgentRun(row: any): AgentRunRecord {
  return {
    id: row.id,
    workflowStepId: row.workflow_step_id ?? null,
    projectId: row.project_id,
    branch: row.branch,
    type: row.type,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    logsPath: row.logs_path ?? null
  }
}
