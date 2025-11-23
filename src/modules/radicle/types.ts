import { createRadicleRepoManager } from './repoManager'
import { createWorkspaceManager } from './workspace'

export type RadicleConfig = {
  defaultRemote?: string
  tempRootDir?: string
}

export type RadicleBranchInfo = {
  name: string
  baseBranch: string
  description?: string
}

export type RadicleSessionInit = {
  taskId: string
  branchInfo: RadicleBranchInfo
  repositoryPath: string
  author: {
    name: string
    email: string
  }
  metadata?: Record<string, string>
}

export type WorkspaceInfo = {
  workspacePath: string
  branchName: string
  baseBranch: string
}

export type CommitResult = {
  branch: string
  commitHash: string
  message: string
  changedFiles: string[]
}

export type DiffResult = {
  branch: string
  diffText: string
}

export type RadiclePatch = {
  patchId: string
  branch: string
  baseBranch: string
  title: string
  description: string
}

export type RadicleRepositoryInfo = {
  repositoryPath: string
  radicleProjectId: string | null
  remoteUrl: string | null
  defaultBranch: string | null
  registered: boolean
}

export type RadicleRegisterOptions = {
  repositoryPath: string
  name?: string
  description?: string
}

export type RadicleStatus = {
  reachable: boolean
  loggedIn: boolean
  identity?: string | null
  alias?: string | null
  message?: string | null
}

export type RadicleRepoManager = ReturnType<typeof createRadicleRepoManager>
export type WorkspaceManager = ReturnType<typeof createWorkspaceManager>

export type RadicleSessionHandle = {
  start: () => Promise<WorkspaceInfo>
  getWorkspace: () => WorkspaceInfo
  commitAndPush: (message: string) => Promise<CommitResult | null>
  finish: (message: string) => Promise<CommitResult | null>
  abort: () => Promise<void>
}

export type RadicleModule = {
  createSession: (init: RadicleSessionInit) => Promise<RadicleSessionHandle>
  cleanup: () => Promise<void>
  inspectRepository: (repositoryPath: string) => Promise<RadicleRepositoryInfo>
  registerRepository: (options: RadicleRegisterOptions) => Promise<RadicleRepositoryInfo>
  getStatus: () => Promise<RadicleStatus>
}
