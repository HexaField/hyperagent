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

async function createIntegrationHarness () {
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'hyperagent-ui-server-tests-'))
  const dbFile = path.join(tmpBase, 'runtime.db')
  const fakeCodeServer = await startFakeCodeServer()

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

  const appServer = createServerApp({
    runLoop,
    controllerFactory,
    tmpDir: tmpBase,
    allocatePort: async () => fakeCodeServer.port,
    persistenceFile: dbFile
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
      await fakeCodeServer.close()
      await fs.rm(tmpBase, { recursive: true, force: true })
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
})
