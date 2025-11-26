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

export type GitInfo = {
  repositoryPath: string
  branch: string | null
  commit: {
    hash: string | null
    message: string | null
    timestamp: string | null
  } | null
  remotes: Array<{ name: string; url: string; ahead?: number; behind?: number }>
  status?: {
    isClean: boolean
    changedFiles: number
    summary: string | null
  } | null
  diffStat?: string | null
  diffText?: string | null
  changes?: GitFileChange[]
  stashes?: GitFileStashEntry[]
  branches?: string[]
}
