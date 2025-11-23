import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRadicleModule } from './index'

const RAD_STUB_ID = 'ztestrid1234'

type StubLogEntry = {
  command: string
  cwd: string
  args: string[]
}

const readStubLogEntries = async (logFile?: string): Promise<StubLogEntry[]> => {
  if (!logFile) return []
  try {
    const raw = await fs.readFile(logFile, 'utf-8')
    const trimmed = raw.trim()
    if (!trimmed.length) {
      return []
    }
    return trimmed.split('\n').map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

const countCommandForRepo = async (logFile: string | undefined, command: string, repoDir: string): Promise<number> => {
  const entries = await readStubLogEntries(logFile)
  return entries.filter((entry) => entry.command === command && entry.cwd === repoDir).length
}

const writeRadStub = async () => {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyper-rad-bin-'))
  const scriptPath = path.join(binDir, 'rad')
  const script = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const cwd = process.cwd()
const marker = path.join(cwd, '.radicle')
const metadataFile = path.join(cwd, '.radicle-stub.json')
const logFile = process.env.HYPER_RADICLE_STUB_LOG
if (!logFile) {
  process.stderr.write("HYPER_RADICLE_STUB_LOG not set\\n")
  process.exit(1)
}
const appendLog = (entry) => {
  if (!logFile) return
  try {
    fs.appendFileSync(logFile, JSON.stringify(entry) + "\\n")
  } catch (error) {
    // ignore logging problems
  }
}
const respond = (message = '') => { process.stdout.write(message); process.exit(0) }
const fail = (message = '') => { process.stderr.write(message); process.exit(1) }
if (!args.length) fail('Missing command')
if (args[0] === 'init') {
  const getFlag = (flag) => {
    const index = args.indexOf(flag)
    return index >= 0 ? args[index + 1] : undefined
  }
  const requireFlag = (flag) => {
    const value = getFlag(flag)
    if (!value) {
      fail('Missing ' + flag)
    }
    return value
  }
  const payload = {
    name: requireFlag('--name'),
    description: (() => {
      const value = getFlag('--description')
      return value === undefined ? '' : value
    })(),
    defaultBranch: requireFlag('--default-branch'),
    visibility: args.includes('--public') ? 'public' : 'private'
  }
  fs.writeFileSync(marker, 'initialized')
  fs.writeFileSync(metadataFile, JSON.stringify(payload))
  appendLog({ command: 'init', cwd, args })
  respond('initialized')
}
  if (args[0] === 'inspect') {
  if (!fs.existsSync(marker)) {
    fail('No Radicle project found')
  }
  appendLog({ command: 'inspect', cwd, args })
  if (args.includes('--json')) {
      respond(JSON.stringify({ rid: '${RAD_STUB_ID}', urn: 'rad:${RAD_STUB_ID}' }))
  } else {
    respond('Radicle project info')
  }
}
fail('Unsupported command')
`
  await fs.writeFile(scriptPath, script, { mode: 0o755 })
  return { binDir, scriptPath }
}

const runGit = (
  args: string[],
  cwd: string,
  options: { stdio?: 'ignore' | 'inherit' | 'pipe' } = { stdio: 'ignore' }
) => {
  execFileSync('git', args, { cwd, stdio: options.stdio ?? 'ignore' })
}

const readGit = (args: string[], cwd: string) => {
  return execFileSync('git', args, { cwd }).toString().trim()
}

const createGitRepo = async (branch = 'main') => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyper-rad-git-'))
  const realDir = await fs.realpath(dir)
  runGit(['init'], realDir)
  runGit(['checkout', '-B', branch], realDir)
  runGit(['config', 'user.name', 'Hyper Test'], realDir)
  runGit(['config', 'user.email', 'hyper@test.local'], realDir)
  await fs.writeFile(path.join(realDir, 'README.md'), '# temp repo\n')
  runGit(['add', '.'], realDir)
  runGit(['commit', '-m', 'init'], realDir)
  return realDir
}

const createGitRepoWithoutCommit = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyper-rad-empty-'))
  const realDir = await fs.realpath(dir)
  runGit(['init'], realDir)
  runGit(['config', 'user.name', 'Hyper Test'], realDir)
  runGit(['config', 'user.email', 'hyper@test.local'], realDir)
  return realDir
}

describe('registerRepository', () => {
  let originalPath: string | undefined
  let binDir: string
  let logDir: string | undefined
  let logFile: string | undefined
  const tempRepos: string[] = []

  beforeAll(async () => {
    originalPath = process.env.PATH
    const stub = await writeRadStub()
    binDir = stub.binDir
    process.env.PATH = `${stub.binDir}${path.delimiter}${process.env.PATH ?? ''}`
    logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyper-rad-log-'))
    logFile = path.join(logDir, 'log.jsonl')
    await fs.writeFile(logFile, '')
    process.env.HYPER_RADICLE_STUB_LOG = logFile
  })

  afterAll(async () => {
    process.env.PATH = originalPath
    delete process.env.HYPER_RADICLE_STUB_LOG
    if (binDir) {
      await fs.rm(binDir, { recursive: true, force: true })
    }
    if (logDir) {
      await fs.rm(logDir, { recursive: true, force: true })
    }
    await Promise.all(tempRepos.map((dir) => fs.rm(dir, { recursive: true, force: true })))
  })

  it('registers a git repository and adds rad remote', async () => {
    if (!logFile) throw new Error('Stub log file not configured')
    const repoDir = await createGitRepo('main')
    tempRepos.push(repoDir)
    const radicle = createRadicleModule({ defaultRemote: 'origin' })
    const result = await radicle.registerRepository({
      repositoryPath: repoDir,
      name: 'Demo Repo',
      visibility: 'public'
    })
    expect(result.registered).toBe(true)
    expect(result.radicleProjectId).toBe(RAD_STUB_ID)
    const remoteUrl = readGit(['config', '--get', 'remote.rad.url'], repoDir)
    expect(remoteUrl).toContain(RAD_STUB_ID)
    const stubMetadataRaw = await fs.readFile(path.join(repoDir, '.radicle-stub.json'), 'utf-8')
    const metadata = JSON.parse(stubMetadataRaw)
    expect(metadata.defaultBranch).toBe('main')
    expect(metadata.visibility).toBe('public')
    const initCount = await countCommandForRepo(logFile, 'init', repoDir)
    expect(initCount).toBeGreaterThan(0)
    const inspectCount = await countCommandForRepo(logFile, 'inspect', repoDir)
    expect(inspectCount).toBeGreaterThan(0)
    await radicle.cleanup()
  })

  it('uses the current branch as the default branch when registering', async () => {
    const repoDir = await createGitRepo('dev')
    tempRepos.push(repoDir)
    const radicle = createRadicleModule({ defaultRemote: 'origin' })
    await radicle.registerRepository({ repositoryPath: repoDir, name: 'Dev Repo' })
    const stubMetadataRaw = await fs.readFile(path.join(repoDir, '.radicle-stub.json'), 'utf-8')
    const metadata = JSON.parse(stubMetadataRaw)
    expect(metadata.defaultBranch).toBe('dev')
    expect(metadata.visibility).toBe('private')
    const remoteUrl = readGit(['config', '--get', 'remote.rad.url'], repoDir)
    expect(remoteUrl).toContain(RAD_STUB_ID)
    await radicle.cleanup()
  })

  it('skips rad init once the repository is already registered', async () => {
    if (!logFile) throw new Error('Stub log file not configured')
    const repoDir = await createGitRepo('feature')
    tempRepos.push(repoDir)
    const radicle = createRadicleModule({ defaultRemote: 'origin' })
    const initialInitCount = await countCommandForRepo(logFile, 'init', repoDir)
    const initialInspectCount = await countCommandForRepo(logFile, 'inspect', repoDir)
    await radicle.registerRepository({ repositoryPath: repoDir, name: 'Feature Repo' })
    const afterFirstInit = await countCommandForRepo(logFile, 'init', repoDir)
    const afterFirstInspect = await countCommandForRepo(logFile, 'inspect', repoDir)
    expect(afterFirstInit).toBe(initialInitCount + 1)
    expect(afterFirstInspect).toBe(initialInspectCount + 1)
    await radicle.registerRepository({ repositoryPath: repoDir, name: 'Feature Repo Again' })
    const afterSecondInit = await countCommandForRepo(logFile, 'init', repoDir)
    const afterSecondInspect = await countCommandForRepo(logFile, 'inspect', repoDir)
    expect(afterSecondInit).toBe(afterFirstInit)
    expect(afterSecondInspect).toBe(afterFirstInspect + 1)
    const remoteUrl = readGit(['config', '--get', 'remote.rad.url'], repoDir)
    expect(remoteUrl).toContain(RAD_STUB_ID)
    await radicle.cleanup()
  })

  it('creates an empty initial commit when the repository has no commits', async () => {
    if (!logFile) throw new Error('Stub log file not configured')
    const repoDir = await createGitRepoWithoutCommit()
    tempRepos.push(repoDir)
    const radicle = createRadicleModule({ defaultRemote: 'origin' })
    await radicle.registerRepository({ repositoryPath: repoDir, name: 'Empty Repo' })
    const latestMessage = readGit(['log', '-1', '--pretty=%s'], repoDir)
    expect(latestMessage).toBe('Initial commit for Radicle registration')
    const branchName = readGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir)
    const stubMetadataRaw = await fs.readFile(path.join(repoDir, '.radicle-stub.json'), 'utf-8')
    const metadata = JSON.parse(stubMetadataRaw)
    expect(metadata.defaultBranch).toBe(branchName)
    const inspectCount = await countCommandForRepo(logFile, 'inspect', repoDir)
    expect(inspectCount).toBeGreaterThan(0)
    await radicle.cleanup()
  })
})
