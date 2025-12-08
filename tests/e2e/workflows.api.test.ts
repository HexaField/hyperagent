import fs from 'fs/promises'
import type { RequestOptions } from 'node:https'
import https from 'node:https'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { startBackendServerHarness } from './helpers/serverHarness'

type JsonResponse<T> = { status: number; data: T }

const baseDefinition = {
  $schema: 'https://hyperagent.dev/schemas/agent-workflow.json',
  id: 'test-workflow.v1',
  description: 'Test workflow',
  model: 'github-copilot/gpt-5-mini',
  sessions: { roles: [{ role: 'agent' as const, nameTemplate: '{{runId}}-agent' }] },
  parsers: {
    agent: {
      type: 'object' as const,
      properties: { status: { type: 'string' as const }, summary: { type: 'string' as const } },
      required: ['status', 'summary']
    }
  },
  roles: {
    agent: {
      systemPrompt: 'Return status and summary as JSON.',
      parser: 'agent'
    }
  },
  flow: {
    round: {
      start: 'agent',
      steps: [
        {
          key: 'agent',
          role: 'agent' as const,
          prompt: ['Do the task: {{user.instructions}}'],
          exits: [
            {
              condition: 'always' as const,
              outcome: 'done',
              reason: 'single-step completed'
            }
          ]
        }
      ],
      defaultOutcome: { outcome: 'done', reason: 'single-step default' }
    }
  }
}

async function requestJson<T>(
  url: string,
  init: { method: string; body?: Record<string, unknown> }
): Promise<JsonResponse<T>> {
  const payload = init.body ? JSON.stringify(init.body) : undefined
  const options: RequestOptions = {
    method: init.method,
    rejectUnauthorized: false,
    headers: {
      Accept: 'application/json',
      ...(payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload).toString() }
        : {})
    }
  }

  return await new Promise<JsonResponse<T>>((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        try {
          const parsed = raw.length ? (JSON.parse(raw) as T) : ({} as T)
          resolve({ status: res.statusCode ?? 0, data: parsed })
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

describe('workflows API', () => {
  it('supports CRUD and hydration with real storage', { timeout: 90_000 }, async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workflows-api-'))
    const prevEnv = process.env.OPENCODE_WORKFLOW_DIR
    process.env.OPENCODE_WORKFLOW_DIR = path.join(tmpRoot, 'workflows')
    const server = await startBackendServerHarness({ tmpRoot })

    try {
      // create
      const createRes = await requestJson<{ id: string; path: string }>(`${server.baseUrl}/api/workflows`, {
        method: 'POST',
        body: { definition: baseDefinition }
      })
      expect(createRes.status).toBe(201)
      expect(createRes.data.id).toBe('test-workflow.v1')

      // list
      const listRes = await requestJson<{ workflows: Array<{ id: string }> }>(`${server.baseUrl}/api/workflows`, {
        method: 'GET'
      })
      expect(listRes.status).toBe(200)
      expect(listRes.data.workflows.map((w) => w.id)).toContain('test-workflow.v1')

      // detail
      const detailRes = await requestJson<{ workflow: { definition: typeof baseDefinition } }>(
        `${server.baseUrl}/api/workflows/test-workflow.v1`,
        { method: 'GET' }
      )
      expect(detailRes.status).toBe(200)
      expect(detailRes.data.workflow.definition.description).toBe('Test workflow')

      // hydrate stored
      const hydrateRes = await requestJson<{ workflow: { definition: typeof baseDefinition } }>(
        `${server.baseUrl}/api/workflows/test-workflow.v1/hydrate`,
        { method: 'POST' }
      )
      expect(hydrateRes.status).toBe(200)
      expect(hydrateRes.data.workflow.definition.id).toBe('test-workflow.v1')

      // validate payload without saving
      const validateRes = await requestJson<{ definition: typeof baseDefinition }>(
        `${server.baseUrl}/api/workflows/validate`,
        { method: 'POST', body: { definition: { ...baseDefinition, id: 'test-workflow.v2' } } }
      )
      expect(validateRes.status).toBe(200)
      expect(validateRes.data.definition.id).toBe('test-workflow.v2')

      // update
      const updated = { ...baseDefinition, description: 'Updated description' }
      const updateRes = await requestJson<{ id: string }>(`${server.baseUrl}/api/workflows/test-workflow.v1`, {
        method: 'PUT',
        body: { definition: updated }
      })
      expect(updateRes.status).toBe(200)
      const detailResAfter = await requestJson<{ workflow: { definition: typeof baseDefinition } }>(
        `${server.baseUrl}/api/workflows/test-workflow.v1`,
        { method: 'GET' }
      )
      expect(detailResAfter.data.workflow.definition.description).toBe('Updated description')

      // delete
      const delRes = await requestJson<{ success: boolean }>(`${server.baseUrl}/api/workflows/test-workflow.v1`, {
        method: 'DELETE'
      })
      expect(delRes.status).toBe(200)
      const listAfterDel = await requestJson<{ workflows: Array<{ id: string }> }>(`${server.baseUrl}/api/workflows`, {
        method: 'GET'
      })
      expect(listAfterDel.data.workflows.map((w) => w.id)).not.toContain('test-workflow.v1')
    } finally {
      await server.close()
      process.env.OPENCODE_WORKFLOW_DIR = prevEnv
      await fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })
})
