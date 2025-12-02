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

const TEST_PERSONA_ID = 'agent-persona'
const TEST_PROMPT = 'Please do the task'

describe('workspace sessions routes — agent persona', () => {
  let tmpHome = ''
  let app: express.Express
  let spyRunLoop: any

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ha-test-home-'))
    // point persona loader to the temp dir to avoid touching real home
    process.env.OPENCODE_AGENT_DIR = path.join(tmpHome, '.config', 'opencode', 'agent')
    // create persona dir and file
    const personaDir = path.join(tmpHome, '.config', 'opencode', 'agent')
    await fs.mkdir(personaDir, { recursive: true })
    const personaMarkdown = `---\nlabel: Test Agent\nmode: agent\n---\n# Agent persona`
    await fs.writeFile(path.join(personaDir, `${TEST_PERSONA_ID}.md`), personaMarkdown, 'utf8')

    // Spy on runVerifierWorkerLoop and simulate streaming
    spyRunLoop = vi.spyOn(agentModule, 'runVerifierWorkerLoop').mockImplementation(async (opts: any) => {
      // emit a couple of stream events if callback provided
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

    // import the routes module after the spy is in place so the module
    // picks up the mocked runVerifierWorkerLoop reference
    const mod = await import('./routes')
    createWorkspaceSessionsRouter = mod.createWorkspaceSessionsRouter
    // Provide a temporary opencode storage root so route will write message/part files there
    const storageRoot = path.join(tmpHome, 'opencode-storage')
    await fs.mkdir(path.join(storageRoot, 'storage', 'message'), { recursive: true })
    const deps = makeDeps({ codingAgentStorage: { rootDir: storageRoot, listSessions: vi.fn(async () => []), getSession: vi.fn(async () => null) } })
    const router = createWorkspaceSessionsRouter(deps)
    // quick sanity check: ensure the persona can be read by the server helpers
    const { readPersona } = await import('./personas')
    const p = await readPersona(TEST_PERSONA_ID)
    if (!p) throw new Error('Failed to read persona during test setup')
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

  it('starts session and triggers agent loop for persona with mode: agent', async () => {
    const resp = await request(app)
      .post('/api/coding-agent/sessions')
      .send({ workspacePath: path.join(os.tmpdir(), 'ha-ws'), prompt: TEST_PROMPT, personaId: TEST_PERSONA_ID })

    if (resp.status !== 202) {
      // helpful debug output
      // eslint-disable-next-line no-console
      console.error('RESP BODY', resp.status, resp.body)
    }
    expect(resp.status).toBe(202)
    expect(resp.body).toHaveProperty('run')
    // allow some time for background invocation to have been scheduled and write log
    await new Promise((r) => setTimeout(r, 50))
    expect(spyRunLoop).toHaveBeenCalled()
    const callArgs = spyRunLoop.mock.calls[0][0]
    expect(callArgs).toMatchObject({ userInstructions: TEST_PROMPT })
    // verify the stream log file was created and contains our chunks
    const logPath = path.join(path.join(os.tmpdir(), 'ha-ws'), '.opencode', 'agent-streams', 'ses_test.log')
    const exists = await fs.stat(logPath).then(() => true).catch(() => false)
    expect(exists).toBe(true)
    const content = await fs.readFile(logPath, 'utf8')
    expect(content).toContain('worker-chunk-1')
    expect(content).toContain('verifier-chunk-1')
  })
})
