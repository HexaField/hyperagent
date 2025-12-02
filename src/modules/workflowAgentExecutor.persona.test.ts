import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const tmpDirs: string[] = []
let originalHome: string | undefined

beforeEach(() => {
  originalHome = process.env.HOME
})

afterEach(async () => {
  // restore HOME
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome

  while (tmpDirs.length) {
    const d = tmpDirs.pop()
    if (!d) continue
    await fs.rm(d, { recursive: true, force: true })
  }
})

describe('ensureProviderConfig persona integration', () => {
  it('copies persona into session and merges tools/permission into opencode.json', async () => {
    // Arrange: create fake HOME and persona file
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-home-'))
    tmpDirs.push(fakeHome)
    process.env.HOME = fakeHome

    const personaDir = path.join(fakeHome, '.config', 'opencode', 'agent')
    await fs.mkdir(personaDir, { recursive: true })
    const personaId = 'unit-tester'
    const personaMd = `---\nmodel: github-copilot/gpt-5-mini\ntools:\n  write: true\n  edit: false\npermission:\n  edit: deny\n  bash: ask\n---\n\nPersona body text.`
    await fs.writeFile(path.join(personaDir, `${personaId}.md`), personaMd, 'utf8')

    // Arrange: create session dir
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-'))
    tmpDirs.push(sessionDir)

    // Act: import and call ensureProviderConfig (dynamic import to pick up HOME)
    const mod = await import('./workflowAgentExecutor')
    await mod.ensureProviderConfig(sessionDir, 'opencode', personaId)

    // Assert: persona file copied
    const dstPath = path.join(sessionDir, '.opencode', 'agent', `${personaId}.md`)
    const copied = await fs.readFile(dstPath, 'utf8')
    expect(copied).toContain('Persona body text.')

    // Assert: opencode.json merged
    const configRaw = await fs.readFile(path.join(sessionDir, 'opencode.json'), 'utf8')
    const cfg = JSON.parse(configRaw)
    expect(cfg).toBeTruthy()
    expect(cfg.tools?.write).toBe(true)
    expect(cfg.tools?.edit === false || cfg.tools?.edit === 'false' ? true : cfg.tools?.edit === false).toBeTruthy()
    expect(cfg.permission?.edit).toBe('deny')
    expect(cfg.permission?.bash).toBe('ask')
  })
})

export {}
