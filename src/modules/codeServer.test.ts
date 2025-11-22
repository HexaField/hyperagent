import { EventEmitter } from 'events'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createCodeServerController } from './codeServer'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn()
}

type MockChild = MockChildProcess & {
  stdout: EventEmitter & { emit: (event: 'data', chunk: string) => boolean }
}

function createMockChild () {
  const child = new MockChildProcess() as MockChild
  spawnMock.mockImplementationOnce(() => child as any)
  return child
}

describe('createCodeServerController', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it('spawns code-server with provided options and resolves handle once ready', async () => {
    const child = createMockChild()
    const controller = createCodeServerController({
      host: '0.0.0.0',
      port: 9000,
      repoRoot: '/tmp/repo',
      binary: 'custom-code-server',
      env: { FOO: 'BAR' },
      publicBasePath: '/devtools'
    })

    const ensurePromise = controller.ensure()
    child.stdout.emit('data', 'HTTP server listening on http://localhost:9000')

    const handle = await ensurePromise
    expect(handle?.running).toBe(true)
    expect(handle?.publicUrl).toBe('/devtools/?folder=%2Ftmp%2Frepo')

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock).toHaveBeenCalledWith(
      'custom-code-server',
      [
        '--bind-addr',
        '0.0.0.0:9000',
        '--auth',
        'none',
        '--disable-update-check',
        '/tmp/repo'
      ],
      expect.objectContaining({ cwd: '/tmp/repo' })
    )
  })

  it('reuses the running process across ensure calls and restarts after shutdown', async () => {
    const firstChild = createMockChild()
    const controller = createCodeServerController({ repoRoot: '/repo' })

    const firstEnsure = controller.ensure()
    firstChild.stdout.emit('data', 'HTTP server listening')
    const firstHandle = await firstEnsure

    const secondHandle = await controller.ensure()
    expect(secondHandle).toBe(firstHandle)
    expect(spawnMock).toHaveBeenCalledTimes(1)

    await controller.shutdown()
    expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM')

    const secondChild = createMockChild()
    const thirdHandlePromise = controller.ensure()
    secondChild.stdout.emit('data', 'HTTP server listening')
    await thirdHandlePromise
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('returns null when code-server fails to start', async () => {
    const child = createMockChild()
    const controller = createCodeServerController({ repoRoot: '/repo' })

    const ensurePromise = controller.ensure()
    child.emit('error', new Error('spawn failure'))

    await expect(ensurePromise).resolves.toBeNull()
    expect(spawnMock).toHaveBeenCalledTimes(1)

    const nextChild = createMockChild()
    const retryPromise = controller.ensure()
    nextChild.stdout.emit('data', 'HTTP server listening')
    await expect(retryPromise).resolves.toMatchObject({ running: true })
  })
})
