import { Session } from '@opencode-ai/sdk'
import { createRunMeta, hasRunMeta, loadRunMeta, saveRunMeta } from '../provenance/provenance'
import { AgentStreamCallback, invokeStructuredJsonCall } from './agent'
import { createSession, getSession } from './opencode'

export type AgentLoopOptions = {
  runID?: string
  userInstructions: string
  model?: string
  sessionDir?: string
  onStream?: AgentStreamCallback
}

export async function runSingleAgentLoop(options: AgentLoopOptions): Promise<string> {
  const model = options.model ?? 'llama3.2'
  const directory = options.sessionDir
  if (!directory) throw new Error('sessionDir is required for runSingleAgentLoop')

  const runId = options.runID ?? `run-${Date.now()}`

  if (!hasRunMeta(runId, directory)) {
    const agentSession = await createSession(directory)
    const agents = [{ role: 'agent', sessionId: agentSession.id }]
    const runMeta = createRunMeta(directory, runId, agents)
    saveRunMeta(runMeta, runId, directory)
  }

  const metaData = loadRunMeta(runId, directory)
  const agentSessionID = metaData.agents.find((a) => a.role === 'agent')?.sessionId
  if (!agentSessionID) throw new Error('Missing agent session ID in run meta')

  const agentSession = await getSession(directory, agentSessionID)
  if (!agentSession) throw new Error(`Agent session not found: ${agentSessionID}`)

  const { raw } = await invokeStructuredJsonCall<string>({
    role: 'agent',
    systemPrompt: '',
    basePrompt: options.userInstructions,
    model,
    session: agentSession as Session,
    runId,
    directory,
    onStream: options.onStream
  })

  return raw
}

export default runSingleAgentLoop
