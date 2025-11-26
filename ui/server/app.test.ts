import fs from 'fs/promises'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { createServer as createHttpServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'
import { AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'
import { TextDecoder } from 'node:util'
import os from 'os'
import path from 'path'
import selfsigned from 'selfsigned'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type WebSocketType from 'ws'
import type { WebSocketServer as WebSocketServerType, RawData as WsRawData } from 'ws'
import type { AgentLoopOptions, AgentLoopResult, AgentStreamEvent } from '../../src/modules/agent'
import type { CodeServerController, CodeServerHandle, CodeServerOptions } from '../../src/modules/codeServer'
import type { TerminalSessionRecord } from '../../src/modules/database'
import type { OpencodeRunner } from '../../src/modules/opencodeRunner'
import {
  createOpencodeStorage,
  type OpencodeSessionDetail,
  type OpencodeSessionSummary,
  type OpencodeStorage
} from '../../src/modules/opencodeStorage'
import { createRadicleModule, type RadicleModule } from '../../src/modules/radicle'
import type { LiveTerminalSession, TerminalModule } from '../../src/modules/terminal'
import type { WorkflowRunnerGateway, WorkflowRunnerPayload } from '../../src/modules/workflowRunnerGateway'
import { createServerApp } from './app'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const loadWsClient = async (): Promise<typeof WebSocketType> => {
  const nodeRequire = eval('require') as NodeJS.Require
  const resolvedPath = nodeRequire.resolve('ws')
  const packageDir = path.dirname(resolvedPath)
  const candidatePaths = [path.join(packageDir, 'lib', 'websocket.js'), resolvedPath]

  for (const candidate of candidatePaths) {
    try {
      const mod = nodeRequire(candidate)
      const WebSocket = (
        mod && typeof mod === 'object' && 'default' in mod ? (mod as any).default : mod
      ) as typeof WebSocketType
      if (typeof WebSocket === 'function') {
        return WebSocket
      }
    } catch {
      // try next candidate
    }
  }

  const module = await import(pathToFileURL(resolvedPath).href)
  const WebSocket = (module.default ?? (module as unknown as typeof WebSocketType)) as typeof WebSocketType
  if (typeof WebSocket !== 'function') {
    throw new Error('Unable to load ws client')
  }
  return WebSocket
}

const loadWsServerBindings = async (): Promise<{
  WebSocket: typeof WebSocketType
  WebSocketServer: typeof WebSocketServerType
}> => {
  const WebSocket = await loadWsClient()
  const nodeRequire = eval('require') as NodeJS.Require
  const wsEntryPath = nodeRequire.resolve('ws')
  const wsDir = path.dirname(wsEntryPath)
  const serverModulePath = path.join(wsDir, 'lib', 'websocket-server.js')
  const serverModule = await import(pathToFileURL(serverModulePath).href)
  const WebSocketServer = (serverModule.WebSocketServer ?? serverModule.Server ?? serverModule.default) as
    | typeof WebSocketServerType
    | undefined
  if (typeof WebSocketServer !== 'function') {
    throw new Error('Unable to load ws server bindings')
  }
  return { WebSocket, WebSocketServer }
}

const mockResult: AgentLoopResult = {
  outcome: 'approved',
  reason: 'completed',
  bootstrap: {
    round: 0,
    raw: 'init',
    parsed: {
      verdict: 'approve',
      critique: '',
      instructions: '',
      priority: 1
    }
  },
  rounds: []
}

type StreamPacket = { type: string; payload?: any }

type FakeCodeServer = {
  port: number
  requests: string[]
  wsOrigins: string[]
  origin: string
  close: () => Promise<void>
}

type TestRunnerGateway = {
  gateway: WorkflowRunnerGateway
  setBaseUrl: (url: string) => Promise<void>
}

function createTestTlsMaterials() {
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
    days: 30,
    algorithm: 'sha256',
    keySize: 2048,
    extensions
  })
  return {
    cert: Buffer.from(result.cert),
    key: Buffer.from(result.private)
  }
}

function createTestWorkflowRunnerGateway(): TestRunnerGateway {
  let baseUrl: string | null = null
  const pending: WorkflowRunnerPayload[] = []

  const dispatch = async (payload: WorkflowRunnerPayload) => {
    if (!baseUrl) {
      pending.push(payload)
      return
    }
    const url = new URL(
      `/api/workflows/${encodeURIComponent(payload.workflowId)}/steps/${encodeURIComponent(payload.stepId)}/callback`,
      baseUrl
    )
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runnerInstanceId: payload.runnerInstanceId })
    })
    if (!response.ok) {
      throw new Error(`Workflow callback failed with status ${response.status}`)
    }
  }

  return {
    gateway: {
      enqueue: async (payload) => {
        await dispatch(payload)
      }
    },
    setBaseUrl: async (url: string) => {
      baseUrl = url
      while (pending.length) {
        await dispatch(pending.shift()!)
      }
    }
  }
}

