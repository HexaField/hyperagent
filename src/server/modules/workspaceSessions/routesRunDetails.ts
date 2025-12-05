import { Router, type RequestHandler } from 'express'
import { hasRunMeta, loadRunMeta } from '../../../modules/provenance/provenance'
import { normalizeWorkspacePath } from './routesShared'
import type { WorkspaceSessionsDeps } from './routesTypes'

const createGetSessionHandler = (): RequestHandler => async (req, res) => {
  const runId = req.params.runId
  if (!runId) {
    res.status(400).json({ error: 'runId is required' })
    return
  }
  const workspacePath = normalizeWorkspacePath(req.query.workspacePath)
  if (!workspacePath) {
    res.status(400).json({ error: 'workspacePath query parameter is required' })
    return
  }

  if (!hasRunMeta(runId, workspacePath)) {
    res.status(404).json({ error: 'Unknown session' })
    return
  }

  try {
    const run = loadRunMeta(runId, workspacePath)
    res.json(run)
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
