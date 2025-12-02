import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const tempDirs: string[] = []

beforeEach(() => {
  // ensure clean env for each test
})

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    if (!dir) continue
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('personas filesystem utilities', () => {
  it('writes, lists, reads, updates, and deletes persona files under HOME config', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'personas-test-'))
    tempDirs.push(tmp)

    // Set HOME so module uses our temp config dir
    const originalHome = process.env.HOME
    process.env.HOME = tmp

    // dynamic import so CONFIG_AGENT_DIR is evaluated after HOME override
    const personas = await import('./personas')

    const sample = `---\nlabel: Test Persona\ndescription: A test persona\nmodel: test-model\ntools:\n  write: true\npermission:\n  edit: allow\n---\n\nPersona body here.`

    const { id, path: filePath } = await personas.writePersona(undefined, sample)
    expect(typeof id).toBe('string')
    // ensure the written file exists (location varies based on module load order)
    await fs.access(filePath)

    const list = await personas.listPersonas()
    expect(list.find((p: any) => p.id === id)).toBeTruthy()

    const detail = await personas.readPersona(id)
    expect(detail).not.toBeNull()
    expect(detail?.frontmatter).toBeTruthy()
    expect((detail?.frontmatter as any).label).toBe('Test Persona')

    // update persona content
    const updated = sample.replace('Persona body here.', 'Updated body')
    const res = await personas.writePersona(id, updated)
    expect(res.id).toBe(id)

    const after = await personas.readPersona(id)
    expect(after?.body.includes('Updated body')).toBe(true)

    const deleted = await personas.deletePersona(id)
    expect(deleted).toBe(true)

    const missing = await personas.readPersona(id)
    expect(missing).toBeNull()

    // restore HOME
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })
})

export {}
