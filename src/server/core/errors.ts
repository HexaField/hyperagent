import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { createLogger, toErrorMeta } from './logging'

const errorLogger = createLogger('ui/server/core/errors')

export const logFullError = (error: unknown, context?: { method?: string; url?: string; label?: string }) => {
  try {
    errorLogger.error(context?.label ?? 'Unhandled error', {
      ...context,
      error: toErrorMeta(error)
    })
  } catch {
    // ignore logging failures
  }
}

export const wrapAsync = (handler: RequestHandler): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = (handler as any)(req, res, next)
      if (result && typeof result.then === 'function') {
        result.catch((err: unknown) => {
          respondWithWrappedError(err, req, res)
        })
      }
    } catch (err) {
      respondWithWrappedError(err, req, res)
    }
  }
}

const respondWithWrappedError = (err: unknown, req: Request, res: Response) => {
  logFullError(err, { method: req.method, url: req.originalUrl })
  if (!res.headersSent) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    const verbose = process.env.UI_VERBOSE_ERRORS === 'true'
    if (verbose) {
      const stack = err instanceof Error ? err.stack : String(err)
      res.status(500).json({ error: message, stack })
    } else {
      res.status(500).json({ error: message })
    }
  }
}

export const installProcessErrorHandlers = () => {
  if ((globalThis as any).__hyperagent_ui_error_handlers_installed) {
    return
  }
  ;(globalThis as any).__hyperagent_ui_error_handlers_installed = true
  process.on('unhandledRejection', (reason) => {
    logFullError(reason, { label: 'unhandledRejection' })
  })
  process.on('uncaughtException', (err) => {
    logFullError(err, { label: 'uncaughtException' })
  })
}
