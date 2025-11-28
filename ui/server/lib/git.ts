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

export const FILE_STASH_PREFIX = 'hyperagent:file:'

export const parseGitStashList = (output: string | null): GitFileStashEntry[] => {
  if (!output) return []
  const entries: GitFileStashEntry[] = []
  output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const [namePart, messagePart] = line.split('::')
      const name = namePart ?? ''
      const message = messagePart ?? ''
      if (!message.startsWith(FILE_STASH_PREFIX)) return
      const filePath = message.slice(FILE_STASH_PREFIX.length).trim()
      if (!filePath) return
      entries.push({ name, filePath, message })
    })
  return entries
}
