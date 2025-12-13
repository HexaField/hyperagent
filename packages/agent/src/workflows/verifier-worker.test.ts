import { getWorkflowRunDiff, runAgentWorkflow } from '@hexafield/agent-workflow/agent-orchestrator'
import { RunMeta } from '@hexafield/agent-workflow/provenance'
import { verifierWorkerWorkflowDefinition } from '@hexafield/agent-workflow/workflows'
import type { FileDiff } from '@opencode-ai/sdk'
import { execSync, spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { opencodeTestHooks } from '../opencodeTestHooks'

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

    const response = await runAgentWorkflow(verifierWorkerWorkflowDefinition, {
      user: { instructions: scenario },
      model: model,
      maxRounds: 5,
      sessionDir
    })

    const result = await response.result

    const bootstrap = result.bootstrap!
    expect(bootstrap.round).toBe(0)

    // assert types
    bootstrap.parsed.critique
    bootstrap.parsed.instructions
    bootstrap.parsed.priority
    bootstrap.parsed.verdict

    // assert non-types for strict parsing
    // @ts-expect-error
    bootstrap.parsed.unexpectedField

    expect(bootstrap.parsed.instructions.trim().length).toBeGreaterThan(0)

    expect(result.rounds.length).toBeGreaterThan(0)
    const firstRound = result.rounds[0]
    const workerStep = firstRound.steps.worker
    const verifierStep = firstRound.steps.verifier
    expect(workerStep?.parsed.plan.trim().length).toBeGreaterThan(0)
    expect(workerStep?.parsed.work.trim().length).toBeGreaterThan(0)
    expect(verifierStep?.parsed.instructions.trim().length).toBeGreaterThan(0)

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
        userMessages.some(
          (message) =>
            typeof message.payload?.instructions === 'string' && message.payload.instructions.includes('Hello')
        )
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

    const workerDiffs: FileDiff[] = await getWorkflowRunDiff(response.runId, sessionDir, { role: 'worker' })
    expect(workerDiffs.length).toBeGreaterThan(0)
    const readmeDiff = workerDiffs.find((diff) => diff.file.toLowerCase().includes('readme.md'))
    expect(readmeDiff).toBeTruthy()
    expect(readmeDiff?.after.toLowerCase()).toContain('hello, world')
    const verifierDiffs: FileDiff[] = await getWorkflowRunDiff(response.runId, sessionDir, { role: 'verifier' })
    expect(Array.isArray(verifierDiffs)).toBe(true)
  }, 240_000)
})
