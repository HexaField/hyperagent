import { describe, expect, it, vi } from 'vitest'
import { runProviderInvocation, runProviderInvocationStream } from './providerRunner'

describe('runProviderInvocation', () => {
  it('executes CLI invocation via opencodeCommandRunner and returns stdout', async () => {
    const mockRunner = vi.fn(async (args: string[], options?: any) => {
      return { stdout: 'ok', stderr: '' }
    })
    const res = await runProviderInvocation(
      { cliArgs: ['run', '--foo'] },
      { cwd: '/tmp', opencodeCommandRunner: mockRunner as any }
    )
    expect(mockRunner).toHaveBeenCalled()
    expect(res).toHaveProperty('stdout', 'ok')
  })

  it('performs HTTP payload invocation using fetch', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url: any, opts: any) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => 'resp'
    })) as any
    try {
      const res = await runProviderInvocation(
        { payload: { url: 'http://example.local/test', method: 'POST', body: { a: 1 } } },
        { opencodeCommandRunner: async () => ({ stdout: '', stderr: '' }) as any }
      )
      expect(res).toHaveProperty('responseText', 'resp')
      expect((globalThis.fetch as any).mock.calls.length).toBeGreaterThan(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('streams stdout chunks when the runner wrapper is provided', async () => {
    const mockRunner = vi.fn(async () => ({ stdout: 'chunk-a', stderr: '' }))
    const received: string[] = []
    for await (const part of runProviderInvocationStream(
      { cliArgs: ['run', '--json'] },
      { cwd: '/tmp', opencodeCommandRunner: mockRunner as any }
    )) {
      received.push(part)
    }
    expect(received).toEqual(['chunk-a'])
    expect(mockRunner).toHaveBeenCalled()
  })

  it('streams HTTP response chunks via fetch body reader', async () => {
    const encoder = new TextEncoder()
    let readCount = 0
    const mockReader = {
      read: vi.fn(async () => {
        if (readCount === 0) {
          readCount++
          return { done: false, value: encoder.encode('first') }
        }
        if (readCount === 1) {
          readCount++
          return { done: false, value: encoder.encode('second') }
        }
        return { done: true, value: undefined }
      })
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: { getReader: () => mockReader }
    })) as any
    try {
      const received: string[] = []
      for await (const part of runProviderInvocationStream(
        { payload: { url: 'https://example.local/stream' } },
        { opencodeCommandRunner: vi.fn() as any }
      )) {
        received.push(part)
      }
      expect(received).toEqual(['first', 'second'])
      expect(mockReader.read).toHaveBeenCalledTimes(3)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
