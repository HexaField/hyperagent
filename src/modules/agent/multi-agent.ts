/*
  Original multi-agent implementation restored and adjusted to import shared
  helpers from `agent.ts`. This file keeps the verifier/worker orchestration
  and relies on the shared `invokeWorker`, `invokeStructuredJsonCall`, and
  parsing helpers implemented in `agent.ts`.
*/
import { Session } from '@opencode-ai/sdk'
import { createRunMeta, hasRunMeta, loadRunMeta, saveRunMeta } from '../provenance/provenance'
import { AgentStreamCallback, coerceString, invokeStructuredJsonCall, parseJsonPayload } from './agent'
export type { AgentStreamCallback } from './agent'
export type { AgentStreamEvent } from './agent'
import { createSession, getSession } from './opencode'

const WORKER_SYSTEM_PROMPT = `You are a meticulous senior engineer agent focused on producing concrete, technically sound deliverables. Follow verifier instructions with discipline.

Always return STRICT JSON with the shape:
{
\t"status": "working" | "done" | "blocked",
\t"plan": "short bullet-style plan clarifying approach",
\t"work": "precise description of what you produced or analysed",
\t"requests": "questions or additional info you need (empty string if none)"
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

type WorkerStatus = 'working' | 'done' | 'blocked'
type VerifierVerdict = 'instruct' | 'approve' | 'fail'

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

export type ConversationRound = {
  worker: WorkerTurn
  verifier: VerifierTurn
}

export type AgentLoopOptions = {
  runID?: string
  userInstructions: string
  model?: string
  maxRounds?: number
  sessionDir?: string
  onStream?: AgentStreamCallback
}

export type AgentLoopResult = {
  outcome: 'approved' | 'failed' | 'max-rounds'
  reason: string
  bootstrap: VerifierTurn
  rounds: ConversationRound[]
}

export async function runVerifierWorkerLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const model = options.model ?? 'llama3.2'
  const maxRounds = options.maxRounds ?? 10
  const directory = options.sessionDir
  if (!directory) throw new Error('sessionDir is required for runVerifierWorkerLoop')

  const streamCallback = options.onStream

  const runId = options.runID ?? `run-${Date.now()}`

  if (!hasRunMeta(runId, directory)) {
    const workerSession = await createSession(directory)
    const verifierSession = await createSession(directory)
    const agents = [
      { role: 'worker', sessionId: workerSession.id },
      { role: 'verifier', sessionId: verifierSession.id }
    ]
    const runMeta = createRunMeta(directory, runId, agents)
    saveRunMeta(runMeta, runId, directory)
  }

  const metaData = loadRunMeta(runId, directory)

  const workerSessionID = metaData.agents.find((a) => a.role === 'worker')?.sessionId
  const verifierSessionID = metaData.agents.find((a) => a.role === 'verifier')?.sessionId

  if (!workerSessionID || !verifierSessionID) {
    throw new Error('Missing worker or verifier session ID in run meta')
  }

  const workerSession = await getSession(directory, workerSessionID)
  const verifierSession = await getSession(directory, verifierSessionID)

  if (!workerSession) throw new Error(`Worker session not found: ${workerSessionID}`)
  if (!verifierSession) throw new Error(`Verifier session not found: ${verifierSessionID}`)

  const rounds: ConversationRound[] = []

  async function invokeVerifier(args: {
    model: string
    session: Session
    userInstructions: string
    workerTurn: WorkerTurn | null
    round: number
    onStream?: AgentStreamCallback
    runId: string
    directory: string
  }): Promise<VerifierTurn> {
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
    return { round: args.round, raw, parsed }
  }

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

export function parseVerifierResponse(role: 'verifier', res: string): VerifierStructuredResponse {
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

export async function invokeWorker(args: {
  model: string
  session: Session
  userInstructions: string
  verifierInstructions: string
  verifierCritique?: string
  round: number
  onStream?: AgentStreamCallback
  runId: string
  directory: string
}): Promise<WorkerTurn> {
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

export function minimalVerifierEcho(workerTurn: WorkerTurn, round: number): VerifierTurn {
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
