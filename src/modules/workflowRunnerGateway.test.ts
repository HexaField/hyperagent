import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDockerWorkflowRunnerGateway, type WorkflowRunnerPayload } from './workflowRunnerGateway'

class MockChildProcess extends EventEmitter {
  kill = vi.fn()
}

const { spawnMock, existsSyncMock, statSyncMock } = vi.hoisted(() => {
  const spawn = vi.fn()
  const exists = vi.fn(() => true)
  const stat = vi.fn(() => ({
    isDirectory: () => true
  }))
  return { spawnMock: spawn, existsSyncMock: exists, statSyncMock: stat }
})

vi.mock('node:child_process', () => ({
  spawn: spawnMock
}))

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  default: {
    existsSync: existsSyncMock,
    statSync: statSyncMock
  }
}))

describe('createDockerWorkflowRunnerGateway', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    existsSyncMock.mockReset()
    statSyncMock.mockReset()
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue({ isDirectory: () => true })
    delete process.env.WORKFLOW_RUNNER_MOUNTS
  })

  const payload: WorkflowRunnerPayload = {
    workflowId: 'wf-1',
    stepId: 'step-1',
    runnerInstanceId: 'runner-1',
    repositoryPath: '/tmp/workflow-repo',
    persistencePath: '/tmp/workflow-db/hyperagent.db'
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
    expect(args).toContain('hyperagent-workflow-runner:latest')
    expect(args).toContain('-e')
    expect(args).toContain('WORKFLOW_ID=wf-1')
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
    expect(args[0]).toBe('run')
    expect(args[1]).toBe('--rm')
    const repoMountIndex = args.indexOf('/tmp/workflow-repo:/tmp/workflow-repo')
    const dbMountIndex = args.indexOf('/tmp/workflow-db:/tmp/workflow-db')
    const caMountIndex = args.indexOf('/tmp/custom-ca.pem:/hyperagent-runner/ca.pem:ro')
    expect(repoMountIndex).toBeGreaterThan(0)
    expect(args[repoMountIndex - 1]).toBe('-v')
    expect(dbMountIndex).toBeGreaterThan(repoMountIndex)
    expect(args[dbMountIndex - 1]).toBe('-v')
    expect(caMountIndex).toBeGreaterThan(dbMountIndex)
    expect(args[caMountIndex - 1]).toBe('-v')
    expect(args).toContain('hyperagent-workflow-runner:latest')
    expect(args).toContain('NODE_EXTRA_CA_CERTS=/hyperagent-runner/ca.pem')
  })

  it('mounts additional host paths configured through WORKFLOW_RUNNER_MOUNTS', async () => {
    process.env.WORKFLOW_RUNNER_MOUNTS = JSON.stringify([
      { hostPath: '/Users/example/.opencode', readOnly: true },
      { hostPath: '/var/run/radicle', containerPath: '/rad/home' }
    ])
    const child = new MockChildProcess()
    spawnMock.mockReturnValue(child)
    const gateway = createDockerWorkflowRunnerGateway({ callbackBaseUrl: 'https://example.com' })
    const promise = gateway.enqueue(payload)
    child.emit('close', 0)
    await expect(promise).resolves.toBeUndefined()
    const args = spawnMock.mock.calls[0]?.[1] as string[]
    expect(args).toContain('/Users/example/.opencode:/Users/example/.opencode:ro')
    expect(args).toContain('/var/run/radicle:/rad/home')
  })
})
