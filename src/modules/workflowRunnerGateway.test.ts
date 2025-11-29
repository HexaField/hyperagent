import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDockerWorkflowRunnerGateway, type WorkflowRunnerPayload } from './workflowRunnerGateway'

class MockChildProcess extends EventEmitter {
  kill = vi.fn()
}

const spawnMock = vi.fn()

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args)
}))

describe('createDockerWorkflowRunnerGateway', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  const payload: WorkflowRunnerPayload = {
    workflowId: 'wf-1',
    stepId: 'step-1',
    runnerInstanceId: 'runner-1'
  }

  it('rejects when docker spawn emits an error', async () => {
    const child = new MockChildProcess()
    spawnMock.mockReturnValue(child)
    const gateway = createDockerWorkflowRunnerGateway({ callbackBaseUrl: 'https://example.com' })
    const promise = gateway.enqueue(payload)
    child.emit('error', new Error('docker missing'))
    await expect(promise).rejects.toThrow('docker missing')
  })

  it('rejects when docker exits with a non-zero code', async () => {
    const child = new MockChildProcess()
    spawnMock.mockReturnValue(child)
    const gateway = createDockerWorkflowRunnerGateway({ callbackBaseUrl: 'https://example.com' })
    const promise = gateway.enqueue(payload)
    child.emit('close', 7)
    await expect(promise).rejects.toThrow(/exit code 7/)
    expect(spawnMock).toHaveBeenCalled()
    const args = spawnMock.mock.calls[0]?.[1] as string[]
    expect(args).toContain('--fail-with-body')
  })
})
