import { Router, type Request, type RequestHandler } from 'express'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type WebSocketType from 'ws'
import type { RawData, WebSocketServer as WebSocketServerType } from 'ws'
import type { LiveTerminalSession, TerminalModule } from '../../../../src/modules/terminal'

type WrapAsync = (handler: RequestHandler) => RequestHandler

export type WorkspaceTerminalModuleDeps = {
  wrapAsync: WrapAsync
  terminalModule: TerminalModule
  WebSocketCtor: typeof WebSocketType
  WebSocketServerCtor: typeof WebSocketServerType
  resolveUserIdFromRequest: (req: Request) => string
  resolveUserIdFromHeaders: (headers: IncomingMessage['headers']) => string
}

export type WorkspaceTerminalModule = {
  router: Router
  matchesUpgrade: (req: IncomingMessage) => boolean
  handleUpgrade: (req: IncomingMessage, socket: Socket, head: Buffer) => void
  shutdown: () => Promise<void>
}

export const createWorkspaceTerminalModule = (
  deps: WorkspaceTerminalModuleDeps
): WorkspaceTerminalModule => {
  const {
    wrapAsync,
    terminalModule,
    WebSocketCtor,
    WebSocketServerCtor,
    resolveUserIdFromRequest,
    resolveUserIdFromHeaders
  } = deps
  const router = Router()
  const terminalWsServer: WebSocketServerType = new WebSocketServerCtor({ noServer: true })

  const extractTerminalSessionId = (rawUrl: string | undefined): string | null => {
    if (!rawUrl) return null
    const match = rawUrl.match(/^\/ws\/terminal\/([^/?#]+)/)
    return match?.[1] ?? null
  }

  const listTerminalSessionsHandler: RequestHandler = async (req, res) => {
    try {
      const userId = resolveUserIdFromRequest(req)
      const projectFilter =
        typeof req.query.projectId === 'string' && req.query.projectId.trim().length ? req.query.projectId.trim() : null
      const sessions = await terminalModule.listSessions(userId)
      const filtered = projectFilter ? sessions.filter((session) => session.projectId === projectFilter) : sessions
      res.json({ sessions: filtered })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list terminal sessions'
      res.status(500).json({ error: message })
    }
  }

  const createTerminalSessionHandler: RequestHandler = async (req, res) => {
    const userId = resolveUserIdFromRequest(req)
    const { cwd, shell, projectId } = req.body ?? {}
    try {
      const session = await terminalModule.createSession(userId, {
        cwd: typeof cwd === 'string' && cwd.trim().length ? cwd : undefined,
        shell: typeof shell === 'string' && shell.trim().length ? shell : undefined,
        projectId: typeof projectId === 'string' && projectId.trim().length ? projectId : null
      })
      res.status(201).json({ session })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create terminal session'
      const statusCode = /too many active terminal sessions/i.test(message) ? 429 : 500
      res.status(statusCode).json({ error: message })
    }
  }

  const deleteTerminalSessionHandler: RequestHandler = async (req, res) => {
    const userId = resolveUserIdFromRequest(req)
    const sessionId = req.params.sessionId
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' })
      return
    }
    const record = await terminalModule.getSession(sessionId)
    if (!record || record.userId !== userId) {
      res.status(404).json({ error: 'Unknown terminal session' })
      return
    }
    await terminalModule.closeSession(sessionId, userId)
    res.status(204).end()
  }

  router.get('/api/terminal/sessions', wrapAsync(listTerminalSessionsHandler))
  router.post('/api/terminal/sessions', wrapAsync(createTerminalSessionHandler))
  router.delete('/api/terminal/sessions/:sessionId', wrapAsync(deleteTerminalSessionHandler))

  const sendTerminalPayload = (socket: WebSocketType, payload: Record<string, unknown>) => {
    if (socket.readyState !== WebSocketCtor.OPEN) return
    socket.send(JSON.stringify(payload))
  }

  const rawDataToString = (raw: RawData): string => {
    if (typeof raw === 'string') return raw
    if (Buffer.isBuffer(raw)) return raw.toString('utf8')
    if (Array.isArray(raw)) {
      return Buffer.concat(raw.map((item) => (Buffer.isBuffer(item) ? item : Buffer.from(item)))).toString('utf8')
    }
    return Buffer.from(raw as ArrayBuffer).toString('utf8')
  }

  const handleTerminalSocketMessage = (raw: RawData, live: LiveTerminalSession) => {
    let parsed: any
    try {
      parsed = JSON.parse(rawDataToString(raw))
    } catch {
      return
    }
    if (parsed?.type === 'input' && typeof parsed.data === 'string') {
      live.pty.write(parsed.data)
      return
    }
    if (parsed?.type === 'resize') {
      const cols = typeof parsed.cols === 'number' && parsed.cols > 0 ? parsed.cols : undefined
      const rows = typeof parsed.rows === 'number' && parsed.rows > 0 ? parsed.rows : undefined
      if (cols || rows) {
        live.pty.resize(cols ?? live.pty.cols, rows ?? live.pty.rows)
      }
      return
    }
    if (parsed?.type === 'close') {
      void terminalModule.closeSession(live.id, live.userId)
    }
  }

  terminalWsServer.on('connection', (socket: WebSocketType, request: IncomingMessage) => {
    const sessionId = extractTerminalSessionId(request.url)
    if (!sessionId) {
      socket.close(1008, 'Missing terminal session id')
      return
    }
    const userId = resolveUserIdFromHeaders(request.headers)
    try {
      console.info(
        `[WS] terminal connected session=${sessionId} from=${request.socket?.remoteAddress ?? 'unknown'} (user=${userId})`
      )
    } catch {
      // ignore logging failures
    }
    ;(async () => {
      try {
        const live = await terminalModule.attachSession(sessionId, userId)
        sendTerminalPayload(socket, { type: 'ready', sessionId: live.id })
        const disposables: Array<() => void> = []
        const dataSubscription = live.pty.onData((data) => {
          try {
            console.info(
              `[WS] terminal -> client session=${sessionId} data=${typeof data === 'string' ? data.substring(0, 200) : '[binary]'}`
            )
          } catch {
            // ignore
          }
          sendTerminalPayload(socket, { type: 'output', data })
        })
        const exitSubscription = live.pty.onExit(({ exitCode, signal }) => {
          sendTerminalPayload(socket, {
            type: 'exit',
            exitCode,
            signal: typeof signal === 'number' ? signal : null
          })
          socket.close(1000)
        })
        disposables.push(() => dataSubscription.dispose())
        disposables.push(() => exitSubscription.dispose())

        const messageHandler = (raw: RawData) => handleTerminalSocketMessage(raw, live)
        socket.on('message', messageHandler)
        const cleanup = () => {
          if (!disposables.length) return
          while (disposables.length) {
            const dispose = disposables.pop()
            try {
              dispose?.()
            } catch {
              // ignore
            }
          }
          socket.off('message', messageHandler)
        }
        socket.on('close', cleanup)
        socket.on('error', cleanup)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to attach terminal session'
        sendTerminalPayload(socket, { type: 'error', message })
        socket.close(1011, message.slice(0, 120))
      }
    })()
  })

  const matchesUpgrade = (req: IncomingMessage): boolean => Boolean(extractTerminalSessionId(req.url))

  const handleUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    terminalWsServer.handleUpgrade(req, socket, head, (ws: WebSocketType) => {
      terminalWsServer.emit('connection', ws, req)
    })
  }

  const shutdown = async () => {
    terminalWsServer.clients.forEach((client: WebSocketType) => {
      try {
        client.close()
      } catch {
        // ignore
      }
    })
    await new Promise<void>((resolve) => terminalWsServer.close(() => resolve()))
  }

  return { router, matchesUpgrade, handleUpgrade, shutdown }
}
