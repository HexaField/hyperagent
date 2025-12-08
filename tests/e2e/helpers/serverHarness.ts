import fs from 'fs/promises'
import type { IPty } from 'node-pty'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import type { AddressInfo } from 'node:net'
import os from 'os'
import path from 'path'
import selfsigned from 'selfsigned'
import type WebSocketType from 'ws'
import type { WebSocketServer as WebSocketServerType } from 'ws'
import type { CodeServerController, CodeServerHandle, CodeServerOptions } from '../../../src/modules/codeServer'
import type { RadicleModule } from '../../../src/modules/radicle'
import type { LiveTerminalSession, TerminalModule, TerminalSessionRecord } from '../../../src/modules/terminal'
import { createServerApp } from '../../../src/server/app'
import type { NarratorRelay } from '../../../src/server/modules/workspaceNarrator/routes'

type ServerHarness = {
  baseUrl: string
  close: () => Promise<void>
}

type StubOptions = {
  tmpRoot?: string
  narratorRelay?: NarratorRelay
}

export async function startBackendServerHarness(options: StubOptions = {}): Promise<ServerHarness> {
  const tmpRoot = options.tmpRoot ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'narrator-e2e-server-')))
  const tlsMaterials = createSelfSignedCert()
  const persistenceFile = path.join(tmpRoot, 'runtime.db')
  const radicleWorkspace = path.join(tmpRoot, 'radicle-workspaces')
  await fs.mkdir(radicleWorkspace, { recursive: true })
  const radicleModule = createStubRadicleModule(radicleWorkspace)
  const terminalModule = createStubTerminalModule()
  const controllerFactory = createStubCodeServerController()
  const webSockets = createStubWebSockets()

  const appServer = await createServerApp({
    tmpDir: tmpRoot,
    persistenceFile,
    radicleModule,
    terminalModule,
    controllerFactory,
    tls: tlsMaterials,
    webSockets,
    narratorRelay: options.narratorRelay
  })

  const httpsServer = appServer.start(0)
  await once(httpsServer, 'listening')
  const address = httpsServer.address() as AddressInfo
  const baseUrl = `https://127.0.0.1:${address.port}`

  return {
    baseUrl,
    close: async () => {
      await appServer.shutdown()
      await new Promise<void>((resolve) => httpsServer.close(() => resolve()))
      await radicleModule.cleanup()
      await terminalModule.cleanup()
      await fs.rm(tmpRoot, { recursive: true, force: true })
    }
  }
}

function createSelfSignedCert() {
  const extensions = [
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 2, value: 'hyperagent.test' },
        { type: 7, ip: '127.0.0.1' },
        { type: 7, ip: '::1' }
      ]
    }
  ]
  const result = selfsigned.generate([{ name: 'commonName', value: 'hyperagent.test' }], {
    days: 7,
    algorithm: 'sha256',
    keySize: 2048,
    extensions
  })
  return {
    cert: Buffer.from(result.cert),
    key: Buffer.from(result.private)
  }
}

function createStubCodeServerController(): (options: CodeServerOptions) => CodeServerController {
  return (options: CodeServerOptions) => {
    const ensure = async (): Promise<CodeServerHandle> => {
      const child = {
        kill: () => {}
      } as unknown as ChildProcessWithoutNullStreams
      return {
        child,
        running: true,
        publicUrl: `${options.publicBasePath ?? '/code-server'}/?folder=${encodeURIComponent(options.repoRoot ?? '')}`
      }
    }
    const shutdown = async () => {}
    return { ensure, shutdown }
  }
}

