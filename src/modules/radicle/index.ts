import { spawn } from 'child_process'
import path from 'path'
import { createRadicleRepoManager } from './repoManager'
import { createRadicleSession } from './session'
import type {
  RadicleConfig,
  RadicleModule,
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
    child.stdout.on('data', data => {
      stdout += data.toString()
    })
    child.stderr.on('data', data => {
      stderr += data.toString()
    })
    child.once('error', reject)
    child.once('close', code => {
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

const fetchRadicleIdentity = async (): Promise<{ loggedIn: boolean; identity?: string | null; alias?: string | null; message?: string | null }> => {
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
      const message = fallbackError instanceof Error ? fallbackError.message : error instanceof Error ? error.message : 'Radicle identity unavailable'
      return {
        loggedIn: false,
        identity: null,
        alias: null,
        message
      }
    }
  }
}
