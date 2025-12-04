import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { runVerifierWorkerLoop } from './agent'
import { getOpencodeServer } from './opencode'

function commandExists(cmd: string): boolean {
  const res = spawnSync('which', [cmd])
  return res.status === 0
}

const model = 'github-copilot/gpt-5-mini'

describe('Verifier/worker collaboration loop', () => {
  afterAll(async () => {
    const server = await getOpencodeServer()
    server.close()
  })

  it('iterates on a complex graph-feature coding brief', async () => {
    const sessionDir = path.join(process.cwd(), `.tests/agent-integration-${Date.now()}`)
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

    const result = await runVerifierWorkerLoop({
      userInstructions: scenario,
      model: model,
      maxRounds: 5,
      sessionDir
    })

    console.log('\n\n\n', result)

    expect(result.bootstrap.round).toBe(0)
    expect(result.bootstrap.parsed.instructions.trim().length).toBeGreaterThan(0)

    expect(result.rounds.length).toBeGreaterThan(0)
    const firstRound = result.rounds[0]
    expect(firstRound.worker.parsed.plan.trim().length).toBeGreaterThan(0)
    expect(firstRound.worker.parsed.work.trim().length).toBeGreaterThan(0)
    expect(firstRound.verifier.parsed.instructions.trim().length).toBeGreaterThan(0)

    expect(['approved', 'failed', 'max-rounds']).toContain(result.outcome)

    const metaDir = path.join(sessionDir, '.hyperagent')
    expect(fs.existsSync(metaDir)).toBe(true)
    const metaFiles = fs.readdirSync(metaDir).filter((file) => file.endsWith('.json'))

    expect(metaFiles.length).toBeGreaterThan(0)
    const logs = metaFiles.flatMap((file) => {
      const meta = JSON.parse(fs.readFileSync(path.join(metaDir, file), 'utf8'))
      return Array.isArray(meta.log) ? meta.log : []
    })
    const opencodeEntries = logs.filter((entry: any) => entry.provider === 'opencode')
    expect(opencodeEntries.length).toBeGreaterThanOrEqual(2)
    for (const entry of opencodeEntries) {
      expect(entry.model).toBe(model)
      expect(typeof entry.payload).toBe('object')
    }

    const readmePath = path.join(sessionDir, 'readme.md')
    expect(fs.existsSync(readmePath)).toBe(true)
    const readmeContent = fs.readFileSync(readmePath, 'utf8')
    expect(readmeContent.includes('Hello, world')).toBe(true)
  }, 60_000)
})
