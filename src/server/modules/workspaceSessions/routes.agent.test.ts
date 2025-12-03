import express from 'express'
import request from 'supertest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

let createWorkspaceSessionsRouter: any
import * as agentModule from '../../../../src/modules/agent'

// Minimal mocked dependencies
const wrapAsync = (h: any) => h

function makeDeps(overrides: any = {}) {
  const defaultRunner = {
    startRun: vi.fn(async (input: any) => ({ sessionId: 'ses_test', ...input }))
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
    ensureWorkspaceDirectory: overrides.ensureWorkspaceDirectory ?? (async (dir: string) => {
      await fs.mkdir(dir, { recursive: true })
    })
  }
}

const MULTI_AGENT_PERSONA_ID = 'multi-agent'
const NON_MULTI_PERSONA_ID = 'builder-persona'
const TEST_PROMPT = 'Please do the task'

describe('workspace sessions routes — agent persona', () => {
  let tmpHome = ''
  let app: express.Express
  let spyRunLoop: any
  let depsUnderTest: ReturnType<typeof makeDeps>
  let storageRoot: string

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

    spyRunLoop = vi.spyOn(agentModule, 'runVerifierWorkerLoop').mockImplementation(async (opts: any) => {
      if (opts?.onStream && typeof opts.onStream === 'function') {
        opts.onStream({ role: 'worker', round: 1, chunk: 'worker-chunk-1', provider: 'opencode', model: 'm', attempt: 1 })
        opts.onStream({ role: 'verifier', round: 1, chunk: 'verifier-chunk-1', provider: 'opencode', model: 'm', attempt: 1 })
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
    await fs.mkdir(path.join(storageRoot, 'storage', 'message'), { recursive: true })
    depsUnderTest = makeDeps({
      codingAgentStorage: { rootDir: storageRoot, listSessions: vi.fn(async () => []), getSession: vi.fn(async () => null) }
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

  it('starts session and triggers multi-agent loop for the multi-agent persona', async () => {
    const workspacePath = path.join(tmpHome, 'ha-ws')
    const resp = await request(app)
      .post('/api/coding-agent/sessions')
      .send({ workspacePath, prompt: TEST_PROMPT, personaId: MULTI_AGENT_PERSONA_ID })

    expect(resp.status).toBe(202)
    expect(resp.body).toHaveProperty('run')
    expect(resp.body.run).toHaveProperty('providerId', 'multi-agent')
    const sessionId = resp.body.run.sessionId

    await new Promise((r) => setTimeout(r, 50))
    expect(spyRunLoop).toHaveBeenCalledTimes(1)
    const callArgs = spyRunLoop.mock.calls[0][0]
    expect(callArgs).toMatchObject({ userInstructions: TEST_PROMPT })

    const sessionMessageDir = path.join(storageRoot, 'storage', 'message', sessionId)
    const partRoot = path.join(storageRoot, 'storage', 'part')

    const waitForMessage = async (predicate: (message: any) => boolean) => {
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        try {
          const files = await fs.readdir(sessionMessageDir)
          for (const file of files.filter((name) => name.endsWith('.json'))) {
            const messageJson = JSON.parse(await fs.readFile(path.join(sessionMessageDir, file), 'utf8'))
            if (predicate(messageJson)) return messageJson
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 50))
      }
      return null
    }

    const readFirstPart = async (messageId: string) => {
      const dir = path.join(partRoot, messageId)
      const files = await fs.readdir(dir)
      expect(files.length).toBeGreaterThan(0)
      return JSON.parse(await fs.readFile(path.join(dir, files[0]), 'utf8'))
    }

    const userMessage = await waitForMessage((msg) => msg.role === 'user')
    expect(userMessage, 'expected stored user prompt message').toBeTruthy()
    const userPart = await readFirstPart(userMessage!.id)
    expect(userPart.text).toContain(TEST_PROMPT)

    const workerMessage = await waitForMessage((msg) => msg.role === 'worker')
    expect(workerMessage, 'expected worker stream message').toBeTruthy()
    const workerPart = await readFirstPart(workerMessage!.id)
    expect(workerPart.text?.length ?? 0).toBeGreaterThan(0)
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
})
