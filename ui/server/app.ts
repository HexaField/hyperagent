import cors from 'cors'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import express from 'express'
import fs from 'fs/promises'
import { createProxyMiddleware } from 'http-proxy-middleware'
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import { createServer, type AddressInfo, type Socket } from 'node:net'
import os from 'os'
import path from 'path'
import { runVerifierWorkerLoop, type AgentStreamEvent } from '../../src/modules/agent'
import {
  createCodeServerController,
  type CodeServerController,
  type CodeServerOptions
} from '../../src/modules/codeServer'
import type { Provider } from '../../src/modules/llm'

const DEFAULT_PORT = Number(process.env.UI_SERVER_PORT || 5556)
const CODE_SERVER_HOST = process.env.CODE_SERVER_HOST || '127.0.0.1'

export type ProxyWithUpgrade = RequestHandler & {
  upgrade?: (req: IncomingMessage, socket: Socket, head: Buffer) => void
}

export type CodeServerSession = {
  id: string
  dir: string
  basePath: string
  controller: CodeServerController
  proxy: ProxyWithUpgrade
  publicUrl: string
}

type RunLoop = typeof runVerifierWorkerLoop

type ControllerFactory = (options: CodeServerOptions) => CodeServerController

export type CreateServerOptions = {
  runLoop?: RunLoop
  controllerFactory?: ControllerFactory
  tmpDir?: string
  port?: number
  allocatePort?: () => Promise<number>
}

export type ServerInstance = {
  app: express.Express
  start: (port?: number) => HttpServer
  shutdown: () => Promise<void>
  getActiveSessionIds: () => string[]
  handleUpgrade: (req: IncomingMessage, socket: Socket, head: Buffer) => void
  handlers: {
    agentRun: RequestHandler
    codeServerProxy: RequestHandler
  }
}

