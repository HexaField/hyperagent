import type { AgentStreamEvent } from '../../../modules/agent'
import type { WorkflowAgentLogEntry, WorkflowLogEntry, WorkflowRunnerLogEntry } from '../../../interfaces/workflows/logs'

const AGENT_STREAM_PREFIX = '[agent-stream]'
const MAX_EVENTS_PER_WORKFLOW = 1000

export type RunnerStreamChunk = {
  workflowId: string
  stepId: string
  runnerInstanceId: string
  stream: 'stdout' | 'stderr'
  line: string
}

export type WorkflowLogSubscriber = (entry: WorkflowLogEntry) => void

export type WorkflowLogStream = {
  ingestRunnerChunk: (chunk: RunnerStreamChunk) => void
  getWorkflowLogs: (workflowId: string) => WorkflowLogEntry[]
  subscribe: (workflowId: string, subscriber: WorkflowLogSubscriber) => () => void
}

type AgentStreamPayload = {
  event: 'agent.stream'
  workflowId: string
  stepId: string
  runnerInstanceId?: string
  timestamp?: string
  data: AgentStreamEvent
}

export const createWorkflowLogStream = (): WorkflowLogStream => {
  const workflowEvents = new Map<string, WorkflowLogEntry[]>()
  const subscribers = new Map<string, Set<WorkflowLogSubscriber>>()
  let sequence = 0

  const nextId = () => {
    sequence += 1
    return `${Date.now()}-${sequence}`
  }

  const appendEntry = (entry: WorkflowLogEntry) => {
    const list = workflowEvents.get(entry.workflowId) ?? []
    list.push(entry)
    if (list.length > MAX_EVENTS_PER_WORKFLOW) {
      list.splice(0, list.length - MAX_EVENTS_PER_WORKFLOW)
    }
    workflowEvents.set(entry.workflowId, list)
    const listeners = subscribers.get(entry.workflowId)
    if (!listeners) return
    listeners.forEach((listener) => {
      try {
        listener(entry)
      } catch {
        // ignore subscriber errors
      }
    })
  }

  const appendRunnerLog = (chunk: RunnerStreamChunk) => {
    if (!chunk.line.trim()) {
      return
    }
    const entry: WorkflowRunnerLogEntry = {
      id: nextId(),
      workflowId: chunk.workflowId,
      stepId: chunk.stepId,
      runnerInstanceId: chunk.runnerInstanceId,
      source: 'runner',
      stream: chunk.stream,
      message: chunk.line,
      timestamp: new Date().toISOString()
    }
    appendEntry(entry)
  }

  const appendAgentLog = (payload: AgentStreamPayload) => {
    const data = payload.data
    if (!data || (data.role !== 'worker' && data.role !== 'verifier')) {
      return
    }
    const entry: WorkflowAgentLogEntry = {
      id: nextId(),
      workflowId: payload.workflowId,
      stepId: payload.stepId,
      runnerInstanceId: payload.runnerInstanceId ?? null,
      source: 'agent',
      role: data.role,
      round: data.round ?? 0,
      attempt: data.attempt ?? 0,
      provider: typeof data.provider === 'string' ? data.provider : '',
      model: typeof data.model === 'string' ? data.model : '',
      chunk: data.chunk,
      timestamp: payload.timestamp ?? new Date().toISOString(),
      sessionId: data.sessionId ?? null
    }
    appendEntry(entry)
  }

  const tryParseAgentStream = (line: string, chunk: RunnerStreamChunk): boolean => {
    if (!line.startsWith(AGENT_STREAM_PREFIX)) {
      return false
    }
    const candidate = line.slice(AGENT_STREAM_PREFIX.length).trim()
    if (!candidate) {
      return false
    }
    try {
      const payload = JSON.parse(candidate) as Partial<AgentStreamPayload>
      if (payload?.event !== 'agent.stream' || !payload.data) {
        return false
      }
      appendAgentLog({
        event: 'agent.stream',
        workflowId: payload.workflowId ?? chunk.workflowId,
        stepId: payload.stepId ?? chunk.stepId,
        runnerInstanceId: payload.runnerInstanceId ?? chunk.runnerInstanceId,
        timestamp: payload.timestamp,
        data: payload.data as AgentStreamEvent
      })
      return true
    } catch {
      return false
    }
  }

  const ingestRunnerChunk = (chunk: RunnerStreamChunk) => {
    const line = chunk.line.trimEnd()
    if (!line) return
    if (tryParseAgentStream(line, chunk)) {
      return
    }
    appendRunnerLog({ ...chunk, line })
  }

  const getWorkflowLogs = (workflowId: string): WorkflowLogEntry[] => {
    const list = workflowEvents.get(workflowId)
    if (!list) return []
    return [...list]
  }

  const subscribe = (workflowId: string, subscriber: WorkflowLogSubscriber) => {
    const listeners = subscribers.get(workflowId) ?? new Set<WorkflowLogSubscriber>()
    listeners.add(subscriber)
    subscribers.set(workflowId, listeners)
    return () => {
      const current = subscribers.get(workflowId)
      if (!current) return
      current.delete(subscriber)
      if (current.size === 0) {
        subscribers.delete(workflowId)
      }
    }
  }

  return {
    ingestRunnerChunk,
    getWorkflowLogs,
    subscribe
  }
}
