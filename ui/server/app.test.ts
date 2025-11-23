import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { TextDecoder } from 'node:util'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentLoopOptions, AgentLoopResult, AgentStreamEvent } from '../../src/modules/agent'
import type {
  CodeServerController,
  CodeServerHandle,
  CodeServerOptions
} from '../../src/modules/codeServer'
import { createServerApp } from './app'
import { createRadicleModule, type RadicleModule } from '../../src/modules/radicle'

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

async function startFakeCodeServer (): Promise<FakeCodeServer> {
  const requests: string[] = []
  const server = createHttpServer((req, res) => {
    requests.push(req.url ?? '/')
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`fake-code-server${req.url ?? '/'}`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo | null
  if (!address) {
    await new Promise<void>((resolve, reject) =>
      server.close(err => (err ? reject(err) : resolve()))
    )
    throw new Error('Failed to start fake code-server')
  }
  let closed = false
  return {
    port: address.port,
    requests,
    close: async () => {
      if (closed) return
      closed = true
      await new Promise<void>((resolve, reject) =>
        server.close(err => (err ? reject(err) : resolve()))
      )
    }
  }
}

async function streamSseFrames (
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
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
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

async function createIntegrationHarness (options?: { radicleModule?: RadicleModule }) {
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
    await new Promise(resolve => setTimeout(resolve, 10))
    return mockResult
  })

  const controllerFactory = vi.fn<[CodeServerOptions], CodeServerController>((options) => {
    expect(options.port).toBe(fakeCodeServer.port)
    const ensure = vi.fn(async (): Promise<CodeServerHandle> => ({
      child: { kill: vi.fn() } as any,
      running: true,
      publicUrl: `${options.publicBasePath}/?folder=${encodeURIComponent(options.repoRoot ?? '')}`
    }))
    const shutdown = vi.fn(async () => {})
    return { ensure, shutdown }
  }) as Mock<[CodeServerOptions], CodeServerController>

  const radicleModule = options?.radicleModule ?? createFakeRadicleModule(radicleWorkspaceRoot)

  const appServer = createServerApp({
    runLoop,
    controllerFactory,
    tmpDir: tmpBase,
    allocatePort: async () => fakeCodeServer.port,
    persistenceFile: dbFile,
    radicleModule
  })

  const httpServer = appServer.start(0)
  await once(httpServer, 'listening')
  const address = httpServer.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`

  return {
    baseUrl,
    runLoop,
    controllerFactory,
    fakeCodeServer,
    close: async () => {
      await new Promise<void>(resolve => httpServer.close(() => resolve()))
      await appServer.shutdown()
      await radicleModule.cleanup()
      await fakeCodeServer.close()
      await fs.rm(tmpBase, { recursive: true, force: true })
    }
  }
}

function createFakeRadicleModule (workspaceRoot: string): RadicleModule {
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

const RAD_REAL_STUB_ID = 'ztestrid1234'

async function createGitTestRepo (branch = 'main') {
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

async function writeRadCliStub () {
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

async function setupRadStubEnv () {
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
      expect(frames.map(frame => frame.type)).toEqual(['session', 'chunk', 'result', 'end'])
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

  it('manages projects and workflows via REST APIs', async () => {
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
      for (let attempt = 0; attempt < 15; attempt++) {
        const detailRes = await fetch(`${harness.baseUrl}/api/workflows/${workflowId}`)
        expect(detailRes.status).toBe(200)
        const detail = await detailRes.json()
        finalStatus = detail.workflow.status
        if (finalStatus === 'completed') {
          expect(detail.steps.every((step: any) => step.status === 'completed')).toBe(true)
          break
        }
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      expect(finalStatus).toBe('completed')

      const listResponse = await fetch(
        `${harness.baseUrl}/api/workflows?projectId=${encodeURIComponent(project.id)}`
      )
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
      const diffResponse = await fetch(
        `${harness.baseUrl}/api/workflows/${workflowId}/steps/${firstStep.id}/diff`
      )
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
      const match = repoPayload.repositories.find((entry: any) => entry.project.repositoryPath === path.resolve('/tmp/rad-solo'))
      expect(match).toBeTruthy()
      expect(match.radicle).not.toBeNull()
      expect(match.project.id).toContain('rad-only')
    } finally {
      await harness.close()
    }
  })
})
