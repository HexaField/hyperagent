import type { GitInfo } from '../core/git'
import type { WorkspaceRecord } from '../core/projects'

export type RadicleRepositoryInfo = {
  repositoryPath: string
  radicleProjectId: string | null
  remoteUrl: string | null
  defaultBranch: string | null
  registered: boolean
}

export type RadicleRepositoryEntry = {
  project: WorkspaceRecord
  radicle: RadicleRepositoryInfo | null
  git: GitInfo | null
  error?: string | null
}

export type DirectoryEntry = {
  name: string
  path: string
  isGitRepository: boolean
  radicleRegistered: boolean
  radicleRegistrationReason: string | null
}

export type DirectoryListing = {
  path: string
  parent: string | null
  entries: DirectoryEntry[]
}
