import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from './logging'

describe('createLogger', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-15T12:34:56.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete process.env.UI_LOG_LEVEL
  })

  it('emits structured log lines with merged metadata', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const logger = createLogger('test/module', { service: 'ui-server' })

    logger.info('server ready', { requestId: 'req-123' })

    expect(infoSpy).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(infoSpy.mock.calls[0][0]) as Record<string, unknown>
    expect(payload).toMatchObject({
      ts: '2025-01-15T12:34:56.000Z',
      level: 'info',
      module: 'test/module',
      message: 'server ready',
      meta: {
        service: 'ui-server',
        requestId: 'req-123'
      }
    })
  })

  it('respects the configured log level threshold', () => {
    process.env.UI_LOG_LEVEL = 'warn'
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logger = createLogger('test/module')

    logger.info('ignored')
    logger.warn('important warning', { code: 'worker.offline' })

    expect(infoSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(warnSpy.mock.calls[0][0]) as Record<string, unknown>
    expect(payload).toMatchObject({
      level: 'warn',
      message: 'important warning',
      meta: { code: 'worker.offline' }
    })
  })
})
