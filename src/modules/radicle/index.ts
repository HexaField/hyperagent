import path from 'path'
import { createRadicleRepoManager } from './repoManager'
import { createRadicleSession } from './session'
import type { RadicleConfig, RadicleModule, RadicleSessionInit } from './types'
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

  const cleanup = async () => {
    await workspaceManager.cleanupAll()
    repoManagers.clear()
  }

  return {
    createSession,
    cleanup
  }
}
