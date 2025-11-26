export type GitInfo = {
  repositoryPath: string
  branch: string | null
  commit: {
    hash: string | null
    message: string | null
    timestamp: string | null
  } | null
  remotes: Array<{ name: string; url: string }>
  status?: {
    isClean: boolean
    changedFiles: number
    summary: string | null
  } | null
  diffStat?: string | null
}
