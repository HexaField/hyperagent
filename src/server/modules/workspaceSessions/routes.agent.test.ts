import express from 'express'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as agentModule from '../../../modules/agent/multi-agent'
import * as singleAgentModule from '../../../modules/agent/single-agent'
import * as provenanceModule from '../../../modules/provenance/provenance'
import { createWorkspaceSessionsRouter } from './routes'

const wrapAsync = (handler: any) => handler
const MULTI_AGENT_PERSONA_ID = 'multi-agent'
const NON_MULTI_PERSONA_ID = 'solo-builder'
const TEST_PROMPT = 'Please handle this task.'

describe('workspace sessions routes — RunMeta payloads', () => {
  let tmpHome = ''
  let app: express.Express

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ha-router-test-'))
    const personaDir = path.join(tmpHome, '.config', 'opencode', 'agent')
    await fs.mkdir(personaDir, { recursive: true })
    await fs.writeFile(
      path.join(personaDir, `${MULTI_AGENT_PERSONA_ID}.md`),
      `---\nlabel: Multi Agent\nmode: primary\n---\n`,
      'utf8'
    )
    await fs.writeFile(
      path.join(personaDir, `${NON_MULTI_PERSONA_ID}.md`),
      `---\nlabel: Solo\nmode: assistant\n---\n`,
      'utf8'
    )
    process.env.OPENCODE_AGENT_DIR = personaDir

    vi.spyOn(agentModule, 'runVerifierWorkerLoop').mockResolvedValue({ runId: 'ses_multi' } as any)
    vi.spyOn(singleAgentModule, 'runSingleAgentLoop').mockResolvedValue({ runId: 'ses_single' } as any)
    vi.spyOn(provenanceModule, 'loadRunMeta').mockImplementation((runId: string) => ({
      id: runId,
      agents: [],
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }))

    app = express()
    app.use(express.json())
    app.use(createWorkspaceSessionsRouter({ wrapAsync }))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (tmpHome) {
      await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {})
      tmpHome = ''
    }
  })

  it('starts a multi-agent run when persona matches', async () => {
    const workspacePath = path.join(tmpHome, 'ws-multi')
    const response = await request(app)
      .post('/api/coding-agent/sessions')
      .send({ workspacePath, prompt: TEST_PROMPT, personaId: MULTI_AGENT_PERSONA_ID })

    expect(response.status).toBe(202)
    expect(agentModule.runVerifierWorkerLoop).toHaveBeenCalledTimes(1)
    expect(singleAgentModule.runSingleAgentLoop).not.toHaveBeenCalled()
    expect(response.body.run.id).toBe('ses_multi')
  })

  it('falls back to the single-agent loop for other personas', async () => {
    const workspacePath = path.join(tmpHome, 'ws-single')
    const response = await request(app)
      .post('/api/coding-agent/sessions')
      .send({ workspacePath, prompt: TEST_PROMPT, personaId: NON_MULTI_PERSONA_ID })

    expect(response.status).toBe(202)
    expect(singleAgentModule.runSingleAgentLoop).toHaveBeenCalledTimes(1)
    expect(agentModule.runVerifierWorkerLoop).not.toHaveBeenCalled()
    expect(response.body.run.id).toBe('ses_single')
  })

  it('returns the latest RunMeta payload when posting a message', async () => {
    const workspacePath = path.join(tmpHome, 'ws-message')
    const response = await request(app)
      .post('/api/coding-agent/sessions/run-123/messages')
      .query({ workspacePath })
      .send({ text: 'hello world' })

    expect(response.status).toBe(201)
    expect(singleAgentModule.runSingleAgentLoop).toHaveBeenCalled()
    expect(response.body.run).toMatchObject({ id: 'run-123' })
  })

  it('rejects message posts without an explicit workspacePath', async () => {
    const response = await request(app)
      .post('/api/coding-agent/sessions/run-123/messages')
      .send({ text: 'missing workspace' })

    expect(response.status).toBe(400)
    expect(response.body.error).toMatch(/workspacePath/i)
    expect(singleAgentModule.runSingleAgentLoop).not.toHaveBeenCalled()
    expect(agentModule.runVerifierWorkerLoop).not.toHaveBeenCalled()
  })
})
