import * as provenanceModule from '@hexafield/agent-workflow'
import { singleAgentWorkflowDefinition, verifierWorkerWorkflowDefinition } from '@hexafield/agent-workflow'
import express from 'express'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi, type SpyInstance } from 'vitest'
import * as agentRunnerModule from './agentRunner'
import { createWorkspaceSessionsRouter } from './routes'

const wrapAsync = (handler: any) => handler
const TEST_PROMPT = 'Please handle this task.'

describe('workspace sessions routes — RunMeta payloads', () => {
  let tmpHome = ''
  let app: express.Express
  let runAgentSpy: SpyInstance

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ha-router-test-'))
    vi.spyOn(Date, 'now').mockReturnValue(1_717_171_717)

    runAgentSpy = vi.spyOn(agentRunnerModule, 'runAgent').mockResolvedValue()
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
    if (tmpHome) await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {})
    tmpHome = ''
  })

  it('starts a multi-agent run when workflowId matches', async () => {
    const workspacePath = path.join(tmpHome, 'ws-multi')
    const response = await request(app)
      .post('/api/coding-agent/sessions')
      .send({ workspacePath, prompt: TEST_PROMPT, workflowId: verifierWorkerWorkflowDefinition.id })

    expect(response.status).toBe(202)
    expect(runAgentSpy).toHaveBeenCalledTimes(1)
    const [call] = runAgentSpy.mock.calls
    expect(call[0].workflow.id).toBe(verifierWorkerWorkflowDefinition.id)
    expect(response.body.run.id).toBe(`${verifierWorkerWorkflowDefinition.id}-1717171717`)
  })

  it('falls back to the single-agent loop when no workflowId specified', async () => {
    const workspacePath = path.join(tmpHome, 'ws-single')
    const response = await request(app).post('/api/coding-agent/sessions').send({ workspacePath, prompt: TEST_PROMPT })

    expect(response.status).toBe(202)
    expect(runAgentSpy).toHaveBeenCalledTimes(1)
    const [call] = runAgentSpy.mock.calls
    expect(call[0].workflow.id).toBe(singleAgentWorkflowDefinition.id)
    expect(response.body.run.id).toBe(`${singleAgentWorkflowDefinition.id}-1717171717`)
  })

  it('returns the latest RunMeta payload when posting a message', async () => {
    const workspacePath = path.join(tmpHome, 'ws-message')
    const response = await request(app)
      .post('/api/coding-agent/sessions/run-123/messages')
      .query({ workspacePath })
      .send({ text: 'hello world' })

    expect(response.status).toBe(201)
    expect(runAgentSpy).toHaveBeenCalled()
    expect(response.body.run).toMatchObject({ id: 'run-123' })
  })

  it('rejects message posts without an explicit workspacePath', async () => {
    const response = await request(app)
      .post('/api/coding-agent/sessions/run-123/messages')
      .send({ text: 'missing workspace' })

    expect(response.status).toBe(400)
    expect(response.body.error).toMatch(/workspacePath/i)
    expect(runAgentSpy).not.toHaveBeenCalled()
  })
})
