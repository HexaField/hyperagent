import type { NextFunction, Request, Response } from 'express'

export const attachJsonStackMiddleware = () => {
  return (req: Request, res: Response, next: NextFunction) => {
    const originalJson = res.json.bind(res)
    ;(res as any).json = function (body: any) {
      try {
        const verbose = process.env.UI_VERBOSE_ERRORS === 'true'
        if (
          verbose &&
          body &&
          typeof body === 'object' &&
          Object.prototype.hasOwnProperty.call(body, 'error') &&
          !Object.prototype.hasOwnProperty.call(body, 'stack')
        ) {
          const stack = new Error(String(body.error)).stack
          body.stack = stack
        }
      } catch {
        // ignore
      }
      return originalJson(body)
    }
    next()
  }
}
