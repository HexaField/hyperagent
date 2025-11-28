import { describe, expect, it } from 'vitest'
import { getProviderAdapter } from './index'

describe('opencode provider adapter', () => {
  const adapter = getProviderAdapter('opencode')
  if (!adapter || !adapter.buildInvocation) {
    throw new Error('opencode adapter is not registered')
  }

  it('places the prompt before CLI flags', () => {
    const invocation = adapter.buildInvocation!({
      sessionId: 'ses_unit',
      modelId: 'github-copilot/gpt-5-mini',
      text: 'Continue the plan'
    })
    expect(invocation.cliArgs).toBeDefined()
    const args = invocation.cliArgs ?? []
    expect(args.slice(0, 2)).toEqual(['run', 'Continue the plan'])
    expect(args).toContain('--session')
    expect(args).toContain('ses_unit')
    expect(args).toContain('--format')
    expect(args).toContain('json')
    expect(args).toContain('--model')
    expect(args).toContain('github-copilot/gpt-5-mini')
    expect(args).not.toContain('--')
  })

  it('protects prompts that start with a dash', () => {
    const rawPrompt = '-list files'
    const invocation = adapter.buildInvocation!({
      sessionId: 'ses_dash',
      modelId: 'github-copilot/gpt-5-mini',
      text: rawPrompt
    })
    const args = invocation.cliArgs ?? []
    expect(args[1]).toMatch(/^ /)
    expect(args[1]?.trim()).toBe(rawPrompt)
  })
})
