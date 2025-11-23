import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { RadicleConfig } from './types'

export const createWorkspaceManager = (config: RadicleConfig) => {
  const tempRoot = config.tempRootDir ? path.resolve(config.tempRootDir) : path.join(os.tmpdir(), 'hyperagent-radicle')
  const active = new Map<string, string>()

  const createWorkspace = async (sessionId: string): Promise<string> => {
    await fs.mkdir(tempRoot, { recursive: true })
    const workspacePath = await fs.mkdtemp(path.join(tempRoot, `${sessionId}-`))
    active.set(sessionId, workspacePath)
    return workspacePath
  }

  const cleanupWorkspace = async (sessionId: string, workspacePath?: string): Promise<void> => {
    const target = workspacePath ?? active.get(sessionId)
    if (!target) return
    active.delete(sessionId)
    await fs.rm(target, { recursive: true, force: true })
  }

  const cleanupAll = async (): Promise<void> => {
    const entries = [...active.entries()]
    active.clear()
    await Promise.all(entries.map(([sessionId, workspacePath]) => cleanupWorkspace(sessionId, workspacePath)))
  }

  return {
    createWorkspace,
    cleanupWorkspace,
    cleanupAll
  }
}
