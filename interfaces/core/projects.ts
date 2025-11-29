import type { GitInfo } from './git'

export type ProjectRecord = {
  id: string
  name: string
  description: string | null
  repositoryPath: string
  repositoryProvider: string | null
  defaultBranch: string
  createdAt: string
}

export type WorkspaceRecord = ProjectRecord & {
  git?: GitInfo | null
}

export type ProjectListResponse = {
  projects: WorkspaceRecord[]
}

export type ProjectDetailResponse = {
  project: WorkspaceRecord
}
