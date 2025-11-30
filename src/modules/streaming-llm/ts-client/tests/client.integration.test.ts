import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import NodeWebSocket from 'ws'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

import { listAgents, streamChat, type Agent, type ChatEvent } from '../src'

const DEFAULT_HTTP_BASE = 'http://127.0.0.1:38080'
const DEFAULT_WS_BASE = 'ws://127.0.0.1:38080/ws/chat'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const moduleRoot = path.resolve(__dirname, '..', '..')

if (typeof globalThis.WebSocket === 'undefined') {
  ;(globalThis as any).WebSocket = NodeWebSocket as unknown as typeof globalThis.WebSocket
}

let backendProcess: ChildProcess | undefined
const envBackendBase = process.env.STREAMING_LLM_TEST_BACKEND_URL
let backendHttpBase = (envBackendBase || DEFAULT_HTTP_BASE).replace(/\/$/, '')
let backendWsUrl = process.env.STREAMING_LLM_TEST_BACKEND_WS || deriveWebSocketUrl(backendHttpBase)

const maxNewTokens = Number(process.env.STREAMING_LLM_TEST_MAX_TOKENS || '32')

beforeAll(async () => {
  if (!process.env.STREAMING_LLM_TEST_BACKEND_URL) {
    backendProcess = spawn(
      process.env.STREAMING_LLM_TEST_PYTHON || 'python3',
      [
        '-m',
        'uvicorn',
        'backend.server:app',
        '--host',
        '127.0.0.1',
        '--port',
        '38080'
      ],
      {
        cwd: moduleRoot,
        env: {
          ...process.env,
          STREAMING_LLM_MODEL: process.env.STREAMING_LLM_MODEL || 'llama3.2:latest',
          STREAMING_LLM_AGENTS_DIR: path.join(moduleRoot, '.agents-test'),
          STREAMING_LLM_ENABLE: process.env.STREAMING_LLM_ENABLE || '1'
        }
      }
    )
    backendHttpBase = DEFAULT_HTTP_BASE
    backendWsUrl = DEFAULT_WS_BASE
  }

  await waitForHealth(`${backendHttpBase}/healthz`, 120_000)
})

afterAll(async () => {
  if (backendProcess) {
    backendProcess.kill('SIGTERM')
    await sleep(500)
  }
})

describe('streaming-llm TypeScript client – integration', () => {
  let agents: Agent[]

  beforeAll(async () => {
    agents = await listAgents(backendHttpBase)
    expect(Array.isArray(agents)).toBe(true)
    expect(agents.length).toBeGreaterThan(0)
  })

  it('lists seeded agents from the backend', () => {
    expect(agents.some((agent) => agent.id === 'planner')).toBe(true)
  })

  it(
    'streams tokens from the backend using a real LLM',
    async () => {
      const primary = agents[0]
      const events: ChatEvent[] = []
      const tokens: string[] = []
      const done = deferred<string | undefined>()

      const handle = await streamChat({
        backendUrl: backendWsUrl,
        agentId: primary.id,
        options: { maxNewTokens, temperature: 0 },
        onEvent: (event) => {
          events.push(event)
          if (event.type === 'token') {
            tokens.push(event.token)
          }
          if (event.type === 'error') {
            done.reject(new Error(event.message))
          }
          if (event.type === 'done') {
            done.resolve(event.conversationId)
          }
        }
      })

      handle.sendMessage({ message: 'Respond with a single concise sentence.' })
      const conversationId = await done.promise
      handle.stop()

      expect(conversationId).toBeDefined()
      expect(tokens.join('').trim().length).toBeGreaterThan(0)
      expect(events.some((event) => event.type === 'token')).toBe(true)
      expect(events.at(-1)?.type).toBe('done')
    },
    120_000
  )

  it(
    'supports multi-turn chat on a single socket',
    async () => {
      const primary = agents[0]
      const doneIds: Array<string | undefined> = []
      const errors: Error[] = []
      const tokenCounts: number[] = []
      let tokenCounter = 0
      const tokens = []

      const handle = await streamChat({
        backendUrl: backendWsUrl,
        agentId: primary.id,
        options: { maxNewTokens, temperature: 0.1 },
        onEvent: (event) => {
          if (event.type === 'token') {
            tokenCounter += 1
            tokens.push(event.token)
          }
          if (event.type === 'done') {
            doneIds.push(event.conversationId)
            tokenCounts.push(tokenCounter)
            tokenCounter = 0
          }
          if (event.type === 'error') {
            errors.push(new Error(event.message))
          }
        }
      })

      handle.sendMessage({ message: 'Give me one-sentence summary of the Hyperagent project.' })
      await waitFor(() => doneIds.length >= 1, 60_000)
      if (errors.length) {
        throw errors[0]
      }

      handle.sendMessage({ message: 'Now acknowledge that previous answer in two words.' })
      await waitFor(() => doneIds.length >= 2, 60_000)
      if (errors.length) {
        throw errors[0]
      }

      handle.stop()

      expect(doneIds[0]).toBeDefined()
      expect(doneIds[1]).toBe(doneIds[0])
      expect(tokenCounts[0]).toBeGreaterThan(0)
      expect(tokenCounts[1]).toBeGreaterThan(0)
    },
    120_000
  )

  it('throws when sending after the socket has been stopped', async () => {
    const primary = agents[0]
    const doneIds: Array<string | undefined> = []
    const handle = await streamChat({
      backendUrl: backendWsUrl,
      agentId: primary.id,
      options: { maxNewTokens, temperature: 0.2 },
      onEvent: (event) => {
        if (event.type === 'done') {
          doneIds.push(event.conversationId)
        }
      }
    })

    handle.sendMessage({ message: 'State the project name briefly.' })
    await waitFor(() => doneIds.length >= 1, 60_000)
    handle.stop()

    expect(() =>
      handle.sendMessage({ message: 'This should fail because the socket is closed.' })
    ).toThrow('Cannot send message: socket already closed')
  })
})

async function waitForHealth(url: string, timeoutMs: number) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        return
      }
    } catch {
      // ignore until timeout
    }
    await sleep(500)
  }
  throw new Error(`Timed out waiting for backend health at ${url}`)
}

function deriveWebSocketUrl(httpBase: string) {
  const cleanBase = httpBase.replace(/\/$/, '')
  const wsScheme = cleanBase.startsWith('https') ? 'wss' : 'ws'
  return cleanBase.replace(/^https?/, wsScheme) + '/ws/chat'
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate: () => boolean, timeoutMs = 60_000, intervalMs = 200) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return
    }
    await sleep(intervalMs)
  }
  throw new Error('Timed out waiting for condition in waitFor')
}
