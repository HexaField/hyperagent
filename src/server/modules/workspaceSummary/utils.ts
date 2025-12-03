import fs from 'fs/promises'
import path from 'path'

export type ReadGitMetadata = (repoPath: string) => Promise<any>

export const collectGitMetadata = async (
  paths: string[],
  readGitMetadata: ReadGitMetadata
): Promise<Map<string, any>> => {
  const unique = [...new Set(paths.map((entry) => path.resolve(entry)))]
  const results = await Promise.all(unique.map(async (entry) => ({ path: entry, git: await readGitMetadata(entry) })))
  const map = new Map<string, any>()
  results.forEach((item) => {
    map.set(item.path, item.git)
  })
  return map
}

export const isGitRepository = async (dirPath: string): Promise<boolean> => {
  try {
    await fs.access(path.join(dirPath, '.git'))
    return true
  } catch {
    return false
  }
}
