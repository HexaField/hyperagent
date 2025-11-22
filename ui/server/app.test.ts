import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Request, Response } from 'express'
import type { AgentLoopOptions, AgentLoopResult } from '../../src/modules/agent'
import type {
  CodeServerController,
  CodeServerHandle,
  CodeServerOptions
} from '../../src/modules/codeServer'
import { createServerApp } from './app'

type ControllerFactoryMock = ReturnType<typeof createControllerFactory>

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

function createControllerFactory () {
  let lastController: CodeServerController | null = null
  const factory = vi.fn<[CodeServerOptions], CodeServerController>((options) => {
    const basePath = options.publicBasePath ?? '/code-server'
    const repoRoot = options.repoRoot ?? ''
    const ensure = vi.fn(async (): Promise<CodeServerHandle> => ({
      child: {} as any,
      running: true,
      publicUrl: `${basePath}/?folder=${encodeURIComponent(repoRoot)}`
    }))
    const shutdown = vi.fn(async () => {})
    lastController = { ensure, shutdown }
    return lastController
  }) as Mock<[CodeServerOptions], CodeServerController> & {
    lastController: () => CodeServerController | null
  }
  factory.lastController = () => lastController
  return factory
}

function createMockRequest (body: any = {}, params: Record<string, string> = {}) {
  const emitter = new EventEmitter()
  const req = emitter as unknown as Request & { body: any }
  req.body = body
  req.params = params
  req.method = 'POST' as any
  req.url = '/api/agent/run'
  req.headers = {}
  return req
}

function createMockResponse () {
  const chunks: string[] = []
  let statusCode = 200
  let jsonPayload: any = null
  let ended = false
  let headers: Record<string, string> = {}

  const res = {
    writeHead: (status: number, head: Record<string, string>) => {
      statusCode = status
      headers = head
    },
    write: (chunk: string | Buffer) => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString())
    },
    end: () => {
      ended = true
    },
    status: (code: number) => {
      statusCode = code
      return res
    },
    json: (payload: any) => {
      jsonPayload = payload
      ended = true
      return res
    },
    getBody: () => chunks.join(''),
    getStatus: () => statusCode,
    getJSON: () => jsonPayload,
    isEnded: () => ended,
    getHeaders: () => headers
  }

  return res as unknown as Response & {
    getBody: () => string
    getStatus: () => number
    getJSON: () => any
    isEnded: () => boolean
    getHeaders: () => Record<string, string>
  }
}

function parseSse (body: string) {
  return body
    .split('\n\n')
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .map(entry => JSON.parse(entry.replace(/^data:\s*/, '')))
}

describe('createServerApp', () => {
  let runLoop: Mock<[AgentLoopOptions], Promise<AgentLoopResult>>
  let controllerFactory: ControllerFactoryMock

  beforeEach(() => {
    runLoop = vi.fn<[AgentLoopOptions], Promise<AgentLoopResult>>().mockResolvedValue(mockResult)
    controllerFactory = createControllerFactory()
  })

  function buildServer () {
    const server = createServerApp({
      runLoop,
      controllerFactory,
      tmpDir: '/tmp',
      allocatePort: async () => 1337
    })

    return { server }
  }

  it('streams agent results and exposes code-server url per run', async () => {
    const { server } = buildServer()

    const req = createMockRequest({
      prompt: 'Summarize repository changes',
      provider: 'anthropic',
      model: 'sonnet',
      maxRounds: 2
    })
    const res = createMockResponse()

    await server.handlers.agentRun(req, res, () => {})

    const controller = controllerFactory.lastController()
    expect(controllerFactory).toHaveBeenCalledTimes(1)
    expect(controller?.ensure).toHaveBeenCalledTimes(1)
    expect(controller?.shutdown).toHaveBeenCalledTimes(1)

    const frames = parseSse(res.getBody())
    const sessionFrame = frames[0]
    expect(sessionFrame.type).toBe('session')
    expect(sessionFrame.payload.codeServerUrl).toContain(`/code-server/${sessionFrame.payload.sessionId}`)

    expect(runLoop).toHaveBeenCalledTimes(1)
    expect(runLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        userInstructions: 'Summarize repository changes',
        provider: 'anthropic',
        model: 'sonnet',
        maxRounds: 2,
        sessionDir: expect.stringContaining('hyperagent-session-')
      })
    )

    expect(server.getActiveSessionIds()).toEqual([])
    expect(res.isEnded()).toBe(true)
  })

  it('rejects requests without a prompt', async () => {
    const { server } = buildServer()
    const req = createMockRequest({})
    const res = createMockResponse()

    await server.handlers.agentRun(req, res, () => {})

    expect(res.getStatus()).toBe(400)
    expect(res.getJSON()).toEqual({ error: 'prompt is required' })
    expect(runLoop).not.toHaveBeenCalled()
  })

  it('returns 404 for unknown code-server sessions', async () => {
    const { server } = buildServer()
    const req = createMockRequest({}, { sessionId: 'missing' })
    req.method = 'GET' as any
    req.url = '/code-server/missing'
    const res = createMockResponse()

    await server.handlers.codeServerProxy(req, res, () => {
      throw new Error('should not call next for unknown session')
    })

    expect(res.getStatus()).toBe(404)
    expect(res.getJSON()).toEqual({ error: 'Unknown code-server session' })
  })
})
