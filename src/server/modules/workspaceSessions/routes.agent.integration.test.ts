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

    // Support two fixture layouts: legacy `runs/*.json` files, and the
    // opencode SDK on-disk layout under `storage/session` + `storage/message` + `storage/part`.
    const runsDir = path.join(rootDir, 'runs')
    const storageSessionDir = path.join(rootDir, 'storage', 'session')

    async function listSessionsFromRuns(): Promise<CodingAgentSessionSummary[]> {
      try {
        const entries = await fs.readdir(runsDir, { withFileTypes: true })
        const files = entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => path.join(runsDir, e.name))
        const sessions: CodingAgentSessionSummary[] = []
        for (const file of files) {
          try {
            const raw = await fs.readFile(file, 'utf8')
            const parsed = JSON.parse(raw)
            if (parsed && parsed.session) sessions.push(parsed.session as CodingAgentSessionSummary)
          } catch {}
        }
        return sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      } catch {
        return []
      }
    }

    async function listSessionsFromStorageDir(): Promise<CodingAgentSessionSummary[]> {
      try {
        const projectDirs = await fs.readdir(storageSessionDir, { withFileTypes: true })
        const sessions: CodingAgentSessionSummary[] = []
        for (const proj of projectDirs) {
          if (!proj.isDirectory()) continue
          const projPath = path.join(storageSessionDir, proj.name)
          const files = await fs.readdir(projPath)
          for (const f of files) {
            if (!f.endsWith('.json')) continue
            try {
              const raw = await fs.readFile(path.join(projPath, f), 'utf8')
              const parsed = JSON.parse(raw)
              const summary: CodingAgentSessionSummary = {
                id: parsed.id,
                title: parsed.title ?? null,
                workspacePath: parsed.directory ?? '',
                projectId: parsed.projectID ?? parsed.projectId ?? proj.name,
                createdAt: new Date((parsed.time?.created ?? Date.now())).toISOString(),
                updatedAt: new Date((parsed.time?.updated ?? Date.now())).toISOString(),
                summary: parsed.summary ?? { additions: 0, deletions: 0, files: 0 }
              }
              sessions.push(summary)
            } catch {}
          }
        }
        return sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      } catch {
        return []
      }
    }

    async function getSessionFromStorage(sessionId: string): Promise<CodingAgentSessionDetail | null> {
      try {
        // locate session metadata
        let sessionMeta: any = null
        const projectDirs = await fs.readdir(storageSessionDir, { withFileTypes: true })
        for (const proj of projectDirs) {
          if (!proj.isDirectory()) continue
          const projPath = path.join(storageSessionDir, proj.name)
          const candidate = path.join(projPath, `${sessionId}.json`)
          try {
            const raw = await fs.readFile(candidate, 'utf8')
            sessionMeta = JSON.parse(raw)
            break
          } catch {}
        }
        if (!sessionMeta) return null
        const summary: CodingAgentSessionSummary = {
          id: sessionMeta.id,
          title: sessionMeta.title ?? null,
          workspacePath: sessionMeta.directory ?? '',
          projectId: sessionMeta.projectID ?? sessionMeta.projectId ?? null,
          createdAt: new Date((sessionMeta.time?.created ?? Date.now())).toISOString(),
          updatedAt: new Date((sessionMeta.time?.updated ?? Date.now())).toISOString(),
          summary: sessionMeta.summary ?? { additions: 0, deletions: 0, files: 0 }
        }

        // load messages and parts
        const messagesDir = path.join(rootDir, 'storage', 'message', sessionId)
        const partDirRoot = path.join(rootDir, 'storage', 'part')
        const messages: any[] = []
        try {
          const msgFiles = await fs.readdir(messagesDir)
          for (const mf of msgFiles) {
            if (!mf.endsWith('.json')) continue
            try {
              const raw = await fs.readFile(path.join(messagesDir, mf), 'utf8')
              const m = JSON.parse(raw)
              // load parts for this message
              const partsDir = path.join(partDirRoot, mf.replace('.json', ''))
              const parts: any[] = []
              try {
                const partFiles = await fs.readdir(partsDir)
                for (const pf of partFiles) {
                  if (!pf.endsWith('.json')) continue
                  try {
                    const pr = JSON.parse(await fs.readFile(path.join(partsDir, pf), 'utf8'))
                    const part: any = { id: pr.id, type: pr.type }
                    if (pr.text) part.text = pr.text
                    parts.push(part)
                  } catch {}
                }
              } catch {}
              messages.push({
                id: m.id,
                role: m.role,
                createdAt: new Date((m.time?.created ?? Date.now())).toISOString(),
                completedAt: m.time?.completed ? new Date(m.time.completed).toISOString() : null,
                modelId: m.modelID ?? null,
                providerId: m.providerID ?? null,
                text: parts.map((p) => p.text ?? '').join('\n'),
                parts
              })
            } catch {}
          }
        } catch {}

        return { session: summary, messages }
      } catch {
        return null
      }
    }

    return {
      rootDir,
      listSessions: async ({ workspacePath } = {}) => {
        // prefer opencode SDK layout if present
        try {
          const stat = await fs.stat(storageSessionDir)
          if (stat && stat.isDirectory()) {
            const sessions = await listSessionsFromStorageDir()
            return workspacePath ? sessions.filter((s) => s.workspacePath === workspacePath) : sessions
          }
        } catch {}
        return await listSessionsFromRuns()
      },
      getSession: async (sessionId: string) => {
        const detail = await getSessionFromStorage(sessionId)
        if (detail) return detail
        // fallback to runs layout
        try {
          const raw = await fs.readFile(path.join(runsDir, `${sessionId}.json`), 'utf8')
          return JSON.parse(raw) as CodingAgentSessionDetail
        } catch {
          return null
        }
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
