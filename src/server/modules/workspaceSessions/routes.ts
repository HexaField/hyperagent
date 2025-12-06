import { Router } from 'express'
import { createPersonasRouter } from './routesPersonas'
import { createRunDetailsRouter } from './routesRunDetails'
import { createRunsRouter } from './routesRuns'
import type { WorkspaceSessionsDeps } from './routesTypes'

export const createWorkspaceSessionsRouter = (deps: WorkspaceSessionsDeps) => {
  const router = Router({ mergeParams: true })
  router.use(createPersonasRouter(deps))
  router.use(createRunDetailsRouter(deps))
  router.use(createRunsRouter(deps))
  return router
}
