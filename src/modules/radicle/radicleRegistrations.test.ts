import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { createPersistence } from '../database'

const createSymlinkFor = async (target: string): Promise<string> => {
  const linkPath = path.join(os.tmpdir(), `hyperagent-rad-link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await fs.symlink(target, linkPath, 'dir')
  return linkPath
}

describe('radicle registrations repository', () => {
  const cleanupPaths: string[] = []

  const registerCleanup = (entry: string) => cleanupPaths.push(entry)

  const cleanup = async () => {
    while (cleanupPaths.length) {
      const entry = cleanupPaths.pop()
      if (!entry) continue
      await fs.rm(entry, { recursive: true, force: true })
    }
  }

  it('canonicalizes repository paths to avoid duplicate registrations', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyperagent-rad-reg-'))
    registerCleanup(repoDir)
    const symlinkPath = await createSymlinkFor(repoDir)
    registerCleanup(symlinkPath)
    const persistence = createPersistence({ file: ':memory:' })
    try {
      persistence.radicleRegistrations.upsert({ repositoryPath: repoDir, name: 'alpha' })
      persistence.radicleRegistrations.upsert({ repositoryPath: symlinkPath, name: 'beta' })
      const records = persistence.radicleRegistrations.list()
      expect(records).toHaveLength(1)
      const canonicalPath = await fs.realpath(repoDir)
      expect(records[0]?.repositoryPath).toBe(canonicalPath)
      expect(records[0]?.name).toBe('beta')
    } finally {
      persistence.db.close()
      await cleanup()
    }
  })

  it('deduplicates existing rows when the repository initializes', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyperagent-rad-reg-db-'))
    registerCleanup(tmpRoot)
    const dbPath = path.join(tmpRoot, 'rad.db')
    const repoDir = await fs.mkdtemp(path.join(tmpRoot, 'repo-'))
    registerCleanup(repoDir)
    const symlinkPath = await createSymlinkFor(repoDir)
    registerCleanup(symlinkPath)
    const canonicalPath = await fs.realpath(repoDir)

    const initial = createPersistence({ file: dbPath })
    initial.db
      .prepare(
        `INSERT INTO radicle_registrations (repository_path, name, description, visibility, default_branch, registered_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(canonicalPath, 'primary', null, 'private', 'main', '2025-01-01T00:00:00.000Z')
    initial.db
      .prepare(
        `INSERT INTO radicle_registrations (repository_path, name, description, visibility, default_branch, registered_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(symlinkPath, 'alias', null, 'private', 'main', '2025-02-01T00:00:00.000Z')
    initial.db.close()

    const reopened = createPersistence({ file: dbPath })
    try {
      const records = reopened.radicleRegistrations.list()
      expect(records).toHaveLength(1)
      expect(records[0]?.repositoryPath).toBe(canonicalPath)
      expect(records[0]?.name).toBe('alias')
    } finally {
      reopened.db.close()
      await cleanup()
    }
  })
})
