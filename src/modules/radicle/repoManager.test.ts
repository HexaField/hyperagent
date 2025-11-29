import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRadicleRepoManager } from './repoManager'

const runGit = (args: string[], cwd: string) => {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

const readGit = (args: string[], cwd: string) => {
  return execFileSync('git', args, { cwd }).toString().trim()
}

const createWorkspaceRepo = async (branch = 'main') => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'radicle-repo-'))
  runGit(['init'], dir)
  runGit(['checkout', '-B', branch], dir)
  runGit(['config', 'user.name', 'Workflow Test'], dir)
  runGit(['config', 'user.email', 'workflow@test.local'], dir)
  await fs.writeFile(path.join(dir, 'README.md'), '# repo\n')
  runGit(['add', '.'], dir)
  runGit(['commit', '-m', 'init'], dir)
  return dir
}

const createBareRemote = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'radicle-remote-'))
  runGit(['init', '--bare'], dir)
  return dir
}

const createRadCliStub = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'radicle-cli-'))
  const logPath = path.join(dir, 'rad-log.txt')
  const binPath = path.join(dir, 'rad')
  const script = `#!/usr/bin/env bash
set -euo pipefail
printf "%s" "$@" >> "${logPath}"
printf "\n" >> "${logPath}"
`
  await fs.writeFile(binPath, script, { mode: 0o755 })
  return { dir, logPath, binPath }
}

const createBranchWithChange = async (repoDir: string, branch: string) => {
  runGit(['checkout', '-B', branch], repoDir)
  await fs.writeFile(path.join(repoDir, 'feature.txt'), `${branch} change\n`)
  runGit(['add', 'feature.txt'], repoDir)
  runGit(['commit', '-m', `update ${branch}`], repoDir)
}

const remoteHasBranch = (remoteDir: string, branch: string): boolean => {
  try {
    const ref = readGit(['--git-dir', remoteDir, 'rev-parse', `refs/heads/${branch}`], process.cwd())
    return Boolean(ref)
  } catch {
    return false
  }
}

describe('createRadicleRepoManager pushBranch', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined))
    )
  })

  it('prefers the rad remote when available even if a different default remote is configured', async () => {
    const repoDir = await createWorkspaceRepo('main')
    const radRemote = await createBareRemote()
    const originRemote = await createBareRemote()
    tempDirs.push(repoDir, radRemote, originRemote)
    runGit(['remote', 'add', 'rad', radRemote], repoDir)
    runGit(['remote', 'add', 'origin', originRemote], repoDir)
    await createBranchWithChange(repoDir, 'wf-rad-preferred')
    const manager = createRadicleRepoManager({ repoPath: repoDir, remote: 'origin' })
    await manager.pushBranch('wf-rad-preferred')
    expect(remoteHasBranch(radRemote, 'wf-rad-preferred')).toBe(true)
    expect(remoteHasBranch(originRemote, 'wf-rad-preferred')).toBe(false)
  })

  it('falls back to the configured remote when rad is missing', async () => {
    const repoDir = await createWorkspaceRepo('main')
    const originRemote = await createBareRemote()
    tempDirs.push(repoDir, originRemote)
    runGit(['remote', 'add', 'origin', originRemote], repoDir)
    await createBranchWithChange(repoDir, 'wf-origin-fallback')
    const manager = createRadicleRepoManager({ repoPath: repoDir, remote: 'origin' })
    await manager.pushBranch('wf-origin-fallback')
    expect(remoteHasBranch(originRemote, 'wf-origin-fallback')).toBe(true)
  })

  it('throws a descriptive error when no remotes exist', async () => {
    const repoDir = await createWorkspaceRepo('main')
    tempDirs.push(repoDir)
    await createBranchWithChange(repoDir, 'wf-no-remote')
    const manager = createRadicleRepoManager({ repoPath: repoDir })
    await expect(manager.pushBranch('wf-no-remote')).rejects.toThrow(/No Git remotes configured/i)
  })

  it('invokes the rad CLI push command when targeting a rad remote', async () => {
    const repoDir = await createWorkspaceRepo('main')
    const radRemote = await createBareRemote()
    const cli = await createRadCliStub()
    tempDirs.push(repoDir, radRemote, cli.dir)
    runGit(['remote', 'add', 'rad', radRemote], repoDir)
    await createBranchWithChange(repoDir, 'wf-rad-cli')
    const manager = createRadicleRepoManager({ repoPath: repoDir, radCliPath: cli.binPath })
    await manager.pushBranch('wf-rad-cli')
    const logLines = (await fs.readFile(cli.logPath, 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    expect(logLines.length).toBeGreaterThan(0)
    expect(logLines[logLines.length - 1]).toBe('push rad wf-rad-cli')
  })
})
