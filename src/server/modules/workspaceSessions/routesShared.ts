import fs from 'fs'
import path from 'path'
import { loadRunMeta, metaDirectory, type RunMeta } from '../../../modules/provenance/provenance'

export const normalizeWorkspacePath = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length ? trimmed : null
}

export const readWorkspaceRuns = (workspacePath: string): RunMeta[] => {
  try {
    const metaDir = metaDirectory(workspacePath)
    const files = fs.readdirSync(metaDir).filter((file) => file.endsWith('.json'))
    const runs: RunMeta[] = []
    for (const file of files) {
      const runId = path.basename(file, '.json')
      try {
        runs.push(loadRunMeta(runId, workspacePath))
      } catch {
        // ignore malformed run files
      }
    }
    runs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    return runs
  } catch {
    return []
  }
}

export const safeLoadRun = (runId: string, workspacePath: string): RunMeta | null => {
  try {
    return loadRunMeta(runId, workspacePath)
  } catch {
    return null
  }
}
