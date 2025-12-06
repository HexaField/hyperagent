import type { FileDiff } from '@opencode-ai/sdk'
import { execSync, spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { RunMeta } from '../provenance/provenance'
import { getWorkflowRunDiff, runAgentWorkflow } from './agent-orchestrator'
import { opencodeTestHooks } from './opencodeTestHooks'
import { singleAgentWorkflowDefinition } from './workflows'

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

describe('Single agent loop', () => {
  opencodeTestHooks()

  it('creates provenance and runs at least one agent turn', async () => {
    const sessionDir = path.join(process.cwd(), `.tests/single-agent-${Date.now()}`)
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

    const scenario = `Create a readme.md file that includes the text "Hello, single agent".`

    const agentRun = await runAgentWorkflow(singleAgentWorkflowDefinition, {
      userInstructions: scenario,
      model: model,
      sessionDir
    })

    const parsed = await agentRun.result
    expect(typeof agentRun.runId).toBe('string')

    expect(parsed.rounds.length).toBeGreaterThan(0)
    const firstRound = parsed.rounds[0]
    const agentStep = firstRound?.steps.agent
    expect(agentStep).toBeDefined()
    expect(typeof agentStep?.raw).toBe('string')
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

      expect(entry.agents.length).toBe(1)
      const agent = entry.agents.find((a) => a.role === 'agent')
      expect(agent?.sessionId).toBeDefined()

      expect(entry.log.length).toBeGreaterThan(0)
      const agentMessages = entry.log.filter((e) => e.role === 'agent')
      expect(agentMessages.length).toBeGreaterThan(0)
      const userMessages = entry.log.filter((e) => e.role === 'user')
      expect(userMessages.length).toBeGreaterThan(0)
      expect(
        userMessages.some(
          (message) => typeof message.payload?.text === 'string' && message.payload.text.includes('Hello')
        )
      ).toBe(true)
    }

    const diffs: FileDiff[] = await getWorkflowRunDiff(agentRun.runId, sessionDir, { role: 'agent' })
    expect(diffs.length).toBeGreaterThan(0)
    const readmeDiff = diffs.find((diff) => diff.file.toLowerCase().includes('readme.md'))
    expect(readmeDiff).toBeTruthy()
    expect(readmeDiff?.after.toLowerCase()).toContain('hello, single agent')
  }, 120_000)

  it('records user instructions in provenance immediately', async () => {
    vi.resetModules()
    const recordUserMessage = vi.fn()
    const mockMeta = {
      id: 'run-mock',
      agents: [{ role: 'agent', sessionId: 'session-mock' }],
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    vi.doMock('../provenance/provenance', () => ({
      createRunMeta: vi.fn(() => mockMeta),
      findLatestRoleDiff: vi.fn(() => null),
      findLatestRoleMessageId: vi.fn(() => null),
      hasRunMeta: vi.fn(() => false),
      loadRunMeta: vi.fn(() => mockMeta),
      saveRunMeta: vi.fn(),
      recordUserMessage
    }))

    const mockSession = { id: 'session-mock', directory: '/tmp/provenance-test' }
    vi.doMock('./opencode', () => ({
      createSession: vi.fn().mockResolvedValue(mockSession),
      getSession: vi.fn().mockResolvedValue(mockSession),
      getSessionDiff: vi.fn().mockResolvedValue([])
    }))

    vi.doMock('./agent', () => ({
      invokeStructuredJsonCall: vi.fn().mockResolvedValue({ raw: '{}', parsed: {} }),
      parseJsonPayload: () => () => ({}),
      configureWorkflowParsers: (registry: Record<string, unknown>) => registry
    }))

    try {
      const { runAgentWorkflow: mockedRunAgentWorkflow } = await import('./agent-orchestrator')
      const { singleAgentWorkflowDefinition: workflowDefinition } = await import('./workflows')
      const scenario = 'Document the onboarding experience'
      const run = await mockedRunAgentWorkflow(workflowDefinition, {
        userInstructions: scenario,
        sessionDir: '/tmp/provenance-test',
        model: 'test-model'
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
