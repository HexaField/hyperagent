import express from 'express'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodingAgentSessionDetail, CodingAgentSessionSummary } from '../../../interfaces/core/codingAgent'
import * as agentModule from '../../../modules/agent/multi-agent'

let createWorkspaceSessionsRouter: any

// Minimal mocked dependencies
const wrapAsync = (h: any) => h

function makeDeps(overrides: any = {}) {
  const defaultRunner = {
    startRun: vi.fn(async (input: any) => ({ id: 'ses_test', ...input })),
    listRuns: vi.fn(async () => []),
    getRun: vi.fn(async () => null),
    killRun: vi.fn(async () => false)
  }
  const defaultStorage = {
    listSessions: vi.fn(async () => []),
    getSession: vi.fn(async () => null)
  }
  return {
    wrapAsync,
    codingAgentRunner: overrides.codingAgentRunner ?? defaultRunner,
    codingAgentStorage: overrides.codingAgentStorage ?? defaultStorage,
    codingAgentCommandRunner: overrides.codingAgentCommandRunner ?? (async () => ({})),
    ensureWorkspaceDirectory:
      overrides.ensureWorkspaceDirectory ??
      (async (dir: string) => {
        await fs.mkdir(dir, { recursive: true })
      })
  }
}

const MULTI_AGENT_PERSONA_ID = 'multi-agent'
const NON_MULTI_PERSONA_ID = 'builder-persona'
const TEST_PROMPT = 'Please do the task'

