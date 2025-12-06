import type { FileDiff } from '@opencode-ai/sdk'
import { AgentRunResponse, AgentStreamCallback } from './agent'
import {
  getWorkflowRunDiff,
  runAgentWorkflow,
  type AgentWorkflowRound,
  type AgentWorkflowTurn
} from './agent-orchestrator'
import {
  verifierWorkerWorkflowDefinition,
  type VerifierWorkerWorkflowDefinition,
  type VerifierWorkerWorkflowResult
} from './workflows'

export type { AgentStreamCallback, AgentStreamEvent } from './agent'

const WORKER_ROLE = 'worker'
const VERIFIER_ROLE = 'verifier'
const getVerifierWorkflow = () => verifierWorkerWorkflowDefinition

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

export async function runVerifierWorkerLoop(options: AgentLoopOptions): Promise<AgentRunResponse<AgentLoopResult>> {
  const directory = options.sessionDir
  if (!directory) throw new Error('sessionDir is required for runVerifierWorkerLoop')

  const workflow = getVerifierWorkflow()
  const runResponse = await runAgentWorkflow(workflow, {
    runID: options.runID,
    userInstructions: options.userInstructions,
    model: options.model,
    maxRounds: options.maxRounds,
    sessionDir: directory,
    onStream: options.onStream
  })

  return {
    runId: runResponse.runId,
    result: runResponse.result.then((result) => convertWorkflowResult(result))
  }
}

export async function getMultiAgentRunDiff(
  runId: string,
  directory: string,
  options: { role?: 'worker' | 'verifier'; messageId?: string } = {}
): Promise<FileDiff[]> {
  if (!directory) throw new Error('sessionDir is required for getMultiAgentRunDiff')
  const targetRole = options.role ?? WORKER_ROLE
  return getWorkflowRunDiff(runId, directory, { role: targetRole, messageId: options.messageId })
}

type VerifierWorkflowTurn = AgentWorkflowTurn<VerifierWorkerWorkflowDefinition>
type VerifierWorkflowRound = AgentWorkflowRound<VerifierWorkerWorkflowDefinition>

function convertWorkflowResult(result: VerifierWorkerWorkflowResult): AgentLoopResult {
  const bootstrap = toVerifierTurn(result.bootstrap, 0)
  const rounds: ConversationRound[] = []

  for (const round of result.rounds) {
    const mapped = convertRound(round)
    if (mapped) {
      rounds.push(mapped)
    }
  }

  return {
    outcome: normalizeOutcome(result.outcome),
    reason: result.reason,
    bootstrap,
    rounds
  }
}

function convertRound(round: VerifierWorkflowRound): ConversationRound | null {
  const worker = toWorkerTurn(round.steps[WORKER_ROLE], round.round)
  const verifierStep = round.steps[VERIFIER_ROLE]
  const verifier = verifierStep
    ? toVerifierTurn(verifierStep, round.round)
    : worker
      ? minimalVerifierEcho(worker, round.round)
      : null

  if (!worker || !verifier) {
    return null
  }

  return { worker, verifier }
}

function toWorkerTurn(turn: VerifierWorkflowTurn | undefined, round: number): WorkerTurn | null {
  if (!turn || turn.role !== WORKER_ROLE) return null
  return {
    round,
    raw: turn.raw,
    parsed: turn.parsed
  }
}

function toVerifierTurn(turn: VerifierWorkflowTurn | undefined, round: number): VerifierTurn {
  if (!turn || turn.role !== VERIFIER_ROLE) {
    return {
      round,
      raw: '',
      parsed: {
        verdict: 'instruct',
        critique: '',
        instructions: '',
        priority: 3
      }
    }
  }

  return {
    round,
    raw: turn.raw,
    parsed: turn.parsed
  }
}

function normalizeOutcome(outcome: string): AgentLoopResult['outcome'] {
  if (outcome === 'approved' || outcome === 'failed' || outcome === 'max-rounds') {
    return outcome
  }
  return 'failed'
}

export function minimalVerifierEcho(workerTurn: WorkerTurn, round: number): VerifierTurn {
  return {
    round,
    raw: JSON.stringify({
      verdict: 'fail',
      critique: workerTurn.parsed.requests,
      instructions: '',
      priority: 1
    }),
    parsed: {
      verdict: 'fail',
      critique: workerTurn.parsed.requests,
      instructions: '',
      priority: 1
    }
  }
}
