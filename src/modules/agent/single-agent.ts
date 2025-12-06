import type { FileDiff } from '@opencode-ai/sdk'
import { AgentRunResponse, AgentStreamCallback } from './agent'
import { getWorkflowRunDiff, runAgentWorkflow, type AgentWorkflowResult } from './agent-orchestrator'
import { singleAgentWorkflowDefinition } from './workflows'

export type AgentLoopOptions = {
  runID?: string
  userInstructions: string
  model?: string
  sessionDir?: string
  onStream?: AgentStreamCallback
}

const AGENT_ROLE = 'agent'
const getSingleAgentWorkflow = () => singleAgentWorkflowDefinition

export async function runSingleAgentLoop(options: AgentLoopOptions): Promise<AgentRunResponse<string>> {
  const model = options.model ?? 'llama3.2'
  const directory = options.sessionDir
  if (!directory) throw new Error('sessionDir is required for runSingleAgentLoop')

  const workflow = getSingleAgentWorkflow()
  const runResponse = await runAgentWorkflow(workflow, {
    runID: options.runID,
    userInstructions: options.userInstructions,
    model,
    sessionDir: directory,
    onStream: options.onStream
  })

  return {
    runId: runResponse.runId,
    result: runResponse.result.then((result) => extractSingleAgentOutput(result))
  }
}

export async function getAgentRunDiff(
  runId: string,
  directory: string,
  options: { messageId?: string } = {}
): Promise<FileDiff[]> {
  if (!directory) throw new Error('sessionDir is required for getAgentRunDiff')
  return getWorkflowRunDiff(runId, directory, { role: AGENT_ROLE, messageId: options.messageId })
}

export default runSingleAgentLoop

function extractSingleAgentOutput(result: AgentWorkflowResult): string {
  const firstRound = result.rounds[0]
  if (!firstRound) return ''
  const agentStep = firstRound.steps.agent
  if (!agentStep) return ''
  return typeof agentStep.raw === 'string' ? agentStep.raw : ''
}
