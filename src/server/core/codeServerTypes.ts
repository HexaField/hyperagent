import type { RequestHandler } from 'express'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { CodeServerController } from '../../../src/modules/codeServer'

export type ProxyWithUpgrade = RequestHandler & {
  upgrade?: (req: IncomingMessage, socket: Socket, head: Buffer) => void
}

export type CodeServerSession = {
  id: string
  dir: string
  basePath: string
  projectId: string
  branch: string
  controller: CodeServerController
  proxy: ProxyWithUpgrade
  publicUrl: string
}
