import { spawnSync } from 'child_process'
import express from 'express'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodingAgentSessionDetail, CodingAgentSessionSummary } from '../../../interfaces/core/codingAgent'
import { createWorkspaceSessionsRouter } from './routes'

const MULTI_AGENT_PERSONA_ID = 'multi-agent'
const TEST_PROMPT = 'You are assisting on a trivial repo. Plan the change then stop.'

const wrapAsync = (h: any) => h

const commandExists = (cmd: string): boolean => {
  const result = spawnSync('which', [cmd])
  return result.status === 0
}

describe('workspace sessions routes — multi-agent opencode integration', () => {
  let tmpRoot = ''
  type LocalOpencodeStorage = {
    rootDir?: string
    listSessions: (opts?: { workspacePath?: string }) => Promise<CodingAgentSessionSummary[]>
    getSession: (sessionId: string) => Promise<CodingAgentSessionDetail | null>
  }

  let storage: LocalOpencodeStorage
  let app: express.Express
  // Local helper to provide the same small FS-backed storage used previously.
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
  beforeEach(async () => {
    const exists = commandExists('opencode')
    expect(exists, "Required CLI 'opencode' not found on PATH").toBe(true)

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ha-multi-agent-int-'))
    process.env.OPENCODE_AGENT_DIR = path.join(tmpRoot, 'agent-personas')
    await fs.mkdir(process.env.OPENCODE_AGENT_DIR, { recursive: true })
    await fs.writeFile(
      path.join(process.env.OPENCODE_AGENT_DIR, `${MULTI_AGENT_PERSONA_ID}.md`),
      `---\nlabel: Multi-Agent Persona\nmode: primary\nmodel: github-copilot/gpt-5-mini\n---\nAct as a multi-agent pair.`,
      'utf8'
    )

    const storageRoot = path.join(tmpRoot, 'opencode-storage')
    storage = createOpencodeStorage({ rootDir: storageRoot })

    const nowIso = new Date().toISOString()
    const mockRunRecord = {
      id: 'noop',
      agents: [],
      log: [],
      createdAt: nowIso,
      updatedAt: nowIso
    }
    const deps = {
      wrapAsync,
      codingAgentRunner: {
        startRun: async () => mockRunRecord,
        listRuns: async () => [],
        getRun: async () => null,
        killRun: async () => false
      },
      codingAgentStorage: storage,
      codingAgentCommandRunner: async () => ({ stdout: '', stderr: '' }),
      ensureWorkspaceDirectory: async (dir: string) => {
        await fs.mkdir(dir, { recursive: true })
      }
    }

    const router = createWorkspaceSessionsRouter(deps)
    app = express()
    app.use(express.json())
    app.use(router)
  })

  afterEach(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true })
      tmpRoot = ''
    }
  })

  const waitForMessageText = async (sessionId: string, role: string, timeoutMs = 240_000): Promise<string> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const detail = await storage.getSession(sessionId)
        const message = detail?.messages.find((msg) => msg.role === role)
        const text = message?.parts?.[0]?.text ?? ''
        if (text && text.trim().length) {
          return text.trim()
        }
      } catch {
        // session not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    throw new Error(`Timed out waiting for ${role} message`)
  }

  it('persists structured worker/verifier messages instead of snapshot placeholders', async () => {
    const sessionDir = path.join(tmpRoot, 'workspace-under-test')
    const resp = await request(app)
      .post('/api/coding-agent/sessions')
      .send({ workspacePath: sessionDir, prompt: TEST_PROMPT, personaId: MULTI_AGENT_PERSONA_ID })

    expect(resp.status).toBe(202)
    const sessionId = resp.body?.run?.sessionId
    expect(typeof sessionId).toBe('string')

    const workerText = await waitForMessageText(sessionId, 'worker')
    expect(workerText.toLowerCase().startsWith('snapshot:')).toBe(false)
    expect(workerText).toMatch(/Status:/)

    const verifierText = await waitForMessageText(sessionId, 'verifier')
    expect(verifierText.toLowerCase().startsWith('snapshot:')).toBe(false)
    expect(verifierText).toMatch(/Verdict:/)
  }, 1_200_000)
})
