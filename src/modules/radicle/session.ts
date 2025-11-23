import type { createRadicleRepoManager } from './repoManager'
import type { CommitResult, RadicleSessionHandle, RadicleSessionInit, WorkspaceInfo } from './types'
import type { createWorkspaceManager } from './workspace'

export const createRadicleSession = (
  repoManager: ReturnType<typeof createRadicleRepoManager>,
  workspaceManager: ReturnType<typeof createWorkspaceManager>,
  init: RadicleSessionInit
): RadicleSessionHandle => {
  let workspace: WorkspaceInfo | null = null
  let closed = false

  const start = async (): Promise<WorkspaceInfo> => {
    if (workspace) return workspace
    await repoManager.initIfNeeded()
    await repoManager.ensureBranch(init.branchInfo)
    const workspacePath = await workspaceManager.createWorkspace(init.taskId)
    try {
      await repoManager.addWorktree(workspacePath, init.branchInfo.name)
    } catch (error) {
      await workspaceManager.cleanupWorkspace(init.taskId, workspacePath)
      throw error
    }
    workspace = {
      workspacePath,
      branchName: init.branchInfo.name,
      baseBranch: init.branchInfo.baseBranch
    }
    return workspace
  }

  const getWorkspace = (): WorkspaceInfo => {
    if (!workspace) {
      throw new Error('Radicle session has not been started')
    }
    return workspace
  }

  const commitAndPush = async (message: string): Promise<CommitResult | null> => {
    if (!workspace) {
      throw new Error('Radicle session has not been started')
    }
    const result = await repoManager.commitInWorktree(
      workspace.workspacePath,
      workspace.branchName,
      message,
      init.author,
      init.metadata
    )
    if (result) {
      await repoManager.pushBranch(workspace.branchName)
    }
    return result
  }

  const finish = async (message: string): Promise<CommitResult | null> => {
    try {
      return await commitAndPush(message)
    } finally {
      await cleanup()
    }
  }

  const abort = async (): Promise<void> => {
    await cleanup()
  }

  const cleanup = async () => {
    if (closed || !workspace) return
    closed = true
    await repoManager.removeWorktree(workspace.workspacePath).catch(() => undefined)
    await workspaceManager.cleanupWorkspace(init.taskId, workspace.workspacePath)
    workspace = null
  }

  return {
    start,
    getWorkspace,
    commitAndPush,
    finish,
    abort
  }
}
