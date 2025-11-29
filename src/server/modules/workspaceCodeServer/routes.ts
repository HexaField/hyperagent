import { Router, type RequestHandler } from 'express'
import type { CodeServerSessionListResponse } from '../../../interfaces/core/codeServer'
import type { DevspaceSession } from '../../../interfaces/widgets/workspaceCodeServer'
import type { Persistence, ProjectRecord } from '../../../../src/modules/database'

type WrapAsync = (handler: RequestHandler) => RequestHandler

type EnsureWorkspaceDirectory = (dirPath: string) => Promise<void>

export type CodeServerSessionSummary = {
  id: string
  publicUrl: string
  dir: string
  branch: string
}

type EnsureProjectCodeServer = (project: ProjectRecord) => Promise<CodeServerSessionSummary | null>

type WorkspaceCodeServerPersistence = Pick<Persistence, 'projects' | 'codeServerSessions'>

export type WorkspaceCodeServerDeps = {
  wrapAsync: WrapAsync
  persistence: WorkspaceCodeServerPersistence
  ensureWorkspaceDirectory: EnsureWorkspaceDirectory
  ensureProjectCodeServer: EnsureProjectCodeServer
}

export const createWorkspaceCodeServerRouter = (deps: WorkspaceCodeServerDeps) => {
  const { wrapAsync, persistence, ensureWorkspaceDirectory, ensureProjectCodeServer } = deps
  const router = Router()

  const projectDevspaceHandler: RequestHandler = async (req, res) => {
    const projectId = req.params.projectId
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' })
      return
    }
    const project = persistence.projects.getById(projectId)
    if (!project) {
      res.status(404).json({ error: 'Unknown project' })
      return
    }
    try {
      await ensureWorkspaceDirectory(project.repositoryPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Project repository path is unavailable'
      res.status(400).json({ error: message })
      return
    }
    const session = await ensureProjectCodeServer(project)
    if (!session) {
      res.status(500).json({ error: 'Failed to launch code-server for project' })
      return
    }
    const response: DevspaceSession = {
      projectId: project.id,
      sessionId: session.id,
      codeServerUrl: session.publicUrl,
      workspacePath: session.dir,
      branch: session.branch
    }
    res.json(response)
  }

  const listCodeSessionsHandler: RequestHandler = (_req, res) => {
    const response: CodeServerSessionListResponse = {
      sessions: persistence.codeServerSessions.listActive()
    }
    res.json(response)
  }

  router.post('/api/projects/:projectId/devspace', wrapAsync(projectDevspaceHandler))
  router.get('/api/code-server/sessions', wrapAsync(listCodeSessionsHandler))

  return router
}
