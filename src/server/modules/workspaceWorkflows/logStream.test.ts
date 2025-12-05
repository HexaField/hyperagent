import { describe, expect, it, vi } from 'vitest'
import { createWorkflowLogStream } from './logStream'

describe.skip('workflow log stream', () => {
  it('records runner log entries per workflow', () => {
    const stream = createWorkflowLogStream()
    stream.ingestRunnerChunk({
      workflowId: 'wf-1',
      stepId: 'step-1',
      runnerInstanceId: 'runner-1',
      stream: 'stdout',
      line: 'Runner started'
    })
    const entries = stream.getWorkflowLogs('wf-1')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      source: 'runner',
      message: 'Runner started',
      stream: 'stdout'
    })
  })

  it('parses agent stream payloads from runner output', () => {
    const stream = createWorkflowLogStream()
    const payload = {
      event: 'agent.stream',
      workflowId: 'wf-2',
      stepId: 'step-2',
      runnerInstanceId: 'runner-2',
      data: {
        role: 'worker',
        round: 1,
        chunk: 'LLM chunk',
        provider: 'opencode',
        model: 'gpt',
        attempt: 1
      }
    }
    stream.ingestRunnerChunk({
      workflowId: 'wf-2',
      stepId: 'step-2',
      runnerInstanceId: 'runner-2',
      stream: 'stdout',
      line: `[agent-stream] ${JSON.stringify(payload)}`
    })
    const entries = stream.getWorkflowLogs('wf-2')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      source: 'agent',
      role: 'worker',
      chunk: 'LLM chunk'
    })
  })

  it('notifies subscribers when new entries arrive', () => {
    const stream = createWorkflowLogStream()
    const spy = vi.fn()
    const unsubscribe = stream.subscribe('wf-3', spy)
    stream.ingestRunnerChunk({
      workflowId: 'wf-3',
      stepId: 'step-3',
      runnerInstanceId: 'runner-3',
      stream: 'stderr',
      line: 'Runner error'
    })
    expect(spy).toHaveBeenCalledTimes(1)
    unsubscribe()
    stream.ingestRunnerChunk({
      workflowId: 'wf-3',
      stepId: 'step-3',
      runnerInstanceId: 'runner-3',
      stream: 'stderr',
      line: 'Runner retry'
    })
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
