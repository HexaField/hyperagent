import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { runVerifierWorkerLoop } from './agent'

function commandExists(cmd: string): boolean {
  const res = spawnSync('which', [cmd])
  return res.status === 0
}

describe('Verifier/worker collaboration loop', () => {
  it('iterates on a complex graph-feature coding brief', async () => {
    const dir = path.join(process.cwd(), `.tests/agent-integration-${Date.now()}`)
    const exists = commandExists('opencode')
    expect(exists, "Required CLI 'opencode' not found on PATH").toBe(true)

    fs.mkdirSync(dir, { recursive: true })

    fs.writeFileSync(
      path.join(dir, 'opencode.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        permission: {
          edit: 'allow'
        }
      }),
      'utf8'
    )

    const repoRoot = path.join(dir, 'nebula-kanban')
    const boardSrc = path.join(repoRoot, 'packages/board/src')
    const boardTests = path.join(repoRoot, 'packages/board/tests')
    fs.mkdirSync(boardSrc, { recursive: true })
    fs.mkdirSync(boardTests, { recursive: true })

    const scenario = `You are working inside a standalone repository named 'nebula-kanban' with packages/board housing the whiteboard UI.
- Implement a conflict-aware swimlane merge assistant inside packages/board/src/BoardCanvas.tsx that can highlight nodes belonging to overlapping sprints.
- Extend packages/board/src/types.ts so each Swimlane tracks bidirectional adjacency metadata plus a rolling risk index derived from blocked cards.
- Propose a deterministic algorithm (pseudo-code welcome) for reconciling inbound/outbound dependencies across lanes up to depth 3, annotating the canvas with badges.
- Describe the exact Vitest test additions to packages/board/tests/BoardCanvas.test.ts to validate the lane reconciliation logic.
- Stay entirely within the nebula-kanban repo; do not reference or depend on any files from the current hyperagent project.`

    const result = await runVerifierWorkerLoop({
      userInstructions: scenario,
      provider: 'opencode',
      model: 'github-copilot/gpt-5-mini',
      maxRounds: 2,
      sessionDir: dir
    })

    expect(result.bootstrap.round).toBe(0)
    expect(result.bootstrap.parsed.instructions.trim().length).toBeGreaterThan(0)

    expect(result.rounds.length).toBeGreaterThan(0)
    const firstRound = result.rounds[0]
    expect(firstRound.worker.parsed.plan.trim().length).toBeGreaterThan(0)
    expect(firstRound.worker.parsed.work.trim().length).toBeGreaterThan(0)
    expect(firstRound.verifier.parsed.instructions.trim().length).toBeGreaterThan(0)

    expect(['approved', 'failed', 'max-rounds']).toContain(result.outcome)

    expect(fs.existsSync(boardSrc)).toBe(true)
    expect(fs.existsSync(boardTests)).toBe(true)

    const metaPath = path.join(dir, '.hyperagent.json')
    expect(fs.existsSync(metaPath)).toBe(true)
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    expect(Array.isArray(meta.log)).toBe(true)
    const opencodeEntries = meta.log.filter((entry: any) => entry.provider === 'opencode')
    expect(opencodeEntries.length).toBeGreaterThanOrEqual(2)
    for (const entry of opencodeEntries) {
      expect(entry.model).toBe('github-copilot/gpt-5-mini')
      expect(typeof entry.payload).toBe('object')
    }
  }, 600_000)
})
