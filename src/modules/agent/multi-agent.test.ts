import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { RunMeta } from '../provenance/provenance'
import { runVerifierWorkerLoop } from './multi-agent'
import { opencodeTestHooks } from './opencodeTestHooks'

function commandExists(cmd: string): boolean {
  const res = spawnSync('which', [cmd])
  return res.status === 0
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
    }

    const readmeDir = sessionDir
    const foundReadmes = fs
      .readdirSync(readmeDir)
      .filter((f) => f.toLowerCase() === 'readme.md')
      .map((f) => path.join(readmeDir, f))

    expect(foundReadmes.length).toBeGreaterThan(0)
    const readmeContent = fs.readFileSync(foundReadmes[0], 'utf8')
    expect(readmeContent.includes('Hello, world')).toBe(true)
  }, 120_000)
})
