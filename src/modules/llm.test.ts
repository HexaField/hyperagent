import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderAdapter } from './providers'
import * as providers from './providers'

const { runProviderInvocationMock, runProviderInvocationStreamMock } = vi.hoisted(() => ({
  runProviderInvocationMock: vi.fn(async () => ({ stdout: '{"answer":"fallback","status":"ok"}' })),
  runProviderInvocationStreamMock: vi.fn<[invocation: any, opts?: any], AsyncGenerator<string, void, unknown>>(() =>
    (async function* (): AsyncGenerator<string, void, unknown> {
      return
    })()
  )
}))

vi.mock('./providerRunner', () => ({
  runProviderInvocation: runProviderInvocationMock,
  runProviderInvocationStream: runProviderInvocationStreamMock
}))

const ollamaMessagesPerCall: any[] = []
vi.mock('ollama', () => {
  return {
    default: {
      chat: vi.fn((args: any) => {
        if (args?.messages) ollamaMessagesPerCall.push(JSON.parse(JSON.stringify(args.messages)))
        async function* gen() {
          yield { message: { content: '{"hello":"world"}' } }
        }
        return gen()
      })
    }
  }
})

import * as llm from './llm'

const resetProviderMocks = () => {
  runProviderInvocationMock.mockReset()
  runProviderInvocationMock.mockResolvedValue({ stdout: '{"answer":"fallback","status":"ok"}' })
  runProviderInvocationStreamMock.mockReset()
  runProviderInvocationStreamMock.mockImplementation(() =>
    (async function* (): AsyncGenerator<string, void, unknown> {
      return
    })()
  )
}

resetProviderMocks()

afterEach(() => {
  resetProviderMocks()
  vi.clearAllMocks()
})

describe('callLLM', () => {
  it('returns JSON code-fence from ollama provider', async () => {
    const res = await llm.callLLM('system', 'user prompt')
    expect(res.success).toBe(true)
    expect(res.data).toBeDefined()
    expect(res.data).toContain('```json')
    expect(res.data).toContain('"hello"')
  })

  it('streams intermediary chunks when onStream is provided', async () => {
    const chunks: llm.LLMStreamEvent[] = []
    const res = await llm.callLLM('system', 'user prompt', 'ollama', 'llama3.2', {
      onStream: (event) => chunks.push(event)
    })
    expect(res.success).toBe(true)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0].provider).toBe('ollama')
    expect(chunks[0].chunk).toContain('"hello"')
  })

  it('uses sessionId with ollama to accumulate message history across calls', async () => {
    const sid = `sess-ollama-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    ollamaMessagesPerCall.length = 0
    const r1 = await llm.callLLM('sys', 'first', 'ollama', 'llama3.2', { sessionId: sid })
    const r2 = await llm.callLLM('sys', 'second', 'ollama', 'llama3.2', { sessionId: sid })
    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)
    expect(Array.isArray(ollamaMessagesPerCall[0])).toBe(true)
    expect(ollamaMessagesPerCall[0][0].role).toBe('system')
    expect(ollamaMessagesPerCall[0][1].role).toBe('user')
    expect(Array.isArray(ollamaMessagesPerCall[1])).toBe(true)
    expect(ollamaMessagesPerCall[1][2].role).toBe('assistant')
    expect(ollamaMessagesPerCall[1][ollamaMessagesPerCall[1].length - 1].role).toBe('user')
  })

  it('streams provider adapter output and propagates AbortSignal when buildInvocation is used', async () => {
    const adapterInvocation = { cliArgs: ['run', '--json'], command: 'opencode' }
    const adapter: ProviderAdapter = { buildInvocation: vi.fn(() => adapterInvocation), id: 'opencode', label: 'Unit' }
    const original = providers.getProviderAdapter
    const spy = vi.spyOn(providers, 'getProviderAdapter').mockImplementation((providerId) => {
      if (providerId === 'opencode') return adapter
      return original(providerId)
    })
    runProviderInvocationStreamMock.mockImplementation(() =>
      (async function* (): AsyncGenerator<string, void, unknown> {
        yield '{"answer":"adapter-stream","status":"ok"}'
      })()
    )
    const controller = new AbortController()
    const streamed: llm.LLMStreamEvent[] = []
    const res = await llm.callLLM('system', 'user', 'opencode', 'github-copilot/mock', {
      onStream: (event) => streamed.push(event),
      signal: controller.signal
    })
    expect(streamed.length).toBeGreaterThan(0)
    expect(streamed[0]?.chunk).toContain('adapter-stream')
    expect(runProviderInvocationStreamMock).toHaveBeenCalledWith(
      adapterInvocation,
      expect.objectContaining({ signal: controller.signal })
    )
    expect(adapter.buildInvocation).toHaveBeenCalled()
    expect(res.success).toBe(true)
    expect(res.data).toContain('adapter-stream')
    spy.mockRestore()
  })
})
