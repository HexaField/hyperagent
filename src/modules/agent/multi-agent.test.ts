import { execSync, spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { RunMeta } from '../provenance/provenance'
import { getMultiAgentRunDiff, runVerifierWorkerLoop } from './multi-agent'
import { opencodeTestHooks } from './opencodeTestHooks'

function commandExists(cmd: string): boolean {
  const res = spawnSync('which', [cmd])
  return res.status === 0
}

function initGitRepo(directory: string) {
  try {
    execSync('git init', { cwd: directory, stdio: 'ignore' })
    execSync('git config user.email "agent@example.com"', { cwd: directory, stdio: 'ignore' })
    execSync('git config user.name "HyperAgent"', { cwd: directory, stdio: 'ignore' })
    execSync('git add .', { cwd: directory, stdio: 'ignore' })
    execSync('git commit --allow-empty -m "Initialize workspace"', { cwd: directory, stdio: 'ignore' })
  } catch (error) {
    throw new Error(
      `Failed to initialize git workspace in ${directory}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

const model = 'github-copilot/gpt-5-mini'

describe('Verifier/worker collaboration loop', () => {
  opencodeTestHooks()

  it('completes a simple file creation task', async () => {
    const sessionDir = path.join(process.cwd(), `.tests/agent-${Date.now()}`)
    const exists = commandExists('opencode')
    expect(exists, "Required CLI 'opencode' not found on PATH").toBe(true)

    fs.mkdirSync(sessionDir, { recursive: true })

    const opencodeConfig = {
      $schema: 'https://opencode.ai/config.json',
      permission: {
        edit: 'allow',
        bash: 'allow',
        webfetch: 'allow',
        doom_loop: 'allow',
        external_directory: 'deny'
      }
    }
    fs.writeFileSync(path.join(sessionDir, 'opencode.json'), JSON.stringify(opencodeConfig, null, 2))

    initGitRepo(sessionDir)

    const scenario = `Create a readme.md file that includes the text "Hello, world".`

    const response = await runVerifierWorkerLoop({
      userInstructions: scenario,
      model: model,
      maxRounds: 5,
      sessionDir
    })

    const result = await response.result

    console.log('\n\n\n', result)

    expect(result.bootstrap.round).toBe(0)
    expect(result.bootstrap.parsed.instructions.trim().length).toBeGreaterThan(0)

    expect(result.rounds.length).toBeGreaterThan(0)
    const firstRound = result.rounds[0]
    expect(firstRound.worker.parsed.plan.trim().length).toBeGreaterThan(0)
    expect(firstRound.worker.parsed.work.trim().length).toBeGreaterThan(0)
    expect(firstRound.verifier.parsed.instructions.trim().length).toBeGreaterThan(0)

    expect(['approved', 'failed', 'max-rounds']).toContain(result.outcome)

    const hyperagentDir = path.join(sessionDir, '.hyperagent')

    const metaFiles = fs
      .readdirSync(hyperagentDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(hyperagentDir, f))

    expect(metaFiles.length).toBeGreaterThan(0)

    const logs = metaFiles.map((file) => {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as RunMeta
    })

    for (const entry of logs) {
      expect(typeof entry.id).toBe('string')

      expect(entry.agents.length).toBe(2)
      const workerAgent = entry.agents.find((a) => a.role === 'worker')
      const verifierAgent = entry.agents.find((a) => a.role === 'verifier')
      expect(workerAgent?.sessionId).toBeDefined()
      expect(verifierAgent?.sessionId).toBeDefined()

      expect(entry.log.length).toBeGreaterThan(1)
      const workerMessages = entry.log.filter((e) => e.role === 'worker')
      const verifierMessages = entry.log.filter((e) => e.role === 'verifier')
      expect(workerMessages.length).toBeGreaterThan(0)
      expect(verifierMessages.length).toBeGreaterThan(0)
      const userMessages = entry.log.filter((e) => e.role === 'user')
      expect(userMessages.length).toBeGreaterThan(0)
      expect(
        userMessages.some((message) => typeof message.payload?.text === 'string' && message.payload.text.includes('Hello'))
      ).toBe(true)
    }

    const readmeDir = sessionDir
    const foundReadmes = fs
      .readdirSync(readmeDir)
      .filter((f) => f.toLowerCase() === 'readme.md')
      .map((f) => path.join(readmeDir, f))

    expect(foundReadmes.length).toBeGreaterThan(0)
    const readmeContent = fs.readFileSync(foundReadmes[0], 'utf8')
    expect(readmeContent.includes('Hello, world')).toBe(true)

    const workerDiffs = await getMultiAgentRunDiff(response.runId, sessionDir, { role: 'worker' })
    expect(workerDiffs.length).toBeGreaterThan(0)
    const readmeDiff = workerDiffs.find((diff) => diff.file.toLowerCase().includes('readme.md'))
    expect(readmeDiff).toBeTruthy()
    expect(readmeDiff?.after.toLowerCase()).toContain('hello, world')

    const verifierDiffs = await getMultiAgentRunDiff(response.runId, sessionDir, { role: 'verifier' })
    expect(Array.isArray(verifierDiffs)).toBe(true)
  }, 120_000)

  it('records user instructions in multi-agent provenance immediately', async () => {
    vi.resetModules()
    const recordUserMessage = vi.fn()
    const baseMeta = {
      id: 'run-mock',
      agents: [
        { role: 'worker', sessionId: 'worker-session' },
        { role: 'verifier', sessionId: 'verifier-session' }
      ],
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    vi.doMock('../provenance/provenance', () => ({
      createRunMeta: vi.fn(() => baseMeta),
      findLatestRoleDiff: vi.fn(() => null),
      findLatestRoleMessageId: vi.fn(() => null),
      hasRunMeta: vi.fn(() => false),
      loadRunMeta: vi.fn(() => baseMeta),
      saveRunMeta: vi.fn(),
      recordUserMessage
    }))

    const workerSession = { id: 'worker-session', directory: '/tmp/provenance-test' }
    const verifierSession = { id: 'verifier-session', directory: '/tmp/provenance-test' }
    vi.doMock('./opencode', () => ({
      createSession: vi
        .fn()
        .mockResolvedValueOnce(workerSession)
        .mockResolvedValueOnce(verifierSession),
      getSession: vi.fn(async (_dir: string, id: string) => (id === workerSession.id ? workerSession : verifierSession)),
      getSessionDiff: vi.fn().mockResolvedValue([])
    }))

    let verifierCalls = 0
    const invokeStructuredJsonCall = vi.fn(async (args: any) => {
      if (args.role === 'verifier') {
        const payload =
          verifierCalls === 0
            ? { verdict: 'instruct', critique: 'next steps', instructions: 'do work', priority: 3 }
            : { verdict: 'approve', critique: 'done', instructions: '', priority: 1 }
        verifierCalls += 1
        const raw = JSON.stringify(payload)
        const parsed = args.parseResponse ? args.parseResponse(raw) : (payload as any)
        return { raw, parsed }
      }
      const workerPayload = { status: 'working', plan: 'plan', work: 'work', requests: '' }
      const raw = JSON.stringify(workerPayload)
      const parsed = args.parseResponse ? args.parseResponse(raw) : (workerPayload as any)
      return { raw, parsed }
    })

    vi.doMock('./agent', () => ({
      invokeStructuredJsonCall,
      coerceString: (value: unknown) => (typeof value === 'string' ? value : ''),
      parseJsonPayload: (_role: string, res: string) => JSON.parse(res)
    }))

    try {
      const { runVerifierWorkerLoop } = await import('./multi-agent')
      const scenario = 'Plan and execute release notes'
      const run = await runVerifierWorkerLoop({
        userInstructions: scenario,
        sessionDir: '/tmp/provenance-test',
        model: 'test-model',
        maxRounds: 1
      })
      await run.result
      expect(recordUserMessage).toHaveBeenCalledTimes(1)
      expect(recordUserMessage).toHaveBeenCalledWith(run.runId, '/tmp/provenance-test', scenario)
    } finally {
      vi.doUnmock('../provenance/provenance')
      vi.doUnmock('./opencode')
      vi.doUnmock('./agent')
      vi.resetModules()
    }
  })
})
