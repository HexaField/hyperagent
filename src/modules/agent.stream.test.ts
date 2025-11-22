import { describe, expect, it, vi } from 'vitest'

const llmMocks = vi.hoisted(() => ({
  callLLM: vi.fn(async (systemPrompt: string, query: string, provider: string, model: string, opts?: any) => {
    const options = typeof opts === 'object' ? opts : undefined
    options?.onStream?.({
      chunk: `[${provider}:${model}]`,
      provider,
      model,
      attempt: 0,
      sessionId: options?.sessionId
    })

    const isVerifier = systemPrompt.includes('staff-level instructor')
    if (isVerifier) {
      const bootstrap = query.includes('The worker has not produced any output yet')
      if (bootstrap) {
        return {
          success: true,
          data: '```json{"verdict":"instruct","critique":"bootstrap","instructions":"start","priority":2}```'
        }
      }
      return {
        success: true,
        data: '```json{"verdict":"approve","critique":"done","instructions":"","priority":1}```'
      }
    }

    return {
      success: true,
      data: '```json{"status":"working","plan":"plan","work":"work","requests":""}```'
    }
  })
}))

vi.mock('./llm', () => ({
  callLLM: llmMocks.callLLM
}))

const childProcessMocks = vi.hoisted(() => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' }))
}))

vi.mock('child_process', () => ({
  spawnSync: childProcessMocks.spawnSync
}))

import { runVerifierWorkerLoop } from './agent'

describe('runVerifierWorkerLoop streaming', () => {
  it('forwards streaming events via onStream callback', async () => {
    const events: any[] = []
    const result = await runVerifierWorkerLoop({
      userInstructions: 'Ship the feature',
      provider: 'ollama',
      model: 'llama3.2',
      maxRounds: 1,
      sessionDir: '/tmp',
      onStream: (event) => events.push(event)
    })

    expect(result.outcome).toBe('approved')
    const verifierEvents = events.filter((event) => event.role === 'verifier')
    const workerEvents = events.filter((event) => event.role === 'worker')

    expect(verifierEvents.length).toBe(2) // bootstrap + approval round
    expect(workerEvents.length).toBe(1)
    expect(events.every((event) => typeof event.round === 'number')).toBe(true)
    expect(events.every((event) => typeof event.chunk === 'string' && event.chunk.length > 0)).toBe(true)
  })
})
