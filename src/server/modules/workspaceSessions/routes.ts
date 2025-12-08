import { Router } from 'express'
import { createPersonasRouter } from './routesPersonas'
import { createRunDetailsRouter } from './routesRunDetails'
import { createRunsRouter } from './routesRuns'
import type { WorkspaceSessionsDeps } from './routesTypes'
import { createWorkflowsRouter } from './routesWorkflows'

export const createWorkspaceSessionsRouter = (deps: WorkspaceSessionsDeps) => {
  const router = Router({ mergeParams: true })
  router.use(createPersonasRouter(deps))
  router.use(createWorkflowsRouter(deps))
  router.use(createRunDetailsRouter(deps))
  router.use(createRunsRouter(deps))
  return router
}
