import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProjectRecord } from '../projects'
import { createDiffModule } from './diff'
import type { PullRequestRecord } from './types'

async function runGit(args: string[], cwd: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(new Error(stderr.trim() || `git ${args.join(' ')} failed with code ${code}`))
      }
    })
  })
}

describe('review diff module', () => {
  let repoDir: string
  let defaultBranch: string

  beforeAll(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-diff-module-'))
    await runGit(['init'], repoDir)
    await runGit(['config', 'user.name', 'Diff Tester'], repoDir)
    await runGit(['config', 'user.email', 'diff@test'], repoDir)
    await fs.writeFile(path.join(repoDir, 'README.md'), 'Initial docs\n')
    await fs.writeFile(path.join(repoDir, 'notes.txt'), 'Legacy note\n')
    await runGit(['add', 'README.md', 'notes.txt'], repoDir)
    await runGit(['commit', '-m', 'base commit'], repoDir)
    defaultBranch = (await runGit(['symbolic-ref', '--short', 'HEAD'], repoDir)).trim()

    await runGit(['checkout', '-b', 'feature/review'], repoDir)
    await fs.writeFile(path.join(repoDir, 'README.md'), 'Initial docs\nUpdated content\n')
    await fs.mkdir(path.join(repoDir, 'docs'), { recursive: true })
    await runGit(['mv', 'notes.txt', 'docs/notes-archive.txt'], repoDir)
    await fs.writeFile(path.join(repoDir, 'new-file.ts'), 'export const flag = true\n')
    await runGit(['add', 'README.md', 'docs/notes-archive.txt', 'new-file.ts'], repoDir)
    await runGit(['commit', '-m', 'feature changes'], repoDir)
  })

  afterAll(async () => {
    if (repoDir) {
      await fs.rm(repoDir, { recursive: true, force: true })
    }
  })

  it('parses renamed, added, and modified files between branches', async () => {
    const diffModule = createDiffModule()
    const project: ProjectRecord = {
      id: 'proj-1',
      name: 'Diff Test Project',
      description: null,
      repositoryPath: repoDir,
      repositoryProvider: 'git',
      defaultBranch,
      createdAt: new Date().toISOString()
    }
    const pullRequest: PullRequestRecord = {
      id: 'pr-1',
      projectId: project.id,
      title: 'Test diff parsing',
      description: null,
      sourceBranch: 'feature/review',
      targetBranch: defaultBranch,
      radiclePatchId: null,
      status: 'open',
      authorUserId: 'user-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mergedAt: null,
      closedAt: null
    }

    const diff = await diffModule.getPullRequestDiff(pullRequest, project)
    expect(diff.length).toBeGreaterThanOrEqual(2)

    const byPath = new Map(diff.map((file) => [file.path, file]))
    expect(byPath.get('new-file.ts')?.status).toBe('added')
    expect(byPath.get('README.md')?.status).toBe('modified')

    const renamed = diff.find((file) => file.status === 'renamed')
    expect(renamed?.previousPath).toBe('notes.txt')
    expect(renamed?.path.endsWith('docs/notes-archive.txt')).toBe(true)

    const readme = byPath.get('README.md')
    expect(readme).toBeDefined()
    const readmeHunk = readme?.hunks[0]
    expect(readmeHunk?.lines.some((line) => line.type === 'added')).toBe(true)
  })
})
