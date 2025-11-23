import { spawn } from 'child_process'
import path from 'path'
import { createRadicleRepoManager } from './repoManager'
import { createRadicleSession } from './session'
import type {
  RadicleConfig,
  RadicleModule,
  RadicleRegisterOptions,
  RadicleRepositoryInfo,
  RadicleSessionInit,
  RadicleStatus
} from './types'
import { createWorkspaceManager } from './workspace'

export { type RadicleConfig, type RadicleModule, type RadicleSessionInit } from './types'

export const createRadicleModule = (config: RadicleConfig): RadicleModule => {
  const workspaceManager = createWorkspaceManager(config)
  const repoManagers = new Map<string, ReturnType<typeof createRadicleRepoManager>>()

  const getRepoManager = (repoPath: string) => {
    const resolved = path.resolve(repoPath)
    const existing = repoManagers.get(resolved)
    if (existing) return existing
    const manager = createRadicleRepoManager({ repoPath: resolved, remote: config.defaultRemote })
    repoManagers.set(resolved, manager)
    return manager
  }

  const createSession = async (init: RadicleSessionInit) => {
    const repoManager = getRepoManager(init.repositoryPath)
    return createRadicleSession(repoManager, workspaceManager, init)
  }

  const inspectRepository = async (repositoryPath: string): Promise<RadicleRepositoryInfo> => {
    const resolved = path.resolve(repositoryPath)
    const remoteUrl = await readRadRemoteUrl(resolved)
    const radicleProjectId = extractRadicleId(remoteUrl)
    const defaultBranch = await readRadDefaultBranch(resolved)
    return {
      repositoryPath: resolved,
      radicleProjectId,
      remoteUrl,
      defaultBranch,
      registered: Boolean(radicleProjectId)
    }
  }

  const registerRepository = async (options: RadicleRegisterOptions): Promise<RadicleRepositoryInfo> => {
    const resolved = path.resolve(options.repositoryPath)
    const normalizedName = options.name && options.name.trim().length ? options.name.trim() : path.basename(resolved)
    const normalizedDescription = options.description ?? ''
    const visibility = options.visibility ?? 'private'
    await ensureGitRepository(resolved)
    await ensureInitialCommitExists(resolved)
    const defaultBranch = await resolveDefaultBranch(resolved)
    await ensureRadicleProject(resolved, {
      name: normalizedName,
      description: normalizedDescription,
      defaultBranch,
      visibility
    })
    await ensureRadRemote(resolved)
    return await inspectRepository(resolved)
  }

  const getStatus = async (): Promise<RadicleStatus> => {
    const nodeStatus = await checkRadicleNode()
    if (!nodeStatus.reachable) {
      return {
        reachable: false,
        loggedIn: false,
        message: nodeStatus.message ?? 'Radicle node unreachable'
      }
    }
    const identity = await fetchRadicleIdentity()
    return {
      reachable: true,
      loggedIn: identity.loggedIn,
      identity: identity.identity ?? null,
      alias: identity.alias ?? null,
      message: identity.message ?? null
    }
  }

  const cleanup = async () => {
    await workspaceManager.cleanupAll()
    repoManagers.clear()
  }

  return {
    createSession,
    cleanup,
    inspectRepository,
    registerRepository,
    getStatus
  }
}

const runCliCommand = async (command: string, args: string[], options: { cwd?: string } = {}) => {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })
    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim())
      } else {
        const message = stderr.trim() || stdout.trim() || `${command} ${args.join(' ')} failed with code ${code}`
        reject(new Error(message))
      }
    })
  })
}

const readRadRemoteUrl = async (repoPath: string): Promise<string | null> => {
  try {
    const output = await runCliCommand('git', ['config', '--get', 'remote.rad.url'], { cwd: repoPath })
    return output.length ? output : null
  } catch {
    return null
  }
}

const ensureGitRepository = async (repoPath: string) => {
  await runCliCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoPath })
}

const ensureRadicleProject = async (
  repoPath: string,
  options: { name: string; description?: string; defaultBranch: string; visibility: 'public' | 'private' }
) => {
  const alreadyInitialized = await hasRadicleProject(repoPath)
  if (alreadyInitialized) return
  const args = ['init']
  args.push('--name', options.name)
  args.push('--default-branch', options.defaultBranch)
  args.push(options.visibility === 'public' ? '--public' : '--private')
  args.push('--no-confirm')
  if (options.description !== undefined) {
    args.push('--description', options.description)
  }
  await runCliCommand('rad', args, { cwd: repoPath })
}

const readCurrentBranch = async (repoPath: string): Promise<string | null> => {
  for (const args of [
    ['symbolic-ref', '--short', 'HEAD'],
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    ['branch', '--show-current']
  ]) {
    try {
      const branch = await runCliCommand('git', args, { cwd: repoPath })
      if (branch && branch !== 'HEAD') {
        return branch
      }
    } catch {
      // ignore and try the next strategy
    }
  }
  return null
}

const listLocalBranches = async (repoPath: string): Promise<string[]> => {
  try {
    const raw = await runCliCommand('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], {
      cwd: repoPath
    })
    return raw
      .split('\n')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length)
  } catch {
    return []
  }
}

