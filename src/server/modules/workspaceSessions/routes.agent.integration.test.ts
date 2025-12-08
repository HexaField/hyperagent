import { RunMeta, metaDirectory, verifierWorkerWorkflowDefinition } from '@hexafield/agent-workflow'
import { spawnSync } from 'child_process'
import express from 'express'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { opencodeTestHooks } from '../../../../packages/agent/src/opencodeTestHooks'
import { createWorkspaceSessionsRouter } from './routes'

const TEST_PROMPT = 'You are assisting on a trivial repo. Plan the change then stop.'

const wrapAsync = (h: any) => h

const commandExists = (cmd: string): boolean => {
  const result = spawnSync('which', [cmd])
  return result.status === 0
}

describe('workspace sessions routes — multi-agent opencode integration', () => {
  opencodeTestHooks()

  let tmpRoot = ''
  let app: express.Express

  beforeEach(async () => {
    const exists = commandExists('opencode')
    expect(exists, "Required CLI 'opencode' not found on PATH").toBe(true)

    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ha-multi-agent-int-'))

    const deps = {
      wrapAsync,
      ensureWorkspaceDirectory: async (dir: string) => {
        await fsp.mkdir(dir, { recursive: true })
      }
    }

    const router = createWorkspaceSessionsRouter(deps)
    app = express()
    app.use(express.json())
    app.use(router)
  })

  afterEach(async () => {
    if (tmpRoot) {
      await fsp.rm(tmpRoot, { recursive: true, force: true })
      tmpRoot = ''
    }
  })

  const waitForRoleLog = async (
    sessionDir: string,
    sessionId: string,
    role: string,
    timeoutMs = 240_000
  ): Promise<RunMeta['log'][0]> => {
    const deadline = Date.now() + timeoutMs
    const metaDir = metaDirectory(sessionDir)
    while (Date.now() < deadline) {
      try {
        const file = path.join(metaDir, `${sessionId}.json`)
        if (!fs.existsSync(file)) {
          await new Promise((r) => setTimeout(r, 500))
          continue
        }
        const raw = await fsp.readFile(file, 'utf8')
        const parsed = JSON.parse(raw) as RunMeta
        const entry = parsed.log.find((e) => e.role === role && e.payload && e.payload.raw)
        if (entry) return entry
      } catch {
        // ignore transient errors
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(`Timed out waiting for ${role} log entry for ${sessionId}`)
  }

  it('persists structured worker/verifier messages instead of snapshot placeholders', async () => {
    const sessionDir = path.join(tmpRoot, 'workspace-under-test')
    await fsp.mkdir(sessionDir, { recursive: true })
    // write a minimal opencode config so the agent can start
    const opencodeConfig = { $schema: 'https://opencode.ai/config.json', permission: { edit: 'allow', bash: 'allow' } }
    await fsp.writeFile(path.join(sessionDir, 'opencode.json'), JSON.stringify(opencodeConfig, null, 2), 'utf8')

    const resp = await request(app)
      .post('/api/coding-agent/sessions')
      .send({ workspacePath: sessionDir, prompt: TEST_PROMPT, workflowId: verifierWorkerWorkflowDefinition.id })

    expect(resp.status).toBe(202)
    const sessionId = resp.body?.run?.id
    expect(typeof sessionId).toBe('string')

    const workerEntry = await waitForRoleLog(sessionDir, sessionId, 'worker')
    const workerText = workerEntry.payload?.raw
    expect(typeof workerText).toBe('string')
    expect(workerText.toLowerCase().startsWith('snapshot:')).toBe(false)
    // workerText may be structured JSON or human text; accept either but
    // prefer structured JSON with a `status` field.
    let workerParsed: any = null
    try {
      if (workerText.trim().startsWith('{')) workerParsed = JSON.parse(workerText)
    } catch {}
    if (workerParsed) {
      expect(workerParsed.status || workerParsed.plan).toBeTruthy()
    } else {
      expect(workerText).toMatch(/Status:/)
    }

    const verifierEntry = await waitForRoleLog(sessionDir, sessionId, 'verifier')
    const verifierText = verifierEntry.payload?.raw
    expect(typeof verifierText).toBe('string')
    expect(verifierText.toLowerCase().startsWith('snapshot:')).toBe(false)
    let verifierParsed: any = null
    try {
      if (verifierText.trim().startsWith('{')) verifierParsed = JSON.parse(verifierText)
    } catch {}
    if (verifierParsed) {
      expect(verifierParsed.verdict || verifierParsed.critique).toBeTruthy()
    } else {
      expect(verifierText).toMatch(/Verdict:/)
    }
  }, 1_200_000)
})
