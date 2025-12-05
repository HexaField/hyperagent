import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { RunMeta } from '../provenance/provenance'
import { opencodeTestHooks } from './opencodeTestHooks'
import runSingleAgentLoop from './single-agent'

function commandExists(cmd: string): boolean {
  const res = spawnSync('which', [cmd])
  return res.status === 0
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

    const scenario = `Create a readme.md file that includes the text "Hello, single agent".`

    const agentRun = await runSingleAgentLoop({
      userInstructions: scenario,
      model: model,
      sessionDir
    })

    const parsed = await agentRun.result
    expect(typeof agentRun.runId).toBe('string')

    expect(typeof parsed).toBe('string')
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
    }
  }, 120_000)
})