export function createServerApp(options: CreateServerOptions = {}): ServerInstance {
  const runLoop = options.runLoop ?? runVerifierWorkerLoop
  const controllerFactory = options.controllerFactory ?? createCodeServerController
  const tmpDir = options.tmpDir ?? os.tmpdir()
  const defaultPort = options.port ?? DEFAULT_PORT
  const allocatePort =
    options.allocatePort ??
    (async () =>
      await new Promise<number>((resolve, reject) => {
        const server = createServer()
        server.once('error', reject)
        server.listen(0, CODE_SERVER_HOST, () => {
          const address = server.address() as AddressInfo | null
          if (!address) {
            server.close(() => reject(new Error('Unable to allocate code-server port')))
            return
          }
          const port = address.port
          server.close(() => resolve(port))
        })
      }))

  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '1mb' }))

  const activeCodeServers = new Map<string, CodeServerSession>()

  function rewriteCodeServerPath(pathName: string, sessionId: string): string {
    const prefix = `/code-server/${sessionId}`
    if (!pathName.startsWith(prefix)) return pathName
    const trimmed = pathName.slice(prefix.length)
    return trimmed.length ? trimmed : '/'
  }

  async function startCodeServerForSession(sessionId: string, sessionDir: string): Promise<CodeServerSession | null> {
    if (activeCodeServers.has(sessionId)) {
      return activeCodeServers.get(sessionId) ?? null
    }

    try {
      const port = await allocatePort()
      const basePath = `/code-server/${sessionId}`
      const controller = controllerFactory({
        host: CODE_SERVER_HOST,
        port,
        repoRoot: sessionDir,
        publicBasePath: basePath
      })
      const handle = await controller.ensure()
      if (!handle) {
        throw new Error('code-server failed to start')
      }

      const proxy = createProxyMiddleware({
        target: `http://${CODE_SERVER_HOST}:${port}`,
        changeOrigin: true,
        ws: true,
        pathRewrite: (pathName: string) => rewriteCodeServerPath(pathName, sessionId)
      }) as ProxyWithUpgrade

      const session: CodeServerSession = {
        id: sessionId,
        dir: sessionDir,
        basePath,
        controller,
        proxy,
        publicUrl: handle.publicUrl
      }
      activeCodeServers.set(sessionId, session)
      return session
    } catch (error) {
      console.warn('Unable to launch code-server session', sessionId, error)
      return null
    }
  }

  async function shutdownCodeServerSession(sessionId: string): Promise<void> {
    const session = activeCodeServers.get(sessionId)
    if (!session) return
    activeCodeServers.delete(sessionId)
    await session.controller.shutdown()
  }

  function extractSessionIdFromUrl(rawUrl: string | undefined): string | null {
    if (!rawUrl) return null
    const match = rawUrl.match(/^\/code-server\/([^/?#]+)/)
    return match?.[1] ?? null
  }

  async function shutdownAllCodeServers(): Promise<void> {
    const entries = [...activeCodeServers.keys()]
    await Promise.all(entries.map((id) => shutdownCodeServerSession(id)))
  }

  const agentRunHandler: RequestHandler = async (req: Request, res: Response) => {
    const { prompt, provider, model, maxRounds } = req.body ?? {}
    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'prompt is required' })
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    })
    res.flushHeaders?.()
    req.socket?.setKeepAlive?.(true)

    let closed = false
    let sessionId: string | null = null
    res.on('close', () => {
      closed = true
      if (sessionId) {
        void shutdownCodeServerSession(sessionId)
      }
    })

    const emit = (packet: Record<string, unknown>) => {
      if (closed) return
      res.write(`data: ${JSON.stringify(packet)}\n\n`)
      const maybeFlush = (res as Response & { flush?: () => void }).flush
      if (typeof maybeFlush === 'function') {
        maybeFlush.call(res)
      }
    }

    const sessionDir = await fs.mkdtemp(path.join(tmpDir, 'hyperagent-session-'))
    sessionId = path.basename(sessionDir)
    const codeServerSession = await startCodeServerForSession(sessionId, sessionDir)
    console.log('session ready', sessionId)
    emit({
      type: 'session',
      payload: {
        sessionDir,
        sessionId,
        codeServerUrl: codeServerSession?.publicUrl ?? null
      }
    })

    const streamHandler = (event: AgentStreamEvent) => {
      if (closed) return
      emit({ type: 'chunk', payload: event })
    }

    try {
      const providerToUse = typeof provider === 'string' && provider.length ? (provider as Provider) : undefined
      const modelToUse = typeof model === 'string' && model.length ? model : undefined
      const normalizedMaxRounds = typeof maxRounds === 'number' ? maxRounds : undefined

      console.log('running loop', sessionId)
      const result = await runLoop({
        userInstructions: prompt,
        provider: providerToUse,
        model: modelToUse,
        maxRounds: normalizedMaxRounds,
        sessionDir,
        onStream: streamHandler
      })
      console.log('runLoop completed', sessionId)
      emit({ type: 'result', payload: result })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Agent loop failed'
      if (!closed) {
        emit({
          type: 'error',
          payload: {
            message
          }
        })
      }
    } finally {
      if (!closed) {
        console.log('emitting end frame', sessionId)
        emit({ type: 'end' })
        console.log('ending response', sessionId)
        res.end()
      }
      if (sessionId) {
        await shutdownCodeServerSession(sessionId)
      }
    }
  }

  const codeServerProxyHandler: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const { sessionId } = req.params
    const session = sessionId ? activeCodeServers.get(sessionId) : null
    if (!session) {
      res.status(404).json({ error: 'Unknown code-server session' })
      return
    }
    session.proxy(req, res, next)
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true })
  })

  app.post('/api/agent/run', agentRunHandler)

  app.use('/code-server/:sessionId', codeServerProxyHandler)

  const handleUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const sessionIdFromUrl = extractSessionIdFromUrl(req.url)
    if (!sessionIdFromUrl) {
      socket.destroy()
      return
    }
    const session = activeCodeServers.get(sessionIdFromUrl)
    if (!session?.proxy.upgrade) {
      socket.destroy()
      return
    }
    session.proxy.upgrade(req, socket, head)
  }

  const start = (port = defaultPort) => {
    const server = app.listen(port, () => {
      console.log(`UI server listening on http://localhost:${port}`)
    })
    server.on('upgrade', handleUpgrade)
    return server
  }

  return {
    app,
    start,
    shutdown: shutdownAllCodeServers,
    getActiveSessionIds: () => [...activeCodeServers.keys()],
    handleUpgrade,
    handlers: {
      agentRun: agentRunHandler,
      codeServerProxy: codeServerProxyHandler
    }
  }
}
