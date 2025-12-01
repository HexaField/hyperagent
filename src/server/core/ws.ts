import { pathToFileURL } from 'node:url'
import path from 'node:path'
import type WebSocketType from 'ws'
import type { WebSocketServer as WebSocketServerType } from 'ws'

export type WebSocketBindings = {
  WebSocket: typeof WebSocketType
  WebSocketServer: typeof WebSocketServerType
}

export const loadWebSocketModule = async (): Promise<WebSocketBindings> => {
  const nodeRequire = eval('require') as NodeJS.Require
  const tryImport = async (specifier: string) => {
    const module = await import(specifier)
    const defaultExport = (module as any).default
    const candidates = [
      module.WebSocketServer,
      module.Server,
      (module as any).default?.WebSocketServer,
      (module as any).default?.Server
    ]
    const WebSocketServer = candidates.find((entry): entry is typeof WebSocketServerType => typeof entry === 'function')
    const WebSocket = (defaultExport ?? (module as unknown as typeof WebSocketType)) as typeof WebSocketType
    if (!WebSocketServer) {
      throw new Error('WebSocketServer export from ws is unavailable')
    }
    return { WebSocket, WebSocketServer }
  }

  const candidateSpecifiers: string[] = []
  try {
    const resolvedPath = nodeRequire.resolve('ws')
    candidateSpecifiers.push(pathToFileURL(resolvedPath).href)
  } catch {
    // ignore resolve failures
  }
  candidateSpecifiers.push('ws')
  candidateSpecifiers.push(pathToFileURL(path.resolve(process.cwd(), 'node_modules/ws/index.js')).href)

  for (const specifier of candidateSpecifiers) {
    try {
      return await tryImport(specifier)
    } catch {
      // try next specifier
    }
  }

  const fallback = nodeRequire('ws') as typeof WebSocketType & {
    Server?: typeof WebSocketServerType
    WebSocketServer?: typeof WebSocketServerType
  }
  const WebSocket = (fallback as any).default
    ? ((fallback as any).default as typeof WebSocketType)
    : (fallback as typeof WebSocketType)
  const WebSocketServer = (fallback.WebSocketServer ?? fallback.Server) as typeof WebSocketServerType
  if (typeof WebSocketServer !== 'function') {
    throw new Error('WebSocketServer export from ws is unavailable')
  }
  return { WebSocket, WebSocketServer }
}
