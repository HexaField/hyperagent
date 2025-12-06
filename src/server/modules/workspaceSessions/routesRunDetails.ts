import { Router, type RequestHandler } from 'express'
import { hasRunMeta, loadRunMeta, type RunMeta } from '../../../modules/provenance/provenance'
import { findWorkspaceForRun, normalizeWorkspacePath, serializeRunWithDiffs } from './routesShared'
import type { WorkspaceSessionsDeps } from './routesTypes'

type RunMessage = {
  id: string
  role: string
  roleLabel: string
  modelId: string | null
  createdAt: string
  text?: string
  payload: unknown
}

const extractMessageText = (payload: unknown): string | undefined => {
  if (typeof payload === 'string') return payload
  if (payload && typeof payload === 'object' && typeof (payload as any).text === 'string') {
    return (payload as any).text
  }
  return undefined
}

const buildMessagesFromRun = (run: RunMeta): RunMessage[] => {
  const log = Array.isArray(run.log) ? run.log : []
  return log.map((entry, index) => ({
    id: entry.entryId || `${run.id}-${index}`,
    role: entry.role ?? 'agent',
    roleLabel: entry.role ?? 'agent',
    modelId: entry.model ?? null,
    createdAt: entry.createdAt,
    text: extractMessageText(entry.payload),
    payload: entry.payload ?? null
  }))
}

const createGetSessionHandler = (): RequestHandler => async (req, res) => {
  const runId = req.params.runId
  if (!runId) {
    res.status(400).json({ error: 'runId is required' })
    return
  }
  let workspacePath = normalizeWorkspacePath(req.query.workspacePath)
  if (!workspacePath) {
    workspacePath = findWorkspaceForRun(runId)
    if (!workspacePath) {
      res.status(400).json({ error: 'workspacePath query parameter is required' })
      return
    }
  }

  if (!hasRunMeta(runId, workspacePath)) {
    res.status(404).json({ error: 'Unknown session' })
    return
  }

  try {
    const run = serializeRunWithDiffs(loadRunMeta(runId, workspacePath))
    const messages = buildMessagesFromRun(run)
    res.json({ ...run, messages })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load coding agent session'
    res.status(500).json({ error: message })
  }
}

export const createRunDetailsRouter = ({ wrapAsync }: WorkspaceSessionsDeps) => {
  const router = Router()
  router.get('/api/coding-agent/sessions/:runId', wrapAsync(createGetSessionHandler()))
  return router
}
