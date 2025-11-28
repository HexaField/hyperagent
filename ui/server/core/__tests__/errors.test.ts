import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NextFunction, Request, Response } from 'express'
import { installProcessErrorHandlers, wrapAsync } from '../errors'

const baseReq = { method: 'GET', originalUrl: '/test' } as Request
const noopNext = (() => {}) as NextFunction
const originalVerbose = process.env.UI_VERBOSE_ERRORS

const createResponse = () => {
  const json = vi.fn()
  const status = vi.fn(() => ({ json }))
  const res: Partial<Response> = {
    status: status as any,
    json: json as any,
    headersSent: false
  }
  return { res: res as Response, status, json }
}

afterEach(() => {
  process.env.UI_VERBOSE_ERRORS = originalVerbose
  vi.restoreAllMocks()
  delete (globalThis as any).__hyperagent_ui_error_handlers_installed
})

describe('wrapAsync', () => {
  it('handles synchronous errors with verbose stacks', () => {
    process.env.UI_VERBOSE_ERRORS = 'true'
    const { res, status, json } = createResponse()
    const handler = wrapAsync(() => {
      throw new Error('sync boom')
    })
    handler(baseReq, res, noopNext)
    expect(status).toHaveBeenCalledWith(500)
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'sync boom', stack: expect.any(String) }))
  })

  it('handles rejected promises when verbose errors are disabled', async () => {
    process.env.UI_VERBOSE_ERRORS = 'false'
    const { res, status, json } = createResponse()
    const handler = wrapAsync(async () => {
      throw new Error('async boom')
    })
    handler(baseReq, res, noopNext)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(status).toHaveBeenCalledWith(500)
    expect(json).toHaveBeenCalledWith({ error: 'async boom' })
  })
})

describe('installProcessErrorHandlers', () => {
  it('registers listeners only once', () => {
    const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process)
    installProcessErrorHandlers()
    installProcessErrorHandlers()
    expect(onSpy).toHaveBeenCalledTimes(2)
    expect(onSpy).toHaveBeenNthCalledWith(1, 'unhandledRejection', expect.any(Function))
    expect(onSpy).toHaveBeenNthCalledWith(2, 'uncaughtException', expect.any(Function))
    onSpy.mockRestore()
  })
})