describe('workspace sessions routes — agent persona', () => {
  // Local test helper: lightweight filesystem-backed storage for runs.
  type LocalOpencodeStorage = {
    rootDir?: string
    listSessions: (opts?: { workspacePath?: string }) => Promise<CodingAgentSessionSummary[]>
    getSession: (sessionId: string) => Promise<CodingAgentSessionDetail | null>
  }

  function createOpencodeStorage(opts: { rootDir?: string }): LocalOpencodeStorage {
    const rootDir = opts?.rootDir ?? process.env.OPENCODE_STORAGE_ROOT ?? './.opencode'
    const runsDir = path.join(rootDir, 'runs')

    async function ensureRunsDir(): Promise<void> {
      try {
        await fs.mkdir(runsDir, { recursive: true })
      } catch {
        // ignore
      }
    }

    async function listRunFiles(): Promise<string[]> {
      await ensureRunsDir()
      try {
        const entries = await fs.readdir(runsDir, { withFileTypes: true })
        return entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => path.join(runsDir, e.name))
      } catch {
        return []
      }
    }

    async function readRunFile(filePath: string): Promise<CodingAgentSessionDetail | null> {
      try {
        const raw = await fs.readFile(filePath, 'utf8')
        const parsed = JSON.parse(raw)
        return parsed as CodingAgentSessionDetail
      } catch {
        return null
      }
    }

    return {
      rootDir,
      listSessions: async ({ workspacePath } = {}) => {
        const files = await listRunFiles()
        const sessions: CodingAgentSessionSummary[] = []
        for (const file of files) {
          const detail = await readRunFile(file)
          if (!detail) continue
          const session = detail.session
          if (workspacePath && session.workspacePath !== workspacePath) continue
          sessions.push(session)
        }
        sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        return sessions
      },
      getSession: async (sessionId: string) => {
        const filePath = path.join(runsDir, `${sessionId}.json`)
        return await readRunFile(filePath)
      }
    }
  }

  let tmpHome = ''
  let app: express.Express
  let spyRunLoop: any
  let depsUnderTest: ReturnType<typeof makeDeps>
  let storageRoot: string
  let opencodeStorage: LocalOpencodeStorage

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ha-test-home-'))
    process.env.OPENCODE_AGENT_DIR = path.join(tmpHome, '.config', 'opencode', 'agent')
    const personaDir = path.join(tmpHome, '.config', 'opencode', 'agent')
    await fs.mkdir(personaDir, { recursive: true })
    await fs.writeFile(
      path.join(personaDir, `${MULTI_AGENT_PERSONA_ID}.md`),
      `---\nlabel: Multi Agent\nmode: primary\n---\n# Multi agent persona`,
      'utf8'
    )
    await fs.writeFile(
      path.join(personaDir, `${NON_MULTI_PERSONA_ID}.md`),
      `---\nlabel: Builder\nmode: assistant\n---\n# Builder persona`,
      'utf8'
    )

    const workerChunk = JSON.stringify({
      status: 'working',
      plan: '1. Scan repo\n2. Update files',
      work: 'Updated README with latest instructions.',
      requests: ''
    })
    const verifierChunk = JSON.stringify({
      verdict: 'instruct',
      critique: 'Outline looks good but needs tests.',
      instructions: 'Write regression tests for the new workflow.',
      priority: 2
    })

    spyRunLoop = vi.spyOn(agentModule, 'runVerifierWorkerLoop').mockImplementation(async (opts: any) => {
      if (opts?.onStream && typeof opts.onStream === 'function') {
        opts.onStream({ role: 'worker', round: 1, chunk: workerChunk, provider: 'opencode', model: 'm', attempt: 1 })
        opts.onStream({
          role: 'verifier',
          round: 1,
          chunk: verifierChunk,
          provider: 'opencode',
          model: 'm',
          attempt: 1
        })
      }
      return {
        outcome: 'approved',
        reason: 'ok',
        bootstrap: { round: 0, raw: '', parsed: { verdict: 'approve', critique: '', instructions: '', priority: 3 } },
        rounds: []
      } as any
    })

    const mod = await import('./routes')
    createWorkspaceSessionsRouter = mod.createWorkspaceSessionsRouter

    storageRoot = path.join(tmpHome, 'opencode-storage')
    opencodeStorage = createOpencodeStorage({ rootDir: storageRoot })
    depsUnderTest = makeDeps({
      codingAgentStorage: opencodeStorage
    })
    const router = createWorkspaceSessionsRouter(depsUnderTest)

    const { readPersona } = await import('./personas')
    const persona = await readPersona(MULTI_AGENT_PERSONA_ID)
    if (!persona) throw new Error('Failed to read persona during test setup')

    app = express()
    app.use(express.json())
    app.use(router)
  })

  afterEach(async () => {
    try {
      await fs.rm(tmpHome, { recursive: true, force: true })
    } catch {}
    vi.restoreAllMocks()
  })

  const waitForStoredMessage = async (sessionId: string, role: string) => {
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
      try {
        const detail = await opencodeStorage.getSession(sessionId)
        const message = detail?.messages.find((msg: any) => msg.role === role)
        if (message) return message
      } catch {}
      await new Promise((r) => setTimeout(r, 50))
    }
    return null
  }

  it('starts session and triggers multi-agent loop for the multi-agent persona', async () => {
    const workspacePath = path.join(tmpHome, 'ha-ws')
    const resp = await request(app)
      .post('/api/coding-agent/sessions')
      .send({ workspacePath, prompt: TEST_PROMPT, personaId: MULTI_AGENT_PERSONA_ID })

    expect(resp.status).toBe(202)
    expect(resp.body).toHaveProperty('run')
    expect(resp.body.run).toHaveProperty('id')
    const sessionId = resp.body.run.id

    await new Promise((r) => setTimeout(r, 50))
    expect(spyRunLoop).toHaveBeenCalledTimes(1)
    const callArgs = spyRunLoop.mock.calls[0][0]
    expect(callArgs).toMatchObject({ userInstructions: TEST_PROMPT })

    const userMessage = await waitForStoredMessage(sessionId, 'user')
    expect(userMessage, 'expected stored user prompt message').toBeTruthy()
    expect(userMessage?.parts[0]?.text).toContain(TEST_PROMPT)

    const workerMessage = await waitForStoredMessage(sessionId, 'worker')
    expect(workerMessage, 'expected worker stream message').toBeTruthy()
    expect(workerMessage?.parts[0]?.type).toBe('text')
    expect(workerMessage?.parts[0]?.text).toBe(
      'Status: working\n\nPlan:\n1. Scan repo\n2. Update files\n\nWork:\nUpdated README with latest instructions.'
    )

    const verifierMessage = await waitForStoredMessage(sessionId, 'verifier')
    expect(verifierMessage, 'expected verifier stream message').toBeTruthy()
    expect(verifierMessage?.parts[0]?.type).toBe('text')
    expect(verifierMessage?.parts[0]?.text).toBe(
      'Verdict: instruct (priority 2)\n\nCritique:\nOutline looks good but needs tests.\n\nInstructions:\nWrite regression tests for the new workflow.'
    )
  })

  it('falls back to the provider runner for non multi-agent personas', async () => {
    const workspacePath = path.join(tmpHome, 'ha-ws-builder')
    const resp = await request(app)
      .post('/api/coding-agent/sessions')
      .send({ workspacePath, prompt: TEST_PROMPT, personaId: NON_MULTI_PERSONA_ID })

    expect(resp.status).toBe(202)
    expect(depsUnderTest.codingAgentRunner.startRun).toHaveBeenCalledTimes(1)
    expect(spyRunLoop).not.toHaveBeenCalled()
  })

  it('dedupes consecutive identical messages in session detail responses', async () => {
    const sessionId = 'ses_dedupe'
    const timestamp = new Date(0).toISOString()
    const basePart = { id: 'prt_a', type: 'text', text: 'hello', start: null, end: null }
    const baseMessage = {
      id: 'msg_a',
      role: 'assistant',
      createdAt: timestamp,
      completedAt: timestamp,
      modelId: 'm',
      providerId: 'p',
      text: '',
      parts: [basePart]
    }
    const detail: CodingAgentSessionDetail = {
      session: {
        id: sessionId,
        title: 'Dedup',
        workspacePath: '/tmp/dedup',
        projectId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        summary: { additions: 0, deletions: 0, files: 0 }
      },
      messages: [
        baseMessage,
        { ...baseMessage, id: 'msg_b', parts: [{ ...basePart, id: 'prt_b' }] },
        { ...baseMessage, id: 'msg_c', parts: [{ ...basePart, id: 'prt_c', text: 'updated' }] }
      ]
    }

    const storageMock = {
      listSessions: vi.fn(async () => []),
      getSession: vi.fn(async () => detail)
    }
    const runnerMock = {
      startRun: vi.fn(async () => ({ id: 'fallback', pid: -1 })),
      listRuns: vi.fn(async () => []),
      getRun: vi.fn(async () => null),
      killRun: vi.fn(async () => false)
    }
    const deps = makeDeps({ codingAgentStorage: storageMock, codingAgentRunner: runnerMock })
    const router = createWorkspaceSessionsRouter(deps)
    const localApp = express()
    localApp.use(router)

    const resp = await request(localApp).get(`/api/coding-agent/sessions/${sessionId}`)
    expect(resp.status).toBe(200)
    expect(resp.body.messages).toHaveLength(2)
    expect(resp.body.messages[0].id).toBe('msg_a')
    expect(resp.body.messages[1].id).toBe('msg_c')
  })
})
