import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { CodeServerSession } from './codeServerTypes'

export const createCodeServerProxyHandler = (options: {
  getSession: (sessionId: string) => CodeServerSession | null | undefined
}): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    const { sessionId } = req.params
    const session = sessionId ? options.getSession(sessionId) : null
    if (!session) {
      res.status(404).json({ error: 'Unknown code-server session' })
      return
    }
    session.proxy(req, res, next)
  }
}

export const extractCodeServerSessionIdFromUrl = (rawUrl: string | undefined): string | null => {
  if (!rawUrl) return null
  const match = rawUrl.match(/^\/code-server\/([^/?#]+)/)
  return match?.[1] ?? null
}
