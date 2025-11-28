import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { attachJsonStackMiddleware } from '../middleware/jsonErrorStack'

describe('json error stack middleware', () => {
  const baseReq = {} as Request
  const originalVerbose = process.env.UI_VERBOSE_ERRORS

  afterEach(() => {
    process.env.UI_VERBOSE_ERRORS = originalVerbose
    vi.restoreAllMocks()
  })

  it('attaches stack traces when UI_VERBOSE_ERRORS is true', () => {
    process.env.UI_VERBOSE_ERRORS = 'true'
    const next = vi.fn()
    const originalJson = vi.fn((body) => body)
    const res: Partial<Response> = {
      json: originalJson as any
    }

    const middleware = attachJsonStackMiddleware()
    middleware(baseReq, res as Response, next)

    const body: Record<string, unknown> = { error: 'boom' }
    ;(res as Response).json?.(body)

    expect(body.stack).toMatch(/Error: boom/)
    expect(originalJson).toHaveBeenCalledWith(body)
    expect(next).toHaveBeenCalled()
  })

  it('leaves responses untouched when verbose mode is disabled', () => {
    process.env.UI_VERBOSE_ERRORS = 'false'
    const next = vi.fn()
    const originalJson = vi.fn((body) => body)
    const res: Partial<Response> = { json: originalJson as any }
    const middleware = attachJsonStackMiddleware()
    middleware(baseReq, res as Response, next)

    const body: Record<string, unknown> = { error: 'boom' }
    ;(res as Response).json?.(body)

    expect(body).not.toHaveProperty('stack')
    expect(originalJson).toHaveBeenCalledWith(body)
    expect(next).toHaveBeenCalled()
  })
})
