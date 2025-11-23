import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listBranchCommits, listGitBranches } from './git'

async function runGit(args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, { cwd })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(stderr.trim() || `git ${args.join(' ')} failed with code ${code}`))
      }
    })
  })
}

describe('git module helpers', () => {
  let repoDir: string
  let defaultBranch: string

  beforeAll(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-module-test-'))
    await runGit(['init'], repoDir)
    await runGit(['config', 'user.name', 'Hyperagent Tester'], repoDir)
    await runGit(['config', 'user.email', 'tester@example.com'], repoDir)
    await fs.writeFile(path.join(repoDir, 'README.md'), '# Test repo\n')
    await runGit(['add', 'README.md'], repoDir)
    await runGit(['commit', '-m', 'Initial commit'], repoDir)
    await fs.writeFile(path.join(repoDir, 'feature.txt'), 'Feature work\n')
    await runGit(['checkout', '-b', 'feature/test'], repoDir)
    await runGit(['add', 'feature.txt'], repoDir)
    await runGit(['commit', '-m', 'Feature commit'], repoDir)
    await runGit(['checkout', '-'], repoDir)
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repoDir })
      let stdout = ''
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      child.once('error', reject)
      child.once('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim())
        } else {
          reject(new Error('Unable to resolve default branch'))
        }
      })
    })
    defaultBranch = result
  })

  afterAll(async () => {
    if (repoDir) {
      await fs.rm(repoDir, { recursive: true, force: true })
    }
  })

  it('lists git branches for a repository', async () => {
    const branches = await listGitBranches(repoDir)
    expect(branches).toContain(defaultBranch)
    expect(branches).toContain('feature/test')
  })

  it('retrieves commits for a branch with author metadata', async () => {
    const commits = await listBranchCommits({ repoPath: repoDir, branch: defaultBranch, limit: 10 })
    expect(commits.length).toBeGreaterThan(0)
    const latest = commits[0]
    expect(latest.hash).toMatch(/^[0-9a-f]{7,40}$/)
    expect(latest.authorName).toBe('Hyperagent Tester')
    expect(latest.authorEmail).toBe('tester@example.com')
    expect(new Date(latest.timestamp).getTime()).toBeGreaterThan(0)
  })
})