async function startFakeCodeServer(): Promise<FakeCodeServer> {
  const requests: string[] = []
  const wsOrigins: string[] = []
  const server = createHttpServer((req, res) => {
    requests.push(req.url ?? '/')
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Content-Security-Policy': "default-src 'self'; frame-ancestors 'self'",
      'X-Frame-Options': 'SAMEORIGIN'
    })
    res.end(`fake-code-server${req.url ?? '/'}`)
  })
  server.on('upgrade', (req, socket, head) => {
    if (head && head.length) {
      socket.unshift(head)
    }
    const originHeader = req.headers.origin
    const normalizedOrigin = Array.isArray(originHeader)
      ? (originHeader[0] ?? '')
      : typeof originHeader === 'string'
        ? originHeader
        : ''
    wsOrigins.push(normalizedOrigin)
    const keyHeader = req.headers['sec-websocket-key']
    if (typeof keyHeader !== 'string') {
      socket.destroy()
      return
    }
    const accept = crypto
      .createHash('sha1')
      .update(keyHeader + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`
    ]
    socket.write(responseHeaders.join('\r\n') + '\r\n\r\n')
    const payload = Buffer.from('ready', 'utf8')
    const frame = Buffer.alloc(2 + payload.length)
    frame[0] = 0x81
    frame[1] = payload.length
    payload.copy(frame, 2)
    socket.write(frame)
    socket.end(Buffer.from([0x88, 0x00]))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo | null
  if (!address) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    throw new Error('Failed to start fake code-server')
  }
  let closed = false
  return {
    port: address.port,
    requests,
    wsOrigins,
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      if (closed) return
      closed = true
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    }
  }
}

async function streamSseFrames(
  response: Response,
  onFrame: (frame: StreamPacket) => Promise<void> | void
): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('Response body is not readable')
  }

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (value) {
      buffer += decoder.decode(value, { stream: true })
    }
    if (done) {
      buffer += decoder.decode()
    }

    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary).replace(/\r\n/g, '\n')
      buffer = buffer.slice(boundary + 2)
      const dataLines = chunk
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
      if (dataLines.length) {
        const payload = dataLines.join('\n')
        const frame = JSON.parse(payload) as StreamPacket
        await onFrame(frame)
      }
      boundary = buffer.indexOf('\n\n')
    }

    if (done) {
      break
    }
  }
}

async function createIntegrationHarness(options?: {
  radicleModule?: RadicleModule
  terminalModule?: TerminalModule
  publicOrigin?: string
  opencodeStorage?: OpencodeStorage
  opencodeRunner?: OpencodeRunner
  webSockets?: {
    WebSocket: typeof WebSocketType
    WebSocketServer: typeof WebSocketServerType
  }
}) {
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'hyperagent-ui-server-tests-'))
  const dbFile = path.join(tmpBase, 'runtime.db')
  const fakeCodeServer = await startFakeCodeServer()
  const radicleWorkspaceRoot = path.join(tmpBase, 'radicle-workspaces')
  await fs.mkdir(radicleWorkspaceRoot, { recursive: true })

  const resolveWebSockets = (): {
    WebSocket: typeof WebSocketType
    WebSocketServer: typeof WebSocketServerType
  } => {
    class FakeWebSocket extends EventEmitter {
      static OPEN = 1
      static CLOSED = 3
      readyState = FakeWebSocket.OPEN
      send(_data?: unknown) {}
      close(): void {
        if (this.readyState === FakeWebSocket.CLOSED) return
        this.readyState = FakeWebSocket.CLOSED
        this.emit('close')
      }
    }

    class FakeWebSocketServer extends EventEmitter {
      clients = new Set<FakeWebSocket>()
      handleUpgrade(
        _req: IncomingMessage,
        _socket: Socket,
        _head: Buffer,
        callback: (ws: WebSocketType) => void
      ): void {
        const ws = new FakeWebSocket()
        this.clients.add(ws)
        ws.on('close', () => this.clients.delete(ws))
        callback(ws as unknown as WebSocketType)
      }
      close(cb?: () => void): this {
        this.clients.forEach((client) => client.close())
        this.clients.clear()
        cb?.()
        return this
      }
    }

    return {
      WebSocket: FakeWebSocket as unknown as typeof WebSocketType,
      WebSocketServer: FakeWebSocketServer as unknown as typeof WebSocketServerType
    }
  }
  const webSockets = options?.webSockets ?? resolveWebSockets()

  const runLoop = vi.fn<[AgentLoopOptions], Promise<AgentLoopResult>>(async (options) => {
    const chunk: AgentStreamEvent = {
      role: 'worker',
      round: 1,
      chunk: 'stream-chunk',
      provider: 'ollama',
      model: 'mock-model',
      attempt: 1
    }
    options.onStream?.(chunk)
    await new Promise((resolve) => setTimeout(resolve, 10))
    return mockResult
  })

  const controllerFactory = vi.fn<[CodeServerOptions], CodeServerController>((options) => {
    expect(options.port).toBe(fakeCodeServer.port)
    const ensure = vi.fn(
      async (): Promise<CodeServerHandle> => ({
        child: { kill: vi.fn() } as any,
        running: true,
        publicUrl: `${options.publicBasePath}/?folder=${encodeURIComponent(options.repoRoot ?? '')}`
      })
    )
    const shutdown = vi.fn(async () => {})
    return { ensure, shutdown }
  }) as Mock<[CodeServerOptions], CodeServerController>

  const radicleModule = options?.radicleModule ?? createFakeRadicleModule(radicleWorkspaceRoot)
  const terminalModule = options?.terminalModule ?? createFakeTerminalModule()
  const testRunnerGateway = createTestWorkflowRunnerGateway()

  const tlsMaterials = createTestTlsMaterials()
  const appServer = await createServerApp({
    runLoop,
    controllerFactory,
    tmpDir: tmpBase,
    allocatePort: async () => fakeCodeServer.port,
    persistenceFile: dbFile,
    radicleModule,
    terminalModule,
    workflowRunnerGateway: testRunnerGateway.gateway,
    tls: tlsMaterials,
    publicOrigin: options?.publicOrigin,
    opencodeStorage: options?.opencodeStorage,
    opencodeRunner: options?.opencodeRunner,
    webSockets
  })

  const httpsServer = appServer.start(0)
  await once(httpsServer, 'listening')
  const address = httpsServer.address() as AddressInfo
  const baseUrl = `https://127.0.0.1:${address.port}`
  await testRunnerGateway.setBaseUrl(baseUrl)

  return {
    baseUrl,
    runLoop,
    controllerFactory,
    fakeCodeServer,
    close: async () => {
      await new Promise<void>((resolve) => httpsServer.close(() => resolve()))
      await appServer.shutdown()
      await radicleModule.cleanup()
      await terminalModule.cleanup()
      await fakeCodeServer.close()
      await fs.rm(tmpBase, { recursive: true, force: true })
    }
  }
}

function createFakeRadicleModule(workspaceRoot: string): RadicleModule {
  return {
    createSession: async (init) => {
      let workspace: { workspacePath: string; branchName: string; baseBranch: string } | null = null
      const start = async () => {
        if (!workspace) {
          const dir = await fs.mkdtemp(path.join(workspaceRoot, `${init.taskId}-`))
          workspace = {
            workspacePath: dir,
            branchName: init.branchInfo.name,
            baseBranch: init.branchInfo.baseBranch
          }
        }
        return workspace
      }
      const getWorkspace = () => {
        if (!workspace) throw new Error('workspace not started')
        return workspace
      }
      const cleanup = async () => {
        if (!workspace) return
        await fs.rm(workspace.workspacePath, { recursive: true, force: true })
        workspace = null
      }
      const finish = async () => {
        await cleanup()
        return null
      }
      const abort = async () => {
        await cleanup()
      }
      return {
        start,
        getWorkspace,
        commitAndPush: async () => null,
        finish,
        abort
      }
    },
    inspectRepository: async (repositoryPath) => ({
      repositoryPath,
      radicleProjectId: 'rad:zfake',
      remoteUrl: 'rad://zfake',
      defaultBranch: 'main',
      registered: true
    }),
    registerRepository: async (options) => ({
      repositoryPath: options.repositoryPath,
      radicleProjectId: 'rad:zfake',
      remoteUrl: 'rad://zfake',
      defaultBranch: 'main',
      registered: true
    }),
    getStatus: async () => ({
      reachable: true,
      loggedIn: true,
      identity: 'did:key:zFake',
      alias: 'tester'
    }),
    cleanup: async () => {}
  }
}

function createFakeTerminalModule(): TerminalModule {
  const sessions = new Map<string, TerminalSessionRecord>()
  const liveSessions = new Map<string, LiveTerminalSession>()

  const createSession = async (userId: string, options?: { cwd?: string; shell?: string }) => {
    const record: TerminalSessionRecord = {
      id: crypto.randomUUID(),
      userId,
      projectId: null,
      shellCommand: options?.shell ?? '/bin/sh',
      initialCwd: options?.cwd ?? process.cwd(),
      status: 'active',
      createdAt: new Date().toISOString(),
      closedAt: null
    }
    sessions.set(record.id, record)
    return record
  }

  const attachSession = async (sessionId: string, userId: string) => {
    const record = sessions.get(sessionId)
    if (!record) throw new Error('Session not found')
    if (record.userId !== userId) throw new Error('Unauthorized')
    const existing = liveSessions.get(sessionId)
    if (existing) return existing
    const pty = createFakePty(() => {
      record.status = 'closed'
      record.closedAt = new Date().toISOString()
      liveSessions.delete(sessionId)
    })
    const live: LiveTerminalSession = {
      id: record.id,
      userId: record.userId,
      record,
      pty: pty as unknown as LiveTerminalSession['pty']
    }
    liveSessions.set(sessionId, live)
    return live
  }

  const closeSession = async (sessionId: string, userId: string) => {
    const record = sessions.get(sessionId)
    if (!record || record.userId !== userId) return
    const live = liveSessions.get(sessionId)
    if (live) {
      liveSessions.delete(sessionId)
      live.pty.kill()
    }
    record.status = 'closed'
    record.closedAt = new Date().toISOString()
  }

  const listSessions = async (userId: string) => {
    return [...sessions.values()].filter((record) => record.userId === userId)
  }

  const getSession = async (sessionId: string) => {
    return sessions.get(sessionId) ?? null
  }

  const cleanup = async () => {
    for (const live of liveSessions.values()) {
      live.pty.kill()
    }
    liveSessions.clear()
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

function createFakePty(onExit: () => void) {
  let cols = 80
  let rows = 24
  let closed = false
  const dataListeners = new Set<(chunk: string) => void>()
  const exitListeners = new Set<(payload: { exitCode: number; signal?: number }) => void>()

  const emitData = (chunk: string) => {
    dataListeners.forEach((listener) => listener(chunk))
  }

  const emitExit = () => {
    if (closed) return
    closed = true
    exitListeners.forEach((listener) => listener({ exitCode: 0 }))
    onExit()
  }

  const fake = {
    cols,
    rows,
    onData: (listener: (chunk: string) => void) => {
      dataListeners.add(listener)
      return { dispose: () => dataListeners.delete(listener) }
    },
    onExit: (listener: (payload: { exitCode: number }) => void) => {
      exitListeners.add(listener)
      return { dispose: () => exitListeners.delete(listener) }
    },
    write: (input: string) => {
      const normalized = input.trim()
      if (normalized.startsWith('echo ')) {
        const output = normalized.slice(5)
        setTimeout(() => emitData(`${output}\n`), 5)
      } else {
        setTimeout(() => emitData(`${input}`), 5)
      }
      if (/exit/i.test(normalized)) {
        setTimeout(() => emitExit(), 10)
      }
    },
    resize: (nextCols: number, nextRows: number) => {
      if (nextCols > 0) cols = nextCols
      if (nextRows > 0) rows = nextRows
      fake.cols = cols
      fake.rows = rows
    },
    kill: () => emitExit()
  }

  return fake
}

const RAD_REAL_STUB_ID = 'ztestrid1234'

async function createGitTestRepo(branch = 'main') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyperagent-rad-real-'))
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['checkout', '-B', branch], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Hyper Test'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'hyper@test.local'], { cwd: dir, stdio: 'ignore' })
  await fs.writeFile(path.join(dir, 'README.md'), '# rad test\n')
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' })
  return dir
}

async function writeRadCliStub() {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyperagent-rad-stub-'))
  const scriptPath = path.join(binDir, 'rad')
  const script = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const cwd = process.cwd()
const marker = path.join(cwd, '.radicle')
const metadataFile = path.join(cwd, '.radicle-stub.json')
const respond = (message = '') => { process.stdout.write(message); process.exit(0) }
const fail = (message = '') => { process.stderr.write(message); process.exit(1) }
const getFlag = (flag) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}
const requireFlag = (flag) => {
  const value = getFlag(flag)
  if (!value) fail('Missing ' + flag)
  return value
}
if (!args.length) fail('Missing command')
const command = args[0]
if (command === 'init') {
  const payload = {
    name: requireFlag('--name'),
    description: (() => {
      const value = getFlag('--description')
      return value === undefined ? '' : value
    })(),
    defaultBranch: requireFlag('--default-branch'),
    visibility: args.includes('--public') ? 'public' : 'private'
  }
  fs.writeFileSync(marker, 'initialized')
  fs.writeFileSync(metadataFile, JSON.stringify(payload))
  respond('initialized')
}
if (command === 'inspect') {
  if (!fs.existsSync(marker)) fail('No Radicle project found')
  if (args.includes('--json')) {
    respond(JSON.stringify({ rid: '${RAD_REAL_STUB_ID}', urn: 'rad:${RAD_REAL_STUB_ID}' }))
  }
  respond('Radicle project info')
}
if (command === 'node' && args[1] === 'status') {
  respond('Node ok')
}
if (command === 'self') {
  if (args.includes('--json')) {
    respond(JSON.stringify({ id: '${RAD_REAL_STUB_ID}', alias: 'tester' }))
  }
  respond('tester')
}
fail('Unsupported command ' + command)
`
  await fs.writeFile(scriptPath, script, { mode: 0o755 })
  return { binDir }
}

async function setupRadStubEnv() {
  const stub = await writeRadCliStub()
  const originalPath = process.env.PATH
  process.env.PATH = `${stub.binDir}${path.delimiter}${process.env.PATH ?? ''}`
  return {
    cleanup: async () => {
      process.env.PATH = originalPath
      await fs.rm(stub.binDir, { recursive: true, force: true })
    }
  }
}

describe('createServerApp', () => {
  it('streams agent results and proxies code-server requests', { timeout: 15000 }, async () => {
    const harness = await createIntegrationHarness()
    try {
      const response = await fetch(`${harness.baseUrl}/api/agent/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Summarize repository changes',
          provider: 'anthropic',
          model: 'sonnet',
          maxRounds: 2
        })
      })

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')

      const frames: StreamPacket[] = []
      let codeServerVerified = false

      await streamSseFrames(response, async (frame) => {
        frames.push(frame)
        if (frame.type === 'session' && !codeServerVerified) {
          const codeServerUrl = frame.payload?.codeServerUrl as string | null
          expect(typeof codeServerUrl).toBe('string')
          if (!codeServerUrl) {
            throw new Error('code-server url missing in session frame')
          }
          const resolvedUrl =
            codeServerUrl.startsWith('http://') || codeServerUrl.startsWith('https://')
              ? codeServerUrl
              : `${harness.baseUrl}${codeServerUrl}`
          const codeServerResponse = await fetch(resolvedUrl)
          expect(codeServerResponse.status).toBe(200)
          expect(await codeServerResponse.text()).toContain('fake-code-server')
          expect(codeServerResponse.headers.get('x-frame-options')).toBeNull()
          codeServerVerified = true
        }
      })

      expect(codeServerVerified).toBe(true)
      expect(frames.map((frame) => frame.type)).toEqual(['session', 'chunk', 'result', 'end'])
      expect(harness.runLoop).toHaveBeenCalledTimes(1)
      expect(harness.controllerFactory).toHaveBeenCalledTimes(1)
    } finally {
      await harness.close()
    }
  })

  it('builds code-server urls using the configured public origin', async () => {
    const publicOrigin = 'https://external.hyperagent.dev:8443'
    const harness = await createIntegrationHarness({ publicOrigin })
    try {
      const response = await fetch(`${harness.baseUrl}/api/agent/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Check origin handling' })
      })
      expect(response.status).toBe(200)

      let headersVerified = false
      await streamSseFrames(response, async (frame) => {
        if (headersVerified) return
        if (frame.type === 'session' && typeof frame.payload?.codeServerUrl === 'string') {
          const absoluteUrl = frame.payload.codeServerUrl
          expect(absoluteUrl.startsWith(publicOrigin)).toBe(true)
          const resolved = new URL(absoluteUrl)
          const fallbackUrl = `${harness.baseUrl}${resolved.pathname}${resolved.search}`
          const codeServerResponse = await fetch(fallbackUrl)
          expect(codeServerResponse.headers.get('content-security-policy')).toContain(
            `frame-ancestors 'self' ${publicOrigin}`
          )
          expect(codeServerResponse.headers.get('x-frame-options')).toBeNull()
          headersVerified = true
        }
      })
      expect(headersVerified).toBe(true)
    } finally {
      await harness.close()
    }
  })

  it('rewrites websocket origins when proxying code-server sessions', { timeout: 15000 }, async () => {
    const harness = await createIntegrationHarness()
    const repoDir = await createGitTestRepo()
    const canonicalRepoDir = await fs.realpath(repoDir)
    try {
      const projectResponse = await fetch(`${harness.baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Origin Check', repositoryPath: canonicalRepoDir })
      })
      expect(projectResponse.status).toBe(201)
      const project = await projectResponse.json()

      const devspaceResponse = await fetch(`${harness.baseUrl}/api/projects/${project.id}/devspace`, {
        method: 'POST'
      })
      expect(devspaceResponse.status).toBe(200)
      const devspace = await devspaceResponse.json()

      const wsUrl = new URL(`/code-server/${devspace.sessionId}/ws`, harness.baseUrl)
      const upgradeKey = Buffer.from(`origin-check-${Date.now()}`).toString('base64')
      await new Promise<void>((resolve, reject) => {
        const requestOptions = {
          protocol: wsUrl.protocol,
          hostname: wsUrl.hostname,
          port: wsUrl.port,
          path: `${wsUrl.pathname}${wsUrl.search}`,
          method: 'GET',
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            Origin: 'https://remote.example.dev',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': upgradeKey
          },
          rejectUnauthorized: false
        }
        const req = httpsRequest(requestOptions, (res) => {
          res.resume()
          reject(new Error(`Unexpected response ${res.statusCode}`))
        })
        req.on('upgrade', (_res, socket) => {
          socket.end()
          resolve()
        })
        req.on('error', reject)
        req.setTimeout(8000, () => {
          req.destroy(new Error('WebSocket upgrade timeout'))
        })
        req.end()
      })

      const lastOrigin = harness.fakeCodeServer.wsOrigins[harness.fakeCodeServer.wsOrigins.length - 1]
      expect(lastOrigin).toBe(harness.fakeCodeServer.origin)
    } finally {
      await harness.close()
      await fs.rm(canonicalRepoDir, { recursive: true, force: true })
    }
  })

  it('rejects requests without a prompt', async () => {
    const harness = await createIntegrationHarness()
    try {
      const response = await fetch(`${harness.baseUrl}/api/agent/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'prompt is required' })
      expect(harness.runLoop).not.toHaveBeenCalled()
    } finally {
      await harness.close()
    }
  })

  it('returns 404 for unknown code-server sessions', async () => {
    const harness = await createIntegrationHarness()
    try {
      const response = await fetch(`${harness.baseUrl}/code-server/missing`)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'Unknown code-server session' })
    } finally {
      await harness.close()
    }
  })

  it('creates reusable project devspace sessions', async () => {
    const harness = await createIntegrationHarness()
    const repoDir = await createGitTestRepo()
    const canonicalRepoDir = await fs.realpath(repoDir)
    try {
      const projectResponse = await fetch(`${harness.baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Workspace Demo', repositoryPath: canonicalRepoDir })
      })
      expect(projectResponse.status).toBe(201)
      const project = await projectResponse.json()

      const devspaceResponse = await fetch(`${harness.baseUrl}/api/projects/${project.id}/devspace`, {
        method: 'POST'
      })
      expect(devspaceResponse.status).toBe(200)
      const first = await devspaceResponse.json()
      expect(first.codeServerUrl).toContain(`/code-server/${first.sessionId}`)

      const secondResponse = await fetch(`${harness.baseUrl}/api/projects/${project.id}/devspace`, {
        method: 'POST'
      })
      expect(secondResponse.status).toBe(200)
      const second = await secondResponse.json()
      expect(second.sessionId).toBe(first.sessionId)
      expect(second.codeServerUrl).toBe(first.codeServerUrl)
      expect(harness.controllerFactory).toHaveBeenCalledTimes(1)
    } finally {
      await harness.close()
      await fs.rm(canonicalRepoDir, { recursive: true, force: true })
    }
  })

  it('streams agent runs for existing projects without launching extra code-servers', async () => {
    const harness = await createIntegrationHarness()
    const repoDir = await createGitTestRepo()
    const canonicalRepoDir = await fs.realpath(repoDir)
    try {
      const projectResponse = await fetch(`${harness.baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Project Agent', repositoryPath: canonicalRepoDir })
      })
      expect(projectResponse.status).toBe(201)
      const project = await projectResponse.json()

      const devspaceResponse = await fetch(`${harness.baseUrl}/api/projects/${project.id}/devspace`, {
        method: 'POST'
      })
      expect(devspaceResponse.status).toBe(200)

      harness.controllerFactory.mockClear()

      const response = await fetch(`${harness.baseUrl}/api/agent/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Summarize the repo', projectId: project.id })
      })
      expect(response.status).toBe(200)

      const frames: StreamPacket[] = []
      await streamSseFrames(response, (frame) => {
        frames.push(frame)
      })

      const sessionFrame = frames.find((frame) => frame.type === 'session')
      expect(sessionFrame?.payload?.projectId).toBe(project.id)
      expect(sessionFrame?.payload?.codeServerUrl).toContain(`/code-server/project-${project.id}`)
      expect(harness.runLoop).toHaveBeenCalledTimes(1)
      expect(harness.runLoop.mock.calls[0][0].sessionDir).toBe(canonicalRepoDir)
      expect(harness.controllerFactory).not.toHaveBeenCalled()
    } finally {
      await harness.close()
      await fs.rm(canonicalRepoDir, { recursive: true, force: true })
    }
  })

  it('reports unstaged modifications accurately in git metadata', async () => {
    const harness = await createIntegrationHarness()
    const repoDir = await createGitTestRepo()
    const canonicalRepoDir = await fs.realpath(repoDir)
    await fs.mkdir(path.join(canonicalRepoDir, '.hyperagent'), { recursive: true })
    await fs.appendFile(path.join(canonicalRepoDir, 'README.md'), '\nlocal edit\n')
    try {
      const projectResponse = await fetch(`${harness.baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Git Accuracy', repositoryPath: canonicalRepoDir })
      })
      const projectPayload = await projectResponse.json()
      if (projectResponse.status !== 201) {
        throw new Error(`Failed to create project: ${projectResponse.status} ${JSON.stringify(projectPayload)}`)
      }
      const project = projectPayload

      const detailResponse = await fetch(`${harness.baseUrl}/api/projects/${project.id}`)
      expect(detailResponse.status).toBe(200)
      const detail = await detailResponse.json()
      const git = detail.project?.git
      expect(git).toBeTruthy()
      const readmeChange = git?.changes?.find((entry: any) => entry.path === 'README.md')
      expect(readmeChange).toBeTruthy()
      expect(readmeChange?.stagedStatus).toBe(' ')
      expect(readmeChange?.worktreeStatus).toBe('M')
    } finally {
      await harness.close()
      await fs.rm(canonicalRepoDir, { recursive: true, force: true })
    }
  })

  it('pulls and pushes remote refs via git endpoints', async () => {
    const harness = await createIntegrationHarness()
    const repoDir = await createGitTestRepo()
    const canonicalRepoDir = await fs.realpath(repoDir)
    let remoteDir: string | null = null
    let remoteCloneRoot: string | null = null
    await fs.mkdir(path.join(canonicalRepoDir, '.hyperagent'), { recursive: true })
    try {
      const remotePath = await fs.mkdtemp(path.join(os.tmpdir(), 'hyperagent-remote-'))
      remoteDir = remotePath
      execFileSync('git', ['init', '--bare'], { cwd: remotePath, stdio: 'ignore' })
      execFileSync('git', ['--git-dir', remotePath, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { stdio: 'ignore' })
      execFileSync('git', ['remote', 'add', 'origin', remotePath], { cwd: canonicalRepoDir, stdio: 'ignore' })
      execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: canonicalRepoDir, stdio: 'ignore' })

      const projectResponse = await fetch(`${harness.baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Remote Ops', repositoryPath: canonicalRepoDir })
      })
      const projectPayload = await projectResponse.json()
      if (projectResponse.status !== 201) {
        throw new Error(`Failed to create project: ${projectResponse.status} ${JSON.stringify(projectPayload)}`)
      }
      const projectId = projectPayload.id as string

      const cloneRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyperagent-remote-clone-'))
      remoteCloneRoot = cloneRoot
      const remoteCloneDir = path.join(cloneRoot, 'clone')
      execFileSync('git', ['clone', remotePath, remoteCloneDir], { stdio: 'ignore' })
      execFileSync('git', ['config', 'user.name', 'Remote Author'], { cwd: remoteCloneDir, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.email', 'remote@author.test'], { cwd: remoteCloneDir, stdio: 'ignore' })
      await fs.appendFile(path.join(remoteCloneDir, 'README.md'), '\nremote edit\n')
      execFileSync('git', ['commit', '-am', 'remote-change'], { cwd: remoteCloneDir, stdio: 'ignore' })
      execFileSync('git', ['push', 'origin', 'main'], { cwd: remoteCloneDir, stdio: 'ignore' })

      const pullResponse = await fetch(`${harness.baseUrl}/api/projects/${projectId}/git/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remote: 'origin', branch: 'main' })
      })
      expect(pullResponse.status).toBe(200)
      const pullPayload = await pullResponse.json()
      expect(pullPayload.git?.branch).toBe('main')
      const readmeAfterPull = await fs.readFile(path.join(canonicalRepoDir, 'README.md'), 'utf8')
      expect(readmeAfterPull.includes('remote edit')).toBe(true)

      await fs.writeFile(path.join(canonicalRepoDir, 'LOCAL.txt'), 'local change\n')
      execFileSync('git', ['add', 'LOCAL.txt'], { cwd: canonicalRepoDir, stdio: 'ignore' })
      execFileSync('git', ['commit', '-m', 'local-change'], { cwd: canonicalRepoDir, stdio: 'ignore' })

      const pushResponse = await fetch(`${harness.baseUrl}/api/projects/${projectId}/git/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remote: 'origin', branch: 'main' })
      })
      expect(pushResponse.status).toBe(200)
      const remoteHeadMessage = execFileSync('git', ['--git-dir', remotePath, 'log', '-1', '--pretty=%s'])
        .toString()
        .trim()
      expect(remoteHeadMessage).toBe('local-change')
    } finally {
      await harness.close()
      await fs.rm(canonicalRepoDir, { recursive: true, force: true })
      if (remoteDir) {
        await fs.rm(remoteDir, { recursive: true, force: true })
      }
      if (remoteCloneRoot) {
        await fs.rm(remoteCloneRoot, { recursive: true, force: true })
      }
    }
  })

  it('initializes workspace directories and git repositories for new projects', async () => {
    const harness = await createIntegrationHarness()
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyperagent-new-workspace-'))
    const repoPath = path.join(workspaceRoot, 'fresh-project')
    try {
      const projectResponse = await fetch(`${harness.baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Fresh Project', repositoryPath: repoPath, defaultBranch: 'trunk' })
      })
      expect(projectResponse.status).toBe(201)
      const stats = await fs.stat(repoPath)
      expect(stats.isDirectory()).toBe(true)
      await fs.access(path.join(repoPath, '.git'))
      const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repoPath }).toString().trim()
      expect(branch).toBe('trunk')
    } finally {
      await harness.close()
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('manages projects and workflows via REST APIs', { timeout: 15000 }, async () => {
    const harness = await createIntegrationHarness()
    try {
      const projectResponse = await fetch(`${harness.baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Demo', repositoryPath: '/tmp/demo' })
      })
      expect(projectResponse.status).toBe(201)
      const project = await projectResponse.json()
      expect(project).toHaveProperty('id')

      const workflowResponse = await fetch(`${harness.baseUrl}/api/workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          kind: 'demo',
          tasks: [{ id: 'task-1', title: 'Demo task', instructions: 'Do demo things' }],
          autoStart: true
        })
      })
      expect(workflowResponse.status).toBe(201)
      const workflowDetail = await workflowResponse.json()
      const workflowId = workflowDetail.workflow?.id as string | undefined
      expect(typeof workflowId).toBe('string')
      if (!workflowId) {
        throw new Error('workflow id missing in response')
      }

      let finalStatus = ''
      const maxAttempts = 60
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const detailRes = await fetch(`${harness.baseUrl}/api/workflows/${workflowId}`)
        expect(detailRes.status).toBe(200)
        const detail = await detailRes.json()
        finalStatus = detail.workflow.status
        if (finalStatus === 'completed') {
          expect(detail.steps.every((step: any) => step.status === 'completed')).toBe(true)
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      expect(finalStatus).toBe('completed')

      const listResponse = await fetch(`${harness.baseUrl}/api/workflows?projectId=${encodeURIComponent(project.id)}`)
      expect(listResponse.status).toBe(200)
      const listPayload = await listResponse.json()
      expect(listPayload.workflows.length).toBeGreaterThan(0)
    } finally {
      await harness.close()
    }
  })

  it('exposes repository graph and workflow diff endpoints', async () => {
    const harness = await createIntegrationHarness()
    try {
      const projectResponse = await fetch(`${harness.baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Graph Demo', repositoryPath: '/tmp/graph-demo' })
      })
      expect(projectResponse.status).toBe(201)
      const project = await projectResponse.json()
      const graphRes = await fetch(`${harness.baseUrl}/api/projects/${project.id}/graph`)
      expect(graphRes.status).toBe(200)
      const graphPayload = await graphRes.json()
      expect(graphPayload.project.id).toBe(project.id)
      expect(Array.isArray(graphPayload.branches)).toBe(true)

      const workflowResponse = await fetch(`${harness.baseUrl}/api/workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          kind: 'graph-test',
          tasks: [{ id: 'task-1', title: 'Branch update', instructions: 'touch files' }],
          autoStart: true
        })
      })
      expect(workflowResponse.status).toBe(201)
      const workflowDetail = await workflowResponse.json()
      const workflowId = workflowDetail.workflow?.id as string
      expect(typeof workflowId).toBe('string')
      const detailResponse = await fetch(`${harness.baseUrl}/api/workflows/${workflowId}`)
      expect(detailResponse.status).toBe(200)
      const detail = await detailResponse.json()
      const firstStep = detail.steps[0]
      expect(firstStep).toBeTruthy()
      const diffResponse = await fetch(`${harness.baseUrl}/api/workflows/${workflowId}/steps/${firstStep.id}/diff`)
      expect(diffResponse.status).toBe(404)
      const diffPayload = await diffResponse.json()
      expect(diffPayload).toHaveProperty('error')
    } finally {
      await harness.close()
    }
  })

  it('reports Radicle status and repository registrations', async () => {
    const harness = await createIntegrationHarness()
    try {
      const statusResponse = await fetch(`${harness.baseUrl}/api/radicle/status`)
      expect(statusResponse.status).toBe(200)
      const statusPayload = await statusResponse.json()
      expect(statusPayload.status.reachable).toBe(true)
      expect(statusPayload.status.loggedIn).toBe(true)

      const projectResponse = await fetch(`${harness.baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Rad Repo', repositoryPath: '/tmp/rad' })
      })
      expect(projectResponse.status).toBe(201)

      const repoResponse = await fetch(`${harness.baseUrl}/api/radicle/repositories`)
      expect(repoResponse.status).toBe(200)
      const repoPayload = await repoResponse.json()
      expect(repoPayload.repositories.length).toBeGreaterThan(0)
      const firstRepo = repoPayload.repositories[0]
      expect(firstRepo.radicle).not.toBeNull()
      expect(firstRepo.radicle.registered).toBe(true)
    } finally {
      await harness.close()
    }
  })

  it('surfaces Radicle registrations without persisted projects using the real Radicle module', async () => {
    const env = await setupRadStubEnv()
    const radicleModule = createRadicleModule({ defaultRemote: 'origin' })
    let harness: Awaited<ReturnType<typeof createIntegrationHarness>> | null = null
    let repoDir: string | null = null
    let canonicalRepoDir: string | null = null
    try {
      harness = await createIntegrationHarness({ radicleModule })
      repoDir = await createGitTestRepo()
      canonicalRepoDir = await fs.realpath(repoDir)
      const registerResponse = await fetch(`${harness.baseUrl}/api/radicle/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repositoryPath: canonicalRepoDir, name: 'Real Rad Repo' })
      })
      expect(registerResponse.status).toBe(200)

      const listResponse = await fetch(`${harness.baseUrl}/api/radicle/repositories`)
      expect(listResponse.status).toBe(200)
      const payload = await listResponse.json()
      const match = payload.repositories.find((entry: any) => entry.project.repositoryPath === canonicalRepoDir)
      expect(match).toBeTruthy()
      expect(match.radicle?.registered).toBe(true)
      expect(match.project.id).toContain('rad-only')
    } finally {
      if (harness) {
        await harness.close()
      }
      if (canonicalRepoDir) {
        await fs.rm(canonicalRepoDir, { recursive: true, force: true })
      }
      await env.cleanup()
    }
  })

  it('lists Radicle registrations even without persisted projects', async () => {
    const harness = await createIntegrationHarness()
    try {
      const registerResponse = await fetch(`${harness.baseUrl}/api/radicle/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repositoryPath: '/tmp/rad-solo', name: 'Solo Rad Repo' })
      })
      expect(registerResponse.status).toBe(200)

      const repoResponse = await fetch(`${harness.baseUrl}/api/radicle/repositories`)
      expect(repoResponse.status).toBe(200)
      const repoPayload = await repoResponse.json()
      const match = repoPayload.repositories.find(
        (entry: any) => entry.project.repositoryPath === path.resolve('/tmp/rad-solo')
      )
      expect(match).toBeTruthy()
      expect(match.radicle).not.toBeNull()
      expect(match.project.id).toContain('rad-only')
    } finally {
      await harness.close()
    }
  })

  it('creates terminal sessions and streams output via websocket', { timeout: 20000 }, async () => {
    const webSockets = await loadWsServerBindings()
    const harness = await createIntegrationHarness({ webSockets })
    try {
      const initialList = await fetch(`${harness.baseUrl}/api/terminal/sessions`)
      expect(initialList.status).toBe(200)
      const initialPayload = await initialList.json()
      expect(initialPayload.sessions).toBeInstanceOf(Array)

      const createResponse = await fetch(`${harness.baseUrl}/api/terminal/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: process.cwd() })
      })
      expect(createResponse.status).toBe(201)
      const { session } = await createResponse.json()
      expect(session.status).toBe('active')

      const wsUrl = new URL(`/ws/terminal/${session.id}`, harness.baseUrl)
      wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
      const WebSocket = await loadWsClient()
      const socket = new WebSocket(wsUrl)
      const marker = '__hyper_terminal__'
      let outputBuffer = ''
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Timed out waiting for terminal output')), 12000)

          const handleMessage = (data: WsRawData) => {
            try {
              const payload = JSON.parse(data.toString())
              if (payload.type === 'ready') {
                socket.send(JSON.stringify({ type: 'input', data: `echo ${marker}\n` }))
                socket.send(JSON.stringify({ type: 'input', data: 'exit\n' }))
              }
              if (payload.type === 'output' && typeof payload.data === 'string') {
                outputBuffer += payload.data
              }
              if (payload.type === 'exit') {
                clearTimeout(timer)
                resolve()
              }
              if (payload.type === 'error') {
                clearTimeout(timer)
                reject(new Error(payload.message ?? 'Terminal error'))
              }
            } catch (error) {
              clearTimeout(timer)
              reject(error instanceof Error ? error : new Error('Malformed terminal payload'))
            }
          }

          socket.on('message', handleMessage)
          socket.once('error', (error) => {
            clearTimeout(timer)
            reject(error instanceof Error ? error : new Error('Terminal socket error'))
          })
          socket.once('close', () => {
            clearTimeout(timer)
          })
        })
      } finally {
        socket.close()
      }

      expect(outputBuffer).toContain(marker)

      const deleteResponse = await fetch(`${harness.baseUrl}/api/terminal/sessions/${session.id}`, {
        method: 'DELETE'
      })
      expect(deleteResponse.status).toBe(204)

      const finalList = await fetch(`${harness.baseUrl}/api/terminal/sessions`)
      expect(finalList.status).toBe(200)
      const finalPayload = await finalList.json()
      const saved = finalPayload.sessions.find((entry: any) => entry.id === session.id)
      expect(saved).toBeTruthy()
      expect(saved.status).toBe('closed')
    } finally {
      await harness.close()
    }
  })
})

describe('opencode session endpoints', () => {
  const fixtureRoot = path.join(process.cwd(), 'tests/fixtures/opencode-storage')

  it('exposes persisted opencode sessions across server restarts', async () => {
    const runnerStub = createFakeOpencodeRunnerStub()
    const harnessA = await createIntegrationHarness({
      opencodeStorage: createOpencodeStorage({ rootDir: fixtureRoot }),
      opencodeRunner: runnerStub
    })
    const resA = await fetch(`${harnessA.baseUrl}/api/opencode/sessions`)
    expect(resA.status).toBe(200)
    const payloadA = (await resA.json()) as { sessions: OpencodeSessionSummary[] }
    expect(payloadA.sessions.length).toBeGreaterThanOrEqual(2)
    await harnessA.close()

    const harnessB = await createIntegrationHarness({
      opencodeStorage: createOpencodeStorage({ rootDir: fixtureRoot }),
      opencodeRunner: runnerStub
    })
    const resB = await fetch(`${harnessB.baseUrl}/api/opencode/sessions`)
    expect(resB.status).toBe(200)
    const payloadB = (await resB.json()) as { sessions: OpencodeSessionSummary[] }
    expect(payloadB.sessions.length).toBe(payloadA.sessions.length)
    await harnessB.close()
  })

  it('proxies runner lifecycle operations and session detail lookups', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyperagent-opencode-workspace-'))
    const workspacePath = path.join(workspaceRoot, 'repo-alpha')
    await fs.mkdir(workspacePath, { recursive: true })

    const summary: OpencodeSessionSummary = {
      id: 'ses_alpha',
      title: 'Alpha Session',
      workspacePath,
      projectId: 'hash-alpha',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      summary: { additions: 1, deletions: 0, files: 1 }
    }
    const detail: OpencodeSessionDetail = {
      session: summary,
      messages: []
    }
    const storageStub = createFakeOpencodeStorageStub(detail)
    const runnerStub = createFakeOpencodeRunnerStub()
    const harness = await createIntegrationHarness({ opencodeStorage: storageStub, opencodeRunner: runnerStub })

    try {
      const startRes = await fetch(`${harness.baseUrl}/api/opencode/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath: summary.workspacePath, prompt: 'Ship it' })
      })
      expect(startRes.status).toBe(202)
      expect(runnerStub.startRun).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: summary.workspacePath, prompt: 'Ship it' })
      )

      const detailRes = await fetch(`${harness.baseUrl}/api/opencode/sessions/${summary.id}`)
      expect(detailRes.status).toBe(200)
      const detailPayload = (await detailRes.json()) as OpencodeSessionDetail
      expect(detailPayload.session.id).toBe(summary.id)

      const runsRes = await fetch(`${harness.baseUrl}/api/opencode/runs`)
      expect(runsRes.status).toBe(200)
      const runsPayload = (await runsRes.json()) as { runs: unknown[] }
      expect(Array.isArray(runsPayload.runs)).toBe(true)

      const killRes = await fetch(`${harness.baseUrl}/api/opencode/sessions/${summary.id}/kill`, { method: 'POST' })
      expect(killRes.status).toBe(200)
      expect(runnerStub.killRun).toHaveBeenCalledWith(summary.id)
    } finally {
      await harness.close()
      await fs.rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})

function createFakeOpencodeRunnerStub(): OpencodeRunner {
  const record = {
    sessionId: 'ses_alpha',
    pid: 1234,
    workspacePath: '/workspace/repo-alpha',
    prompt: 'Ship it',
    title: 'Alpha Session',
    model: null,
    logFile: '/tmp/log',
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    status: 'running' as const,
    exitCode: null,
    signal: null
  }
  return {
    startRun: vi.fn(async () => record),
    listRuns: vi.fn(async () => [record]),
    getRun: vi.fn(async () => record),
    killRun: vi.fn(async () => true)
  }
}

function createFakeOpencodeStorageStub(detail: OpencodeSessionDetail): OpencodeStorage {
  return {
    rootDir: '/tmp/opencode',
    listSessions: vi.fn(async () => [detail.session]),
    getSession: vi.fn(async (sessionId) => (sessionId === detail.session.id ? detail : null))
  }
}
