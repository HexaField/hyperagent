export type GitFileChange = {
  path: string
  displayPath: string
  stagedStatus: string
  worktreeStatus: string
  renameFrom?: string | null
  renameTo?: string | null
  isUntracked: boolean
}

export type GitFileStashEntry = {
  name: string
  filePath: string
  message: string
}

export type GitCommitInfo = {
  hash: string | null
  message: string | null
  timestamp: string | null
}

export type GitRemoteInfo = {
  name: string
  url: string
  ahead?: number
  behind?: number
}

export type GitStatusInfo = {
  isClean: boolean
  changedFiles: number
  summary: string | null
}

export type GitInfo = {
  repositoryPath: string
  branch: string | null
  commit: GitCommitInfo | null
  remotes: GitRemoteInfo[]
  status?: GitStatusInfo | null
  diffStat?: string | null
  diffText?: string | null
  changes?: GitFileChange[]
  stashes?: GitFileStashEntry[]
  branches?: string[]
}

export type GitStateResponse = {
  git: GitInfo | null
}
