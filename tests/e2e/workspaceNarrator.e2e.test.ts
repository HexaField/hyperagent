import fs from 'fs/promises'
import type { RequestOptions } from 'node:https'
import https from 'node:https'
import { setTimeout as delay } from 'node:timers/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import type { NarratorRelay } from '../../src/server/modules/workspaceNarrator/routes'
import { startBackendServerHarness } from './helpers/serverHarness'

type JsonResponse<T> = {
  status: number
  data: T
}

type RawLogEntry = {
  id: string
  type: string
  payload: Record<string, unknown>
}

describe('workspace narrator e2e', () => {
  it('relays narrator messages through the backend server', { timeout: 60_000 }, async () => {
    const workspaceId = `ws-narrator-${Date.now()}`
    const streamingDir = await prepareStreamingDataDir()
    const prevDataDir = process.env.STREAMING_LLM_DATA_DIR
    process.env.STREAMING_LLM_DATA_DIR = streamingDir
    const fakeRelay = createFakeNarratorRelay('Affirmative. Controller reply acknowledged.')
    const server = await startBackendServerHarness({ narratorRelay: fakeRelay.relay })

    try {
      const postResult = await requestJson<{
        workspaceId: string
        conversationId: string
        eventId: string
        taskId: string
      }>(`${server.baseUrl}/api/workspaces/${workspaceId}/narrator/messages`, {
        method: 'POST',
        body: { message: 'Status update please' }
      })
      expect(postResult.status).toBe(202)
      expect(postResult.data.taskId).toMatch(/^task-/)

      await waitFor(async () => {
        const feedResult = await requestJson<WorkspaceNarratorFeedResponse>(
          `${server.baseUrl}/api/workspaces/${workspaceId}/narrator/feed?limit=20`,
          { method: 'GET' }
        )
        expect(feedResult.status).toBe(200)
        const events = feedResult.data.events ?? []
        const userEvent = events.find((event) => event.headline === 'User message')
        const narratorEvent = events.find((event) => event.headline === 'Narrator reply')
        if (!userEvent || !narratorEvent) {
          return false
        }
        expect(userEvent.detail).toBe('Status update please')
        expect(narratorEvent.detail).toContain('Affirmative')
        return true
      })

      const logEntries = await readLogEntries(streamingDir, workspaceId)
      const eventTypes = new Set(logEntries.map((entry) => entry.type))
      expect(eventTypes.has('USER_MESSAGE')).toBe(true)
      expect(eventTypes.has('NARRATION')).toBe(true)
      expect(eventTypes.has('WORKSPACE_NARRATOR_COMPLETED')).toBe(true)

      const graphRaw = await fs.readFile(path.join(streamingDir, 'tasks.graph.json'), 'utf8')
      const graph = JSON.parse(graphRaw)
      const task = graph.tasks.find((node: Record<string, any>) => node.metadata?.source === 'workspace-narrator')
      expect(task?.status).toBe('COMPLETED')
      expect(task?.outputs?.narrator_event_id).toBe(postResult.data.eventId)
      expect(fakeRelay.requests).toHaveLength(1)
      expect(fakeRelay.requests[0]).toMatchObject({ workspaceId, message: 'Status update please' })
    } finally {
      await server.close()
      process.env.STREAMING_LLM_DATA_DIR = prevDataDir
      await fs.rm(streamingDir, { recursive: true, force: true })
    }
  })
})

type WorkspaceNarratorEvent = {
  id: string
  headline: string
  detail: string | null
}

type WorkspaceNarratorFeedResponse = {
  events: WorkspaceNarratorEvent[]
}

type NarratorRelayRequest = {
  workspaceId: string
  conversationId: string
  message: string
}

function createFakeNarratorRelay(responseText: string): { relay: NarratorRelay; requests: NarratorRelayRequest[] } {
  const requests: NarratorRelayRequest[] = []
  const relay: NarratorRelay = async (params) => {
    requests.push(params)
    return { narration: `${responseText} ${params.message}` }
  }
  return { relay, requests }
}

async function prepareStreamingDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'narrator-e2e-data-'))
  await fs.mkdir(path.join(dir, 'logs'), { recursive: true })
  await fs.mkdir(path.join(dir, 'summaries'), { recursive: true })
  await fs.mkdir(path.join(dir, 'archive'), { recursive: true })
  await fs.writeFile(path.join(dir, 'tasks.graph.json'), JSON.stringify({ tasks: [] }, null, 2), 'utf8')
  return dir
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
    if (payload) {
      req.write(payload)
    }
    req.end()
  })
}

async function readLogEntries(dataDir: string, conversationId: string): Promise<RawLogEntry[]> {
  const logPath = path.join(dataDir, 'logs', `${conversationId}.jsonl`)
  const content = await fs.readFile(logPath, 'utf8').catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return ''
    }
    throw error
  })
  if (!content.trim()) {
    return []
  }
  return content
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RawLogEntry)
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000, intervalMs = 200): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return
    }
    await delay(intervalMs)
  }
  throw new Error('Condition not met in time')
}
