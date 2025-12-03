import { Router, type RequestHandler } from 'express'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { WorkspaceSummaryDeps } from './types'
import { isGitRepository } from './utils'

export type FilesystemRoutesDeps = Pick<WorkspaceSummaryDeps, 'wrapAsync' | 'radicleModule' | 'persistence'>

export const createFilesystemRoutes = (deps: FilesystemRoutesDeps) => {
  const router = Router()
  const { wrapAsync, radicleModule, persistence } = deps

  const browseFilesystemHandler: RequestHandler = async (req, res) => {
    const requestedPath = typeof req.query.path === 'string' && req.query.path.length ? req.query.path : os.homedir()
    try {
      const resolved = path.resolve(requestedPath)
      const stats = await fs.stat(resolved)
      if (!stats.isDirectory()) {
        res.status(400).json({ error: 'Path is not a directory' })
        return
      }
      const entries = await fs.readdir(resolved, { withFileTypes: true })
      const directories = entries.filter((entry) => entry.isDirectory())
      const payload = await Promise.all(
        directories.map(async (entry) => {
          const absolute = path.join(resolved, entry.name)
          const gitRepo = await isGitRepository(absolute)
          let radicleRegistered = false
          let radicleRegistrationReason: string | null = null
          if (!gitRepo) {
            radicleRegistrationReason = 'Not a Git repository'
          } else {
            try {
              const info = await radicleModule.inspectRepository(absolute)
              radicleRegistered = info.registered
              if (radicleRegistered) {
                persistence.radicleRegistrations.upsert({
                  repositoryPath: absolute,
                  name: entry.name,
                  defaultBranch: info.defaultBranch ?? undefined
                })
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Failed to inspect repository for Radicle'
              radicleRegistrationReason = message
            }
          }
          return {
            name: entry.name,
            path: absolute,
            isGitRepository: gitRepo,
            radicleRegistered,
            radicleRegistrationReason
          }
        })
      )
      payload.sort((a, b) => a.name.localeCompare(b.name))
      const parent = path.dirname(resolved)
      const isRoot = resolved === path.parse(resolved).root
      res.json({
        path: resolved,
        parent: isRoot ? null : parent,
        entries: payload
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to browse filesystem'
      res.status(500).json({ error: message })
    }
  }

  router.get('/browse', wrapAsync(browseFilesystemHandler))
  return router
}
