import type { RequestHandler } from 'express'

export type WrapAsync = (handler: RequestHandler) => RequestHandler

export type WorkspaceSessionsDeps = {
  wrapAsync: WrapAsync
}
