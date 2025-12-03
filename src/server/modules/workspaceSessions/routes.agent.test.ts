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

    await new Promise((r) => setTimeout(r, 50))
    expect(spyRunLoop).toHaveBeenCalledTimes(1)
    const callArgs = spyRunLoop.mock.calls[0][0]
    expect(callArgs).toMatchObject({ userInstructions: TEST_PROMPT })

    const messageRoot = path.join(storageRoot, 'storage', 'message')
    const locateMessage = async () => {
      try {
        const sessionIds = await fs.readdir(messageRoot)
        const sessionId = sessionIds.find(Boolean)
        if (!sessionId) return null
        const messageFiles = await fs.readdir(path.join(messageRoot, sessionId))
        const messageFile = messageFiles.find((file) => file.endsWith('.json'))
        if (!messageFile) return null
        return { sessionId, messageFile }
      } catch {
        return null
      }
    }
    let selected: { sessionId: string; messageFile: string } | null = null
    for (let i = 0; i < 20 && !selected; i++) {
      selected = await locateMessage()
      if (!selected) await new Promise((r) => setTimeout(r, 25))
    }
    expect(selected, 'expected multi-agent message to be written to storage').toBeTruthy()
    const messageJson = JSON.parse(
      await fs.readFile(path.join(messageRoot, selected!.sessionId, selected!.messageFile), 'utf8')
    )
    expect(['worker', 'verifier']).toContain(messageJson.role)
    const partDir = path.join(storageRoot, 'part', messageJson.id)
    const partFiles = await fs.readdir(partDir)
    expect(partFiles.length).toBeGreaterThan(0)
    const partJson = JSON.parse(await fs.readFile(path.join(partDir, partFiles[0]), 'utf8'))
    expect(partJson.text.length).toBeGreaterThan(0)
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