const branchHasCommits = async (repoPath: string, branch: string | null): Promise<boolean> => {
  if (!branch) return false
  try {
    await runCliCommand('git', ['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: repoPath })
    return true
  } catch {
    return false
  }
}

const repositoryHasCommits = async (repoPath: string): Promise<boolean> => {
  try {
    await runCliCommand('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoPath })
    return true
  } catch {
    return false
  }
}

const hasStagedChanges = async (repoPath: string): Promise<boolean> => {
  try {
    await runCliCommand('git', ['diff', '--cached', '--quiet'], { cwd: repoPath })
    return false
  } catch {
    return true
  }
}

const ensureInitialCommitExists = async (repoPath: string) => {
  const hasCommits = await repositoryHasCommits(repoPath)
  if (hasCommits) return
  if (await hasStagedChanges(repoPath)) {
    throw new Error(
      'Repository has staged changes but no commits. Commit or unstage them before registering with Radicle.'
    )
  }
  const branchName = (await readHeadBranchName(repoPath)) ?? 'main'
  if (!branchName || branchName === 'HEAD') {
    await runCliCommand('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repoPath })
  }
  await runCliCommand('git', ['commit', '--allow-empty', '-m', 'Initial commit for Radicle registration'], {
    cwd: repoPath
  })
}

const readHeadBranchName = async (repoPath: string): Promise<string | null> => {
  try {
    const name = await runCliCommand('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repoPath })
    return name.length ? name : null
  } catch {
    return null
  }
}

const resolveDefaultBranch = async (repoPath: string): Promise<string> => {
  const tested = new Set<string>()
  const tryBranch = async (candidate: string | null | undefined): Promise<string | null> => {
    if (!candidate) return null
    if (tested.has(candidate)) return null
    tested.add(candidate)
    return (await branchHasCommits(repoPath, candidate)) ? candidate : null
  }

  const current = await tryBranch(await readCurrentBranch(repoPath))
  if (current) return current

  for (const fallback of ['main', 'master']) {
    const branch = await tryBranch(fallback)
    if (branch) return branch
  }

  const localBranches = await listLocalBranches(repoPath)
  for (const branchName of localBranches) {
    const resolved = await tryBranch(branchName)
    if (resolved) return resolved
  }

  throw new Error(
    'Unable to determine a Git branch with commits. Create a branch with at least one commit before registering with Radicle.'
  )
}

const hasRadicleProject = async (repoPath: string): Promise<boolean> => {
  try {
    await runCliCommand('rad', ['inspect'], { cwd: repoPath })
    return true
  } catch {
    return false
  }
}

const ensureRadRemote = async (repoPath: string) => {
  const existing = await readRadRemoteUrl(repoPath)
  if (existing) return existing
  const projectId = await readRadProjectId(repoPath)
  if (!projectId) return null
  const remoteUrl = projectId.startsWith('rad://') ? projectId : `rad://${projectId}`
  try {
    await runCliCommand('git', ['remote', 'add', 'rad', remoteUrl], { cwd: repoPath })
    return remoteUrl
  } catch (error) {
    if (error instanceof Error && /already exists/i.test(error.message)) {
      return remoteUrl
    }
    throw error
  }
}

const readRadProjectId = async (repoPath: string): Promise<string | null> => {
  try {
    const raw = await runCliCommand('rad', ['inspect', '--json'], { cwd: repoPath })
    const parsed = JSON.parse(raw)
    return parsed?.rid ?? parsed?.urn ?? parsed?.id ?? null
  } catch {
    return null
  }
}

const extractRadicleId = (remoteUrl: string | null): string | null => {
  if (!remoteUrl) return null
  const match = remoteUrl.match(/rad(?::\/\/|:)([a-z0-9]+)/i)
  return match?.[1] ?? remoteUrl
}

const readRadDefaultBranch = async (repoPath: string): Promise<string | null> => {
  try {
    const ref = await runCliCommand('git', ['symbolic-ref', '--short', 'refs/remotes/rad/HEAD'], { cwd: repoPath })
    if (!ref.length) return null
    const parts = ref.split('/')
    return parts[parts.length - 1] ?? ref
  } catch {
    return null
  }
}

const checkRadicleNode = async (): Promise<{ reachable: boolean; message?: string }> => {
  try {
    await runCliCommand('rad', ['node', 'status'])
    return { reachable: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Radicle node error'
    return { reachable: false, message }
  }
}

const fetchRadicleIdentity = async (): Promise<{
  loggedIn: boolean
  identity?: string | null
  alias?: string | null
  message?: string | null
}> => {
  try {
    const raw = await runCliCommand('rad', ['self', '--json'])
    const parsed = JSON.parse(raw)
    return {
      loggedIn: true,
      identity: parsed?.id ?? parsed?.did ?? null,
      alias: parsed?.alias ?? parsed?.handle ?? null
    }
  } catch (error) {
    try {
      await runCliCommand('rad', ['self'])
      return {
        loggedIn: true,
        identity: null,
        alias: null
      }
    } catch (fallbackError) {
      const message =
        fallbackError instanceof Error
          ? fallbackError.message
          : error instanceof Error
            ? error.message
            : 'Radicle identity unavailable'
      return {
        loggedIn: false,
        identity: null,
        alias: null,
        message
      }
    }
  }
}
