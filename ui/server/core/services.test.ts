import { describe, expect, it, vi } from 'vitest'
import {
  createCodeServerService,
  createReviewSchedulerService,
  createTerminalService,
  createWorkflowRuntimeService,
  startManagedServices,
  stopManagedServices
} from './services'

describe('services lifecycle helpers', () => {
  it('starts and stops workflow runtime when lifecycle managed', async () => {
    const startWorker = vi.fn()
    const stopWorker = vi.fn().mockResolvedValue(undefined)
    const service = createWorkflowRuntimeService({
      runtime: { startWorker, stopWorker } as any,
      manageLifecycle: true
    })

    await service.start()
    await service.stop()

    expect(startWorker).toHaveBeenCalledTimes(1)
    expect(stopWorker).toHaveBeenCalledTimes(1)
  })

  it('skips workflow runtime start/stop when lifecycle is external', async () => {
    const startWorker = vi.fn()
    const stopWorker = vi.fn().mockResolvedValue(undefined)
    const service = createWorkflowRuntimeService({
      runtime: { startWorker, stopWorker } as any,
      manageLifecycle: false
    })

    await service.start()
    await service.stop()

    expect(startWorker).not.toHaveBeenCalled()
    expect(stopWorker).not.toHaveBeenCalled()
  })

  it('controls review scheduler worker', async () => {
    const startWorker = vi.fn()
    const stopWorker = vi.fn().mockResolvedValue(undefined)
    const service = createReviewSchedulerService({ startWorker, stopWorker } as any)

    await service.start()
    await service.stop()

    expect(startWorker).toHaveBeenCalledTimes(1)
    expect(stopWorker).toHaveBeenCalledTimes(1)
  })

  it('delegates to terminal module shutdown', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined)
    const service = createTerminalService({ shutdown } as any)

    await service.start()
    await service.stop()

    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('calls code-server shutdown handler', async () => {
    const shutdownAllCodeServers = vi.fn().mockResolvedValue(undefined)
    const service = createCodeServerService({ shutdownAllCodeServers })

    await service.start()
    await service.stop()

    expect(shutdownAllCodeServers).toHaveBeenCalledTimes(1)
  })

  it('starts services in order and stops in reverse order', async () => {
    const calls: string[] = []
    const services = [
      {
        name: 'first',
        start: () => {
          calls.push('start:first')
        },
        stop: () => {
          calls.push('stop:first')
        }
      },
      {
        name: 'second',
        start: () => {
          calls.push('start:second')
        },
        stop: () => {
          calls.push('stop:second')
        }
      }
    ]

    await startManagedServices(services)
    await stopManagedServices(services)

    expect(calls).toEqual(['start:first', 'start:second', 'stop:second', 'stop:first'])
  })
})
