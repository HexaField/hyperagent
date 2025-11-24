import fs from 'fs/promises'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import { once } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { TextDecoder } from 'node:util'
import { pathToFileURL } from 'node:url'
import os from 'os'
import path from 'path'
import selfsigned from 'selfsigned'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type WebSocketType from 'ws'
import type { RawData as WsRawData } from 'ws'
import type { AgentLoopOptions, AgentLoopResult, AgentStreamEvent } from '../../src/modules/agent'
import type { CodeServerController, CodeServerHandle, CodeServerOptions } from '../../src/modules/codeServer'
import type { TerminalSessionRecord } from '../../src/modules/database'
import { createRadicleModule, type RadicleModule } from '../../src/modules/radicle'
import type { LiveTerminalSession, TerminalModule } from '../../src/modules/terminal'
import type { WorkflowRunnerGateway, WorkflowRunnerPayload } from '../../src/modules/workflowRunnerGateway'
import { createServerApp } from './app'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const loadWsClient = async (): Promise<typeof WebSocketType> => {
  const nodeRequire = eval('require') as NodeJS.Require
  const resolvedPath = nodeRequire.resolve('ws')
  const packageDir = path.dirname(resolvedPath)
  const candidatePaths = [
    path.join(packageDir, 'lib', 'websocket.js'),
    resolvedPath
  ]

  for (const candidate of candidatePaths) {
    try {
      const mod = nodeRequire(candidate)
      const WebSocket = (mod && typeof mod === 'object' && 'default' in mod ? (mod as any).default : mod) as typeof WebSocketType
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
  const server = createHttpServer((req, res) => {
    requests.push(req.url ?? '/')
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`fake-code-server${req.url ?? '/'}`)
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

async function createIntegrationHarness(options?: { radicleModule?: RadicleModule; terminalModule?: TerminalModule }) {
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'hyperagent-ui-server-tests-'))
  const dbFile = path.join(tmpBase, 'runtime.db')
  const fakeCodeServer = await startFakeCodeServer()
  const radicleWorkspaceRoot = path.join(tmpBase, 'radicle-workspaces')
  await fs.mkdir(radicleWorkspaceRoot, { recursive: true })

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
    tls: tlsMaterials
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
          const codeServerResponse = await fetch(`${harness.baseUrl}${codeServerUrl}`)
          expect(codeServerResponse.status).toBe(200)
          expect(await codeServerResponse.text()).toContain('fake-code-server')
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
    try {
      const projectResponse = await fetch(`${harness.baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Workspace Demo', repositoryPath: repoDir })
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
      await fs.rm(repoDir, { recursive: true, force: true })
    }
  })

  it('streams agent runs for existing projects without launching extra code-servers', async () => {
    const harness = await createIntegrationHarness()
    const repoDir = await createGitTestRepo()
    try {
      const projectResponse = await fetch(`${harness.baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Project Agent', repositoryPath: repoDir })
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
      expect(harness.runLoop.mock.calls[0][0].sessionDir).toBe(repoDir)
      expect(harness.controllerFactory).not.toHaveBeenCalled()
    } finally {
      await harness.close()
      await fs.rm(repoDir, { recursive: true, force: true })
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
    try {
      harness = await createIntegrationHarness({ radicleModule })
      repoDir = await createGitTestRepo()
      const registerResponse = await fetch(`${harness.baseUrl}/api/radicle/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repositoryPath: repoDir, name: 'Real Rad Repo' })
      })
      expect(registerResponse.status).toBe(200)

      const listResponse = await fetch(`${harness.baseUrl}/api/radicle/repositories`)
      expect(listResponse.status).toBe(200)
      const payload = await listResponse.json()
      const match = payload.repositories.find((entry: any) => entry.project.repositoryPath === repoDir)
      expect(match).toBeTruthy()
      expect(match.radicle?.registered).toBe(true)
      expect(match.project.id).toContain('rad-only')
    } finally {
      if (harness) {
        await harness.close()
      }
      if (repoDir) {
        await fs.rm(repoDir, { recursive: true, force: true })
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
    const harness = await createIntegrationHarness()
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
