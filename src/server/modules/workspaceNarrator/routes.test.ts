import express from 'express'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceNarratorRouter, type NarratorRelay, type WrapAsync } from './routes'

const noopWrapAsync: WrapAsync = (handler) => handler

const createTempDir = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'narrator-router-'))
  await fs.mkdir(path.join(dir, 'logs'), { recursive: true })
  await fs.mkdir(path.join(dir, 'summaries'), { recursive: true })
  await fs.mkdir(path.join(dir, 'archive'), { recursive: true })
  return dir
}

const writeJsonFile = async (filePath: string, payload: unknown) => {
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8')
}

describe('workspace narrator routes', () => {
  const prevEnv = process.env.STREAMING_LLM_DATA_DIR
  let tempDir: string
  let app: express.Express

  const buildApp = (relay?: NarratorRelay) => {
    const router = createWorkspaceNarratorRouter({ wrapAsync: noopWrapAsync, narratorRelay: relay })
    const instance = express()
    instance.use(express.json())
    instance.use(router)
    return instance
  }

  beforeEach(async () => {
    tempDir = await createTempDir()
    process.env.STREAMING_LLM_DATA_DIR = tempDir
    await writeJsonFile(path.join(tempDir, 'tasks.graph.json'), { tasks: [] })
    app = buildApp()
  })

  afterEach(() => {
    process.env.STREAMING_LLM_DATA_DIR = prevEnv
  })

  const writeLog = async (conversationId: string, rows: Array<Record<string, unknown>>) => {
    const logPath = path.join(tempDir, 'logs', `${conversationId}.jsonl`)
    await fs.writeFile(logPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf-8')
    return logPath
  }

  it('returns normalized narrator events for workspace feed', async () => {
    await writeJsonFile(path.join(tempDir, 'tasks.graph.json'), {
      tasks: [
        {
          id: 'task-1',
          type: 'controller',
          status: 'COMPLETED',
          owner: null,
          inputs: {},
          outputs: {},
          context: {},
          metadata: {
            workspace_id: 'ws-observe',
            conversation_id: 'conv-observe'
          }
        }
      ]
    })
    await writeLog('conv-observe', [
      {
        id: 'evt-1',
        timestamp: '2025-11-30T00:00:00Z',
        conversation_id: 'conv-observe',
        type: 'NARRATION',
        payload: { text: 'Narrator ready' }
      },
      {
        id: 'evt-2',
        timestamp: '2025-11-30T00:00:02Z',
        conversation_id: 'conv-observe',
        type: 'AGENT_RESULT',
        payload: { outcome: 'failed', error: { reason: 'timeout' } }
      },
      {
        id: 'evt-3',
        timestamp: '2025-11-30T00:00:03Z',
        conversation_id: 'conv-observe',
        type: 'NARRATION_SUPPRESSED',
        payload: { reason: 'gated' }
      },
      {
        id: 'evt-4',
        timestamp: '2025-11-30T00:00:04Z',
        conversation_id: 'conv-observe',
        type: 'SUMMARY_REFRESH',
        payload: { summary_ref: 'conv-observe.md' }
      }
    ])
    await fs.writeFile(path.join(tempDir, 'summaries', 'conv-observe.md'), '# Summary', 'utf-8')
    app = buildApp()
    const res = await request(app).get('/api/workspaces/ws-observe/narrator/feed?limit=10')
    expect(res.status).toBe(200)
    expect(res.body.conversationId).toBe('conv-observe')
    expect(res.body.summaryRef).toMatch(/conv-observe\.md$/)
    expect(res.body.events).toHaveLength(4)
    expect(res.body.events[0]).toMatchObject({
      id: 'evt-4',
      type: 'summary',
      severity: 'info'
    })
    const failure = res.body.events.find((event: any) => event.id === 'evt-2')
    expect(failure.playbookId).toBe('agent-run-failed')
    const suppressed = res.body.events.find((event: any) => event.id === 'evt-3')
    expect(suppressed.playbookId).toBe('narration-suppressed')
  })

  it('falls back to workspace id when no task metadata exists', async () => {
    const res = await request(app).get('/api/workspaces/ws-missing/narrator/feed')
    expect(res.status).toBe(200)
    expect(res.body.conversationId).toBe('ws-missing')
    expect(res.body.events).toEqual([])
  })

  it('streams raw jsonl logs', async () => {
    await writeLog('ws-raw', [
      {
        id: 'evt-a',
        timestamp: '2025-11-30T01:00:00Z',
        conversation_id: 'ws-raw',
        type: 'NARRATION',
        payload: { text: 'Hi' }
      }
    ])
    const res = await request(app).get('/api/workspaces/ws-raw/narrator/raw')
    expect(res.status).toBe(200)
    expect(res.header['content-type']).toContain('application/jsonl')
    expect(res.text.trim()).toContain('"id":"evt-a"')
  })

  it('relays narrator messages and updates the task graph', async () => {
    const relay: NarratorRelay = vi.fn(async () => ({ narration: 'All systems go.' }))
    app = buildApp(relay)

    const postRes = await request(app).post('/api/workspaces/ws-send/narrator/messages').send({ message: 'Ship it' })

    expect(postRes.status).toBe(202)
    expect(postRes.body.workspaceId).toBe('ws-send')
    expect(postRes.body.conversationId).toBe('ws-send')
    expect(postRes.body.taskId).toMatch(/^task-/)
    expect(postRes.body.eventId).toMatch(/^narrator-/)
    expect(relay).toHaveBeenCalledWith({ workspaceId: 'ws-send', conversationId: 'ws-send', message: 'Ship it' })

    const feedRes = await request(app).get('/api/workspaces/ws-send/narrator/feed?limit=10')
    expect(feedRes.status).toBe(200)
    const events = feedRes.body.events
    expect(events.length).toBeGreaterThanOrEqual(3)
    const userEvent = events.find((event: any) => event.headline === 'User message')
    expect(userEvent).toMatchObject({ detail: 'Ship it', source: 'user' })
    const narratorEvent = events.find((event: any) => event.id === postRes.body.eventId)
    expect(narratorEvent).toMatchObject({ detail: 'All systems go.', source: 'narrator' })

    const graphRaw = await fs.readFile(path.join(tempDir, 'tasks.graph.json'), 'utf-8')
    const graph = JSON.parse(graphRaw)
    expect(graph.tasks).toHaveLength(1)
    expect(graph.tasks[0]).toMatchObject({
      status: 'COMPLETED',
      metadata: expect.objectContaining({ source: 'workspace-narrator', workspace_id: 'ws-send' })
    })
    expect(graph.tasks[0].outputs?.narrator_event_id).toBe(postRes.body.eventId)
  })

  it('captures relay failures and returns 502', async () => {
    const relay: NarratorRelay = vi.fn(async () => {
      throw new Error('Relay failed to connect')
    })
    app = buildApp(relay)

    const postRes = await request(app)
      .post('/api/workspaces/ws-fail/narrator/messages')
      .send({ message: 'Status update' })

    expect(postRes.status).toBe(502)
    expect(postRes.body).toMatchObject({ error: 'relay_failed', detail: 'Relay failed to connect' })

    const feedRes = await request(app).get('/api/workspaces/ws-fail/narrator/feed?limit=10')
    expect(feedRes.status).toBe(200)
    const failureEvent = feedRes.body.events.find((event: any) => event.type === 'error')
    expect(failureEvent).toMatchObject({ playbookId: 'narrator-error' })

    const graphRaw = await fs.readFile(path.join(tempDir, 'tasks.graph.json'), 'utf-8')
    const graph = JSON.parse(graphRaw)
    expect(graph.tasks).toHaveLength(1)
    expect(graph.tasks[0]).toMatchObject({ status: 'FAILED' })
    expect(graph.tasks[0].outputs?.error).toBe('Relay failed to connect')
  })
})
