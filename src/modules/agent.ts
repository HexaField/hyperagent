import os from 'os'
import { callLLM, type LLMResponse, type Provider } from './llm'

type WorkerStatus = 'working' | 'done' | 'blocked'
type VerifierVerdict = 'instruct' | 'approve' | 'fail'

const WORKER_SYSTEM_PROMPT = `You are Forge, a meticulous senior engineer agent focused on producing concrete, technically sound deliverables. Follow verifier instructions with discipline.

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

const VERIFIER_SYSTEM_PROMPT = `You are Axiom, a staff-level instructor verifying a worker agent's output for a demanding software task.

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
  provider?: Provider
  model?: string
  maxRounds?: number
  sessionDir?: string
  workerSessionId?: string
  verifierSessionId?: string
}

export type AgentLoopResult = {
  outcome: 'approved' | 'failed' | 'max-rounds'
  reason: string
  bootstrap: VerifierTurn
  rounds: ConversationRound[]
}

export async function runVerifierWorkerLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const provider = options.provider ?? 'ollama'
  const model = options.model ?? 'llama3.2'
  const maxRounds = options.maxRounds ?? 3
  const workerSessionId = options.workerSessionId ?? `worker-${Date.now()}`
  const verifierSessionId = options.verifierSessionId ?? `verifier-${Date.now()}`
  const sessionDir = options.sessionDir ?? os.tmpdir() // Use OS temp dir if none provided

  const rounds: ConversationRound[] = []

  const bootstrap = await invokeVerifier({
    provider,
    model,
    sessionDir,
    sessionId: verifierSessionId,
    userInstructions: options.userInstructions,
    workerTurn: null,
    round: 0
  })

  let pendingInstructions = bootstrap.parsed.instructions || options.userInstructions
  let latestCritique = bootstrap.parsed.critique

  for (let round = 1; round <= maxRounds; round++) {
    const workerTurn = await invokeWorker({
      provider,
      model,
      sessionDir,
      sessionId: workerSessionId,
      userInstructions: options.userInstructions,
      verifierInstructions: pendingInstructions,
      verifierCritique: latestCritique,
      round
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
      provider,
      model,
      sessionDir,
      sessionId: verifierSessionId,
      userInstructions: options.userInstructions,
      workerTurn,
      round
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
  provider: Provider
  model: string
  sessionDir?: string
  sessionId: string
  userInstructions: string
  verifierInstructions: string
  verifierCritique?: string
  round: number
}

type VerifierInvokeArgs = {
  provider: Provider
  model: string
  sessionDir?: string
  sessionId: string
  userInstructions: string
  workerTurn: WorkerTurn | null
  round: number
}

async function invokeWorker(args: WorkerInvokeArgs): Promise<WorkerTurn> {
  const query = buildWorkerPrompt(args.userInstructions, args.verifierInstructions, args.verifierCritique, args.round)
  const res = await callLLM(WORKER_SYSTEM_PROMPT, query, args.provider, args.model, {
    sessionDir: args.sessionDir,
    sessionId: args.sessionId
  })

  const parsed = parseWorkerResponse('worker', res)
  return { round: args.round, raw: res.data || '', parsed }
}

async function invokeVerifier(args: VerifierInvokeArgs): Promise<VerifierTurn> {
  const query = buildVerifierPrompt(args.userInstructions, args.workerTurn, args.round)
  const res = await callLLM(VERIFIER_SYSTEM_PROMPT, query, args.provider, args.model, {
    sessionDir: args.sessionDir,
    sessionId: args.sessionId
  })

  const parsed = parseVerifierResponse('verifier', res)
  return { round: args.round, raw: res.data || '', parsed }
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

function parseWorkerResponse(role: 'worker', res: LLMResponse): WorkerStructuredResponse {
  const obj = parseJsonPayload(role, res)
  const status = normalizeWorkerStatus(obj.status)
  return {
    status,
    plan: coerceString(obj.plan ?? obj.analysis ?? obj.summary ?? obj.reasoning ?? obj.work ?? ''),
    work: coerceString(obj.work ?? obj.output ?? obj.result ?? obj.answer ?? obj.plan ?? ''),
    requests: coerceString(obj.requests ?? obj.questions ?? obj.blockers ?? '')
  }
}

function parseVerifierResponse(role: 'verifier', res: LLMResponse): VerifierStructuredResponse {
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

function parseJsonPayload(role: string, res: LLMResponse): any {
  if (!res.success || !res.data) {
    throw new Error(`${role} LLM call failed: ${res.error || 'unknown error'}`)
  }
  const jsonText = extractJson(res.data)
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
