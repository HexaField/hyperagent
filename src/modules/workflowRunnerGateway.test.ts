import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDockerWorkflowRunnerGateway, type WorkflowRunnerPayload } from './workflowRunnerGateway'

class MockChildProcess extends EventEmitter {
  kill = vi.fn()
}

const spawnMock = vi.fn()
const existsSyncMock = vi.fn(() => true)

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args)
}))

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  default: {
    existsSync: (...args: unknown[]) => existsSyncMock(...args)
  }
}))

describe('createDockerWorkflowRunnerGateway', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    existsSyncMock.mockReset()
    existsSyncMock.mockReturnValue(true)
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

  it('mounts CA certificates for TLS callbacks when provided', async () => {
    const child = new MockChildProcess()
    spawnMock.mockReturnValue(child)
    const gateway = createDockerWorkflowRunnerGateway({
      callbackBaseUrl: 'https://example.com',
      caCertPath: '/tmp/custom-ca.pem'
    })
    const promise = gateway.enqueue(payload)
    child.emit('close', 0)
    await expect(promise).resolves.toBeUndefined()
    const args = spawnMock.mock.calls[0]?.[1] as string[]
    expect(args.slice(0, 5)).toEqual([
      'run',
      '--rm',
      '-v',
      '/tmp/custom-ca.pem:/hyperagent-runner/ca.pem:ro',
      'curlimages/curl:8.11.1'
    ])
    expect(args).toContain('--cacert')
    expect(args).toContain('/hyperagent-runner/ca.pem')
  })
})
