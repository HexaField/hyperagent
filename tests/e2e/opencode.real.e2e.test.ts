import crypto from 'crypto'
import fs from 'fs/promises'
import fetch from 'node-fetch'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import https from 'node:https'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServerApp } from '../../src/server/app'
import opencodeAdapter from '../../src/modules/providers/adapters/opencodeAdapter'
import type { ProviderInvocationContext } from '../../src/modules/providers'

const OPENCODE_SESSION_LIST_PROBES: string[][] = [
  ['session', 'list', '--format', 'json'],
  ['session', 'list']
]

const parseSessionJson = (raw: string): string[] => {
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed?.sessions)) {
      return parsed.sessions.map((entry: any) => entry?.name ?? entry?.session ?? entry?.id).filter(Boolean)
    }
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === 'string')
    }
  } catch {
    // fall through
  }
  return []
}

const parseSessionPlain = (raw: string): string[] =>
  raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

const listOpencodeSessionIds = (cwd: string): string[] => {
  for (const args of OPENCODE_SESSION_LIST_PROBES) {
    try {
      const bin = process.env.OPENCODE_BIN || 'opencode'
      const result = spawnSync(bin, args, { cwd, encoding: 'utf8' })
      if (result.error || (typeof result.status === 'number' && result.status !== 0)) {
        continue
      }
      const stdout = (result.stdout ?? '').toString().trim()
      if (!stdout.length) continue
      const ids = args.includes('--format') ? parseSessionJson(stdout) : parseSessionPlain(stdout)
      if (ids.length) return ids.map((id) => id.toString().trim()).filter(Boolean)
    } catch {
      // try next probe format
    }
  }
  return []
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitForNewSessions = async (sessionDir: string, baseline: string[], minDelta: number): Promise<string[]> => {
  const baselineSet = new Set(baseline)
  const maxDurationMs = 60_000
  const start = Date.now()
  while (Date.now() - start < maxDurationMs) {
    const current = listOpencodeSessionIds(sessionDir)
    const diff = current.filter((id) => !baselineSet.has(id))
    if (diff.length >= minDelta) {
      return diff
    }
    await delay(1_000)
  }
  throw new Error('Timed out waiting for opencode sessions to materialize')
}

const invokeOpencodeAdapter = (ctx: ProviderInvocationContext) => {
  if (!opencodeAdapter.invoke) {
    throw new Error('opencode adapter missing invoke implementation')
  }
  return opencodeAdapter.invoke(ctx)
}

// Real e2e tests split into two `it` blocks. Shared setup/teardown lives in beforeEach/afterEach.
describe('opencode real e2e', () => {
  let tmpBase: string
  let dbFile: string
  const fixtureAgentDir = path.join(process.cwd(), 'tests', 'fixtures', 'opencode-agent')
  let prevAgentDir: string | undefined
  let appServer: any
  let httpsServer: any
  let baseUrl: string
  let workspaceRoot: string
  let repoPath: string
  

  beforeEach(async () => {
    // Resolve opencode binary
    const opencodeBin =
      process.env.OPENCODE_BIN ??
      ((): string | null => {
        try {
          const which = spawnSync('which', ['opencode'])
          if (which.status === 0 && which.stdout) return String(which.stdout).trim()
        } catch {
          return null
        }
        return null
      })()

    if (!opencodeBin) {
      throw new Error(
        'Skipping: `opencode` binary not found on PATH. Install it or set OPENCODE_BIN to run this e2e test.'
      )
    }

    // ensure git is available
    const gitCheck = spawnSync('which', ['git'])
    if (gitCheck.status !== 0) throw new Error('git not available in PATH; required for this e2e test')

    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'hyperagent-e2e-'))
    dbFile = path.join(tmpBase, 'runtime.db')

    // Point tests to the discovered opencode binary so the real CLI is used.
    process.env.OPENCODE_BIN = opencodeBin

    // Point persona directory directly at the fixtures for simplicity
    prevAgentDir = process.env.OPENCODE_AGENT_DIR
    process.env.OPENCODE_AGENT_DIR = fixtureAgentDir

    // Start the real server app with a fresh tmp dir/persistence so it's isolated.
    appServer = await createServerApp({ tmpDir: tmpBase, persistenceFile: dbFile })
    httpsServer = appServer.start(0)
    await once(httpsServer, 'listening')
    const address = httpsServer.address()
    const port = typeof address === 'object' && address ? address.port : null
    if (!port) throw new Error('Unable to determine server port')
    baseUrl = `https://127.0.0.1:${port}`

    // make a temporary git workspace with a minimal opencode config
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyperagent-opencode-workspace-'))
    repoPath = path.join(workspaceRoot, 'repo')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.writeFile(path.join(repoPath, 'README.md'), '# e2e test\n', 'utf8')
    spawnSync('git', ['init'], { cwd: repoPath })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath })
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath })
    spawnSync('git', ['add', '.'], { cwd: repoPath })
    spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: repoPath })

    await fs.writeFile(
      path.join(repoPath, 'opencode.json'),
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          permission: {
            edit: 'allow',
            bash: 'allow',
            webfetch: 'allow',
            doom_loop: 'allow',
            external_directory: 'deny'
          }
        },
        null,
        2
      ),
      'utf8'
    )
  })

  afterEach(async () => {
    try {
      if (appServer && typeof appServer.shutdown === 'function') await appServer.shutdown()
      if (httpsServer) await new Promise<void>((resolve) => httpsServer.close(() => resolve()))
    } catch (err) {
      console.warn('[e2e] error shutting down server', err)
    }

    // restore OPENCODE_AGENT_DIR
    if (prevAgentDir === undefined) delete process.env.OPENCODE_AGENT_DIR
    else process.env.OPENCODE_AGENT_DIR = prevAgentDir

    // cleanup temp dirs
    try {
      const preserve = process.env.PRESERVE_E2E_WORKSPACE === '1'
      if (preserve) {
        console.log('[e2e] PRESERVE_E2E_WORKSPACE set — not removing temp dirs:')
        console.log('[e2e] tmpBase:', tmpBase)
        console.log('[e2e] workspaceRoot:', workspaceRoot)
      } else {
        if (tmpBase) await fs.rm(tmpBase, { recursive: true, force: true })
        if (workspaceRoot) await fs.rm(workspaceRoot, { recursive: true, force: true })
      }
    } catch (err) {
      console.warn('[e2e] cleanup failed', err)
    }
  })

  it('runs single-agent session with real opencode', async () => {
    const agent = new https.Agent({ rejectUnauthorized: false })

    // Single-agent run (no persona) — exercise codingAgentRunner.startRun -> opencode CLI
    const startRes1 = await fetch(`${baseUrl}/api/coding-agent/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePath: repoPath, prompt: 'Run e2e single-agent test' }),
      agent
    })
    expect(startRes1.status).toBe(202)
    const startPayload1 = await startRes1.json()
    const run1 = startPayload1?.run
    if (!run1 || !run1.sessionId) throw new Error('Single-agent run did not return sessionId')
    console.log('[e2e] single-agent sessionId:', run1.sessionId)

    // Ensure the run appears in the runs list
    const runStart = Date.now()
    while (Date.now() - runStart < 60_000) {
      const runsRes = await fetch(`${baseUrl}/api/coding-agent/runs`, { agent })
      expect(runsRes.status).toBe(200)
      const runsPayload = await runsRes.json()
      const runs = runsPayload.runs ?? []
      if (runs.some((r: any) => r.sessionId === run1.sessionId)) break
      await new Promise((r) => setTimeout(r, 500))
    }

    // Verify the opencode runner log contains the emitted session id (more reliable than `opencode session list`)
    const waitForLogContains = async (logPath: string, text: string, timeoutMs = 60_000) => {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        try {
          const content = await fs.readFile(logPath, 'utf8')
          if (content.includes(text)) return true
        } catch {
          // ignore until file exists
        }
        await delay(500)
      }
      return false
    }

    if (!run1.logFile || typeof run1.logFile !== 'string') {
      throw new Error('Run record missing logFile; cannot verify opencode session output')
    }

    const logContains = await waitForLogContains(run1.logFile, run1.sessionId, 60_000)
    if (!logContains) {
      const sample = await fs.readFile(run1.logFile, 'utf8').catch(() => '')
      console.error('[e2e] opencode run log (sample):', sample.slice(0, 2000))
    }
    expect(logContains).toBe(true)
  }, 180_000)

  it('runs multi-agent session (persona) with real opencode', async () => {
    const agent = new https.Agent({ rejectUnauthorized: false })
    const baselineSessions = listOpencodeSessionIds(repoPath)

    // Multi-agent run (persona 'multi-agent') — should copy persona and run verifier/worker
    const startRes2 = await fetch(`${baseUrl}/api/coding-agent/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePath: repoPath, prompt: 'Run e2e multi-agent test', personaId: 'multi-agent' }),
      agent
    })
    expect([200, 202]).toContain(startRes2.status)
    const startText2 = await startRes2.text()
    let sessionId: string | null = null
    if (startRes2.status === 202) {
      const payload = JSON.parse(startText2)
      sessionId = payload?.run?.sessionId ?? null
    } else if (startRes2.status === 200) {
      try {
        const payload = JSON.parse(startText2)
        sessionId = payload?.run?.sessionId ?? payload?.session?.id ?? null
      } catch {
        sessionId = null
      }
    }
    if (!sessionId) throw new Error('Unable to determine sessionId for multi-agent run')
    console.log('[e2e] multi-agent sessionId:', sessionId)

    // Verify persona file was copied into the workspace
    const copiedPersonaPath = path.join(repoPath, '.opencode', 'agent', 'multi-agent.md')
    const expectedPersonaPath = path.join(fixtureAgentDir, 'multi-agent.md')
    const [copiedExists, expectedExists] = await Promise.all([
      fs
        .stat(copiedPersonaPath)
        .then(() => true)
        .catch(() => false),
      fs
        .stat(expectedPersonaPath)
        .then(() => true)
        .catch(() => false)
    ])
    if (!expectedExists) throw new Error(`Fixture persona missing: ${expectedPersonaPath}`)
    if (!copiedExists) throw new Error(`Persona was not copied into workspace: ${copiedPersonaPath}`)
    const [copiedContent, expectedContent] = await Promise.all([
      fs.readFile(copiedPersonaPath, 'utf8'),
      fs.readFile(expectedPersonaPath, 'utf8')
    ])
    if (copiedContent.trim() !== expectedContent.trim()) throw new Error('Persona content mismatch')

    // Poll session detail until we see messages from both worker and verifier
    const seen = { worker: false, verifier: false }
    const sessionStart = Date.now()
    while (Date.now() - sessionStart < 160_000) {
      const detailRes = await fetch(`${baseUrl}/api/coding-agent/sessions/${encodeURIComponent(sessionId)}`, {
        agent
      })
      if (detailRes.status === 200) {
        const detail = await detailRes.json()
        const messages = Array.isArray(detail.messages) ? detail.messages : []
        for (const m of messages) {
          const role = (m.role || m.roleId || m.roleLabel || '').toString().toLowerCase()
          if (role.includes('worker')) seen.worker = true
          if (role.includes('verifier')) seen.verifier = true
        }
        if (seen.worker && seen.verifier) {
          console.log('[e2e] saw both agent roles in session messages')
          break
        }
      }
      await new Promise((r) => setTimeout(r, 500))
    }

    expect(seen.worker).toBe(true)
    expect(seen.verifier).toBe(true)

    const newSessions = await waitForNewSessions(repoPath, baselineSessions, 2)
    expect(newSessions.some((id) => id.includes('worker'))).toBe(true)
    expect(newSessions.some((id) => id.includes('verifier'))).toBe(true)
  }, 180_000)

  it('rejects missing opencode sessions when invoked directly', async () => {
    const missingSessionId = `ses-missing-${crypto.randomUUID().slice(0, 8)}`
    const ctx: ProviderInvocationContext = {
      providerId: 'opencode',
      systemPrompt: 'Ensure session validation fires before LLM invocation',
      userPrompt: 'ping',
      combinedPrompt: 'Ensure session validation fires before LLM invocation\nping',
      modelId: 'github-copilot/gpt-4o-mini',
      sessionId: missingSessionId,
      sessionDir: repoPath
    }

    const existingSessions = listOpencodeSessionIds(repoPath)
    expect(existingSessions).not.toContain(missingSessionId)

    await expect(invokeOpencodeAdapter(ctx)).rejects.toThrowError(/Opencode session ".+" not found or unavailable\.|Resource not found:/)
  }, 30_000)
})
