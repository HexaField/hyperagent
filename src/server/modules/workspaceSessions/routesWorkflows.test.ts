import { workflowDefinitionSchema } from '@hexafield/agent-workflow'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startBackendServerHarness } from '../../../../tests/e2e/helpers/serverHarness'

const baseDefinition = workflowDefinitionSchema.parse({
  $schema: 'https://hyperagent.dev/schemas/agent-workflow.json',
  id: 'drafted-workflow.v1',
  description: 'Drafted workflow',
  model: 'github-copilot/gpt-5-mini',
  sessions: { roles: [{ role: 'drafter', nameTemplate: '{{runId}}-drafter' }] },
  parsers: {
    drafter: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['working', 'done', 'blocked'] },
        summary: { type: 'string' }
      },
      required: ['status', 'summary']
    }
  },
  roles: {
    drafter: {
      systemPrompt: 'Return status and summary',
      parser: 'drafter'
    }
  },
  flow: {
    round: {
      start: 'drafter',
      steps: [
        {
          key: 'drafter',
          role: 'drafter',
          prompt: ['Do it']
        }
      ],
      defaultOutcome: { outcome: 'done', reason: 'single step' }
    }
  }
})

describe('routesWorkflows draft endpoint (integration)', () => {
  let prevTls: string | undefined

  beforeAll(() => {
    prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  })

  afterAll(() => {
    if (prevTls === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls
    }
  })

  it('returns 400 for missing instructions', async () => {
    const server = await startBackendServerHarness()
    try {
      const res = await fetch(`${server.baseUrl}/api/workflows/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions: '   ', template: baseDefinition })
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: string }
      expect(body.error ?? '').toMatch(/instructions is required/)
    } finally {
      await server.close()
    }
  })

  it('returns drafted workflow for valid instructions without template', async () => {
    const server = await startBackendServerHarness()
    try {
      const res = await fetch(`${server.baseUrl}/api/workflows/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions: 'Create a drafter that summarizes tasks.' })
      })

      console.log('Draft response:', res)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { definition?: unknown; rawText?: string; error?: string }
      expect(body.error).toBeUndefined()
      expect(body.definition).toBeDefined()
      expect(body.rawText).toBeDefined()
      const parsedDefinition = workflowDefinitionSchema.parse(body.definition)
      expect(parsedDefinition.id).toBeDefined()
    } finally {
      await server.close()
    }
  }, 120_000)

  it('returns drafted workflow for valid instructions', async () => {
    const server = await startBackendServerHarness()
    try {
      const res = await fetch(`${server.baseUrl}/api/workflows/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions: 'Create a drafter that summarizes tasks.', template: baseDefinition })
      })

      console.log('Draft response:', res)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { definition?: unknown; rawText?: string; error?: string }
      expect(body.error).toBeUndefined()
      expect(body.definition).toBeDefined()
      expect(body.rawText).toBeDefined()
      const parsedDefinition = workflowDefinitionSchema.parse(body.definition)
      expect(parsedDefinition.id).toBeDefined()
    } finally {
      await server.close()
    }
  }, 120_000)
})
