import type { FileDiff, Session } from '@opencode-ai/sdk'
import {
  createRunMeta,
  findLatestRoleDiff,
  findLatestRoleMessageId,
  hasRunMeta,
  loadRunMeta,
  saveRunMeta
} from '../provenance/provenance'
import { AgentRunResponse, AgentStreamCallback, invokeStructuredJsonCall } from './agent'
import { createSession, getSession, getSessionDiff } from './opencode'

export type AgentLoopOptions = {
  runID?: string
  userInstructions: string
  model?: string
  sessionDir?: string
  onStream?: AgentStreamCallback
}

const AGENT_ROLE = 'agent'

const resolveAgentSession = async (
  runId: string,
  directory: string,
  options: { createIfMissing?: boolean } = {}
): Promise<Session> => {
  const { createIfMissing = false } = options
  const metaExists = hasRunMeta(runId, directory)

  if (!metaExists) {
    if (!createIfMissing) {
      throw new Error(`Run meta not found for run: ${runId}`)
    }

    const agentSession = await createSession(directory)
    const agents = [{ role: AGENT_ROLE, sessionId: agentSession.id }]
    const runMeta = createRunMeta(directory, runId, agents)
    saveRunMeta(runMeta, runId, directory)
  }

  const metaData = loadRunMeta(runId, directory)
  const agentSessionID = metaData.agents.find((a) => a.role === AGENT_ROLE)?.sessionId
  if (!agentSessionID) {
    throw new Error('Missing agent session ID in run meta')
  }

  const agentSession = await getSession(directory, agentSessionID)
  if (!agentSession) {
    throw new Error(`Agent session not found: ${agentSessionID}`)
  }

  return agentSession
}

export async function runSingleAgentLoop(options: AgentLoopOptions): Promise<AgentRunResponse<string>> {
  const model = options.model ?? 'llama3.2'
  const directory = options.sessionDir
  if (!directory) throw new Error('sessionDir is required for runSingleAgentLoop')

  const runId = options.runID ?? `run-${Date.now()}`
  const agentSession = await resolveAgentSession(runId, directory, { createIfMissing: true })

  const result = new Promise<string>(async (resolve) => {
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

    resolve(raw)
  })

  return {
    runId,
    result
  }
}

export async function getAgentRunDiff(
  runId: string,
  directory: string,
  options: { messageId?: string } = {}
): Promise<FileDiff[]> {
  if (!directory) throw new Error('sessionDir is required for getAgentRunDiff')
  const meta = loadRunMeta(runId, directory)
  const logDiff = findLatestRoleDiff(meta, AGENT_ROLE)
  if (logDiff?.length) {
    return logDiff
  }
  const agentSession = await resolveAgentSession(runId, directory)
  const messageId = options.messageId ?? findLatestRoleMessageId(meta, AGENT_ROLE) ?? undefined
  const opencodeDiffs = await getSessionDiff(agentSession, messageId)
  if (opencodeDiffs.length > 0) {
    return opencodeDiffs
  }
  return []
}

export default runSingleAgentLoop