function createStubRadicleModule(workspaceRoot: string): RadicleModule {
  return {
    createSession: async () => {
      const workspacePath = await fs.mkdtemp(path.join(workspaceRoot, 'session-'))
      return {
        start: async () => ({ workspacePath, branchName: 'main', baseBranch: 'main' }),
        getWorkspace: () => ({ workspacePath, branchName: 'main', baseBranch: 'main' }),
        commitAndPush: async () => null,
        finish: async () => null,
        abort: async () => {
          await fs.rm(workspacePath, { recursive: true, force: true })
        }
      }
    },
    inspectRepository: async (repositoryPath) => ({
      repositoryPath,
      radicleProjectId: 'rad:ztest',
      remoteUrl: 'rad://ztest',
      defaultBranch: 'main',
      registered: true
    }),
    registerRepository: async (options) => ({
      repositoryPath: options.repositoryPath,
      radicleProjectId: 'rad:ztest',
      remoteUrl: 'rad://ztest',
      defaultBranch: 'main',
      registered: true
    }),
    getStatus: async () => ({ reachable: true, loggedIn: true, identity: 'did:key:zTest', alias: 'tester' }),
    cleanup: async () => {
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  }
}

type TerminalStubSession = TerminalSessionRecord & { pty: IPty | null }

function createStubTerminalModule(): TerminalModule {
  const sessions = new Map<string, TerminalStubSession>()

  const createSession = async (userId: string) => {
    const record: TerminalStubSession = {
      id: cryptoRandomId(),
      userId,
      projectId: null,
      shellCommand: '/bin/sh',
      initialCwd: process.cwd(),
      status: 'active',
      createdAt: new Date().toISOString(),
      closedAt: null,
      pty: null
    }
    sessions.set(record.id, record)
    return record
  }

  const attachSession = async (sessionId: string, userId: string): Promise<LiveTerminalSession> => {
    const record = sessions.get(sessionId)
    if (!record || record.userId !== userId) {
      throw new Error('Session not found')
    }
    if (!record.pty) {
      record.pty = createStubPty(record)
    }
    return {
      id: record.id,
      userId: record.userId,
      record,
      pty: record.pty
    }
  }

  const closeSession = async (sessionId: string, userId: string) => {
    const record = sessions.get(sessionId)
    if (!record || record.userId !== userId) return
    record.status = 'closed'
    record.closedAt = new Date().toISOString()
    if (record.pty) {
      record.pty.kill()
      record.pty = null
    }
  }

  const listSessions = async (userId: string) => {
    return [...sessions.values()].filter((record) => record.userId === userId)
  }

  const getSession = async (sessionId: string) => {
    return sessions.get(sessionId) ?? null
  }

  const cleanup = async () => {
    for (const record of sessions.values()) {
      if (record.pty) {
        record.pty.kill()
      }
    }
    sessions.clear()
  }

  return {
    createSession,
    attachSession,
    closeSession,
    listSessions,
    getSession,
    cleanup
  }
}

function createStubPty(record: TerminalSessionRecord): IPty {
  const emitter = new EventEmitter()
  return {
    onData: (listener: (chunk: string) => void) => {
      emitter.on('data', listener)
      return { dispose: () => emitter.off('data', listener) }
    },
    onExit: (listener: (payload: { exitCode: number; signal?: number }) => void) => {
      emitter.on('exit', listener)
      return { dispose: () => emitter.off('exit', listener) }
    },
    write: () => {},
    resize: () => {},
    kill: () => {
      emitter.emit('exit', { exitCode: 0 })
    },
    cols: 80,
    rows: 24,
    pid: 0,
    process: record.shellCommand,
    get bufferSize() {
      return { cols: 80, rows: 24 }
    }
  } as unknown as IPty
}

function cryptoRandomId(): string {
  return `term-${Math.random().toString(36).slice(2, 10)}`
}

function createStubWebSockets(): { WebSocket: typeof WebSocketType; WebSocketServer: typeof WebSocketServerType } {
  class StubWebSocket extends EventEmitter {
    readyState = 1

    send() {}

    close() {
      this.readyState = 3
      this.emit('close')
    }
  }

  class StubWebSocketServer extends EventEmitter {
    readonly clients = new Set<StubWebSocket>()

    constructor() {
      super()
    }

    handleUpgrade(_request: unknown, _socket: unknown, _head: unknown, callback: (socket: StubWebSocket) => void) {
      const socket = new StubWebSocket()
      this.clients.add(socket)
      socket.once('close', () => this.clients.delete(socket))
      callback(socket)
    }

    close(callback?: () => void) {
      for (const client of this.clients) {
        client.close()
      }
      this.clients.clear()
      this.emit('close')
      callback?.()
    }
  }

  return {
    WebSocket: StubWebSocket as unknown as typeof WebSocketType,
    WebSocketServer: StubWebSocketServer as unknown as typeof WebSocketServerType
  }
}

export type { ServerHarness }
