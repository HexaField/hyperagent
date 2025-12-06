import fs from 'fs'
import path from 'path'
import { loadRunMeta, metaDirectory, type LogEntry, type RunMeta } from '../../../modules/provenance/provenance'
import { fileDiffsToUnifiedPatch } from '../../../shared/diffPatch'

export const resolveWorkspacePath = (req: any): string | null => {
  return (
    (req.params && normalizeWorkspacePath(req.params.workspacePath)) ??
    (req.query && normalizeWorkspacePath(req.query.workspacePath)) ??
    (req.body && normalizeWorkspacePath(req.body.workspacePath)) ??
    null
  )
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

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

const extractDiffPatch = (payload: unknown): string | null => {
  if (!isPlainObject(payload)) return null
  const diff = payload.diff
  if (!isPlainObject(diff)) return null
  const existing = typeof diff.patch === 'string' ? diff.patch.trim() : ''
  if (existing) return existing
  const files = Array.isArray(diff.files) ? (diff.files as any[]) : []
  if (!files.length) return null
  return fileDiffsToUnifiedPatch(files as any)
}

const withDiffPatch = (entry: LogEntry): LogEntry => {
  const patch = extractDiffPatch(entry.payload)
  if (!patch) return entry
  if (!isPlainObject(entry.payload)) return entry
  const nextPayload: Record<string, unknown> = { ...entry.payload }
  const diff = isPlainObject(nextPayload.diff) ? { ...nextPayload.diff } : {}
  diff.patch = patch
  nextPayload.diff = diff
  return { ...entry, payload: nextPayload }
}

export const serializeRunWithDiffs = (run: RunMeta): RunMeta => {
  const log = Array.isArray(run.log) ? run.log.map((entry) => withDiffPatch(entry)) : []
  return { ...run, log }
}

export const serializeRunsWithDiffs = (runs: RunMeta[]): RunMeta[] => runs.map((run) => serializeRunWithDiffs(run))
