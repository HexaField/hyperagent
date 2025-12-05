import fs from 'fs'
import path from 'path'
import { hasRunMeta, loadRunMeta, metaDirectory, type RunMeta } from '../../../modules/provenance/provenance'

const knownWorkspaces = new Set<string>()

export const rememberWorkspacePath = (workspacePath: string | null | undefined) => {
  if (!workspacePath) return
  const normalized = workspacePath.trim()
  if (!normalized.length) return
  knownWorkspaces.add(normalized)
}

export const findWorkspaceForRun = (runId: string): string | null => {
  for (const workspace of knownWorkspaces) {
    try {
      if (hasRunMeta(runId, workspace)) {
        return workspace
      }
    } catch {
      // ignore and continue searching
    }
  }
  return null
}

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
