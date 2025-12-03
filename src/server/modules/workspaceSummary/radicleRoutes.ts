import { Router, type RequestHandler } from 'express'
import path from 'path'
import type { ProjectRecord, RadicleRegistrationRecord } from '../../../../src/modules/database'
import type { RadicleModule } from '../../../../src/modules/radicle'
import type { WorkspaceSummaryDeps } from './types'
import { collectGitMetadata } from './utils'

export type RadicleRoutesDeps = Pick<
  WorkspaceSummaryDeps,
  'wrapAsync' | 'persistence' | 'radicleModule' | 'readGitMetadata'
>

export const createRadicleRoutes = (deps: RadicleRoutesDeps) => {
  const router = Router()
  const { wrapAsync, persistence, radicleModule, readGitMetadata } = deps

  const collectMetadata = (paths: string[]) => collectGitMetadata(paths, readGitMetadata)

  const sanitizeRepoIdComponent = (repoPath: string): string => {
    const normalized = repoPath.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    return normalized.length ? normalized : 'radicle-repo'
  }

  function createSyntheticProjectRecord(
    repoPath: string,
    registration: RadicleRegistrationRecord | null
  ): ProjectRecord {
    return {
      id: `rad-only-${sanitizeRepoIdComponent(repoPath)}`,
      name: registration?.name ?? path.basename(repoPath) ?? repoPath,
      description: registration?.description ?? null,
      repositoryPath: repoPath,
      repositoryProvider: 'radicle',
      defaultBranch: registration?.defaultBranch ?? 'main',
      createdAt: registration?.registeredAt ?? new Date().toISOString()
    }
  }

  const radicleStatusHandler: RequestHandler = async (_req, res) => {
    try {
      const status = await radicleModule.getStatus()
      res.json({ status })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read Radicle status'
      res.status(500).json({ error: message })
    }
  }

  const radicleRepositoriesHandler: RequestHandler = async (_req, res) => {
    try {
      const projects = persistence.projects.list()
      const radicleRegistrations = persistence.radicleRegistrations.list()
      const projectMap = new Map(projects.map((project) => [path.resolve(project.repositoryPath), project]))
      const registrationMap = new Map(radicleRegistrations.map((entry) => [path.resolve(entry.repositoryPath), entry]))
      const uniquePaths = [...new Set([...projectMap.keys(), ...registrationMap.keys()])]
      if (!uniquePaths.length) {
        res.json({ repositories: [] })
        return
      }
      const gitMetadata = await collectMetadata(uniquePaths)
      const inspections = await Promise.all(
        uniquePaths.map((repoPath) => inspectRadicleRepository(repoPath, radicleModule))
      )
      const inspectionMap = new Map<string, { info: unknown; error?: string }>()
      inspections.forEach((entry) => {
        inspectionMap.set(entry.path, entry)
      })
      const payload = uniquePaths.map((repoPath) => {
        const project =
          projectMap.get(repoPath) ?? createSyntheticProjectRecord(repoPath, registrationMap.get(repoPath) ?? null)
        const inspection = inspectionMap.get(repoPath)
        return {
          project,
          radicle: inspection?.info ?? null,
          git: gitMetadata.get(path.resolve(repoPath)) ?? null,
          error: inspection?.error ?? null
        }
      })
      payload.sort((a, b) => a.project.name.localeCompare(b.project.name))
      res.json({ repositories: payload })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list Radicle repositories'
      res.status(500).json({ error: message })
    }
  }

  const registerRadicleRepositoryHandler: RequestHandler = async (req, res) => {
    const { repositoryPath, name, description, visibility } = req.body ?? {}
    if (!repositoryPath || typeof repositoryPath !== 'string') {
      res.status(400).json({ error: 'repositoryPath is required' })
      return
    }
    try {
      const resolvedPath = path.resolve(repositoryPath.trim())
      const repository = await radicleModule.registerRepository({
        repositoryPath: resolvedPath,
        name: typeof name === 'string' && name.length ? name : undefined,
        description: typeof description === 'string' && description.length ? description : undefined,
        visibility: visibility === 'public' || visibility === 'private' ? visibility : undefined
      })
      persistence.radicleRegistrations.upsert({
        repositoryPath: resolvedPath,
        name: typeof name === 'string' && name.length ? name : undefined,
        description: typeof description === 'string' && description.length ? description : undefined,
        visibility: visibility === 'public' || visibility === 'private' ? visibility : undefined,
        defaultBranch: repository.defaultBranch ?? undefined
      })
      res.json({ repository })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to register repository with Radicle'
      res.status(500).json({ error: message })
    }
  }

  router.get('/status', wrapAsync(radicleStatusHandler))
  router.get('/repositories', wrapAsync(radicleRepositoriesHandler))
  router.post('/register', wrapAsync(registerRadicleRepositoryHandler))

  return router
}

const inspectRadicleRepository = async (
  repoPath: string,
  radicleModule: RadicleModule
): Promise<{ path: string; info: unknown; error?: string }> => {
  try {
    const info = await radicleModule.inspectRepository(repoPath)
    return { path: repoPath, info }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Radicle inspection failed'
    return { path: repoPath, info: null, error: message }
  }
}
