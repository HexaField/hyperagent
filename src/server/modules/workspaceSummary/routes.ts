import { Router } from 'express'
import { createFilesystemRoutes } from './filesystemRoutes'
import { createProjectsRoutes } from './projectsRoutes'
import { createRadicleRoutes } from './radicleRoutes'
import type { WorkspaceSummaryDeps } from './types'

export const createWorkspaceSummaryRouter = (deps: WorkspaceSummaryDeps) => {
  const router = Router()

  router.use(
    '/api/radicle',
    createRadicleRoutes({
      wrapAsync: deps.wrapAsync,
      persistence: deps.persistence,
      radicleModule: deps.radicleModule,
      readGitMetadata: deps.readGitMetadata
    })
  )

  router.use(
    '/api/fs',
    createFilesystemRoutes({
      wrapAsync: deps.wrapAsync,
      radicleModule: deps.radicleModule,
      persistence: deps.persistence
    })
  )

  router.use('/api/projects', createProjectsRoutes(deps))

  return router
}
