import express from 'express'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi, type SpyInstance } from 'vitest'
import * as orchestratorModule from '../../../modules/agent/agent-orchestrator'
import { singleAgentWorkflowDefinition, verifierWorkerWorkflowDefinition } from '../../../modules/agent/workflows'
import * as provenanceModule from '../../../modules/provenance/provenance'
import { createWorkspaceSessionsRouter } from './routes'

const wrapAsync = (handler: any) => handler
const TEST_PROMPT = 'Please handle this task.'

describe('workspace sessions routes — RunMeta payloads', () => {
  let tmpHome = ''
  let app: express.Express
  let runAgentWorkflowSpy: SpyInstance

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ha-router-test-'))

    const singleAgentResult = { runId: 'ses_single', result: Promise.resolve({} as any) }
    const multiAgentResult = { runId: 'ses_multi', result: Promise.resolve({} as any) }
    runAgentWorkflowSpy = vi.spyOn(orchestratorModule, 'runAgentWorkflow').mockImplementation(async (definition) => {
      if (definition.id === verifierWorkerWorkflowDefinition.id) {
        return multiAgentResult
      }
      if (definition.id === singleAgentWorkflowDefinition.id) {
        return singleAgentResult
      }
      throw new Error(`Unexpected workflow definition: ${definition.id}`)
    })
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
    expect(runAgentWorkflowSpy).toHaveBeenCalledTimes(1)
    const [definition] = runAgentWorkflowSpy.mock.calls[0]
    expect(definition.id).toBe(verifierWorkerWorkflowDefinition.id)
    expect(response.body.run.id).toBe('ses_multi')
  })

  it('falls back to the single-agent loop when no workflowId specified', async () => {
    const workspacePath = path.join(tmpHome, 'ws-single')
    const response = await request(app)
      .post('/api/coding-agent/sessions')
      .send({ workspacePath, prompt: TEST_PROMPT })

    expect(response.status).toBe(202)
    expect(runAgentWorkflowSpy).toHaveBeenCalledTimes(1)
    const [definition] = runAgentWorkflowSpy.mock.calls[0]
    expect(definition.id).toBe(singleAgentWorkflowDefinition.id)
    expect(response.body.run.id).toBe('ses_single')
  })

  it('returns the latest RunMeta payload when posting a message', async () => {
    const workspacePath = path.join(tmpHome, 'ws-message')
    const response = await request(app)
      .post('/api/coding-agent/sessions/run-123/messages')
      .query({ workspacePath })
      .send({ text: 'hello world' })

    expect(response.status).toBe(201)
    expect(runAgentWorkflowSpy).toHaveBeenCalled()
    expect(response.body.run).toMatchObject({ id: 'run-123' })
  })

  it('rejects message posts without an explicit workspacePath', async () => {
    const response = await request(app)
      .post('/api/coding-agent/sessions/run-123/messages')
      .send({ text: 'missing workspace' })

    expect(response.status).toBe(400)
    expect(response.body.error).toMatch(/workspacePath/i)
    expect(runAgentWorkflowSpy).not.toHaveBeenCalled()
  })
})
