import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { RadicleRegistrationRecord, RadicleRegistrationsRepository } from './radicle'

export type ProjectRecord = {
  id: string
  name: string
  description: string | null
  repositoryPath: string
  repositoryProvider: string | null
  defaultBranch: string
  createdAt: string
}

export type ProjectsRepository = {
  list: () => ProjectRecord[]
  getById: (id: string) => ProjectRecord | null
  getByRepositoryPath: (repoPath: string) => ProjectRecord | null
}

const PROJECT_ID_PREFIX = 'rad'

export const createProjectsRepository = (options: {
  radicleRegistrations: RadicleRegistrationsRepository
}): ProjectsRepository => {
  const computeRecords = (): ProjectRecord[] => {
    const registrations = options.radicleRegistrations.list()
    const records: ProjectRecord[] = []
    registrations.forEach((registration) => {
      const record = buildProjectRecord(registration)
      if (record) {
        records.push(record)
      }
    })
    return records.sort((a, b) => {
      const createdDiff = b.createdAt.localeCompare(a.createdAt)
      if (createdDiff !== 0) return createdDiff
      return a.name.localeCompare(b.name)
    })
  }

  const list = (): ProjectRecord[] => computeRecords()

  const getById = (id: string): ProjectRecord | null => {
    return computeRecords().find((project) => project.id === id) ?? null
  }

  const getByRepositoryPath = (repoPath: string): ProjectRecord | null => {
    const normalized = canonicalizePath(repoPath)
    return computeRecords().find((project) => canonicalizePath(project.repositoryPath) === normalized) ?? null
  }

  return {
    list,
    getById,
    getByRepositoryPath
  }
}

export const deriveProjectId = (repositoryPath: string): string => {
  const normalized = canonicalizePath(repositoryPath)
  const hash = crypto.createHash('sha1').update(normalized).digest('hex')
  return `${PROJECT_ID_PREFIX}-${hash}`
}

const hasHyperagentFolder = (repositoryPath: string): boolean => {
  const candidate = path.join(repositoryPath, '.hyperagent')
  try {
    return fs.statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

const buildProjectRecord = (registration: RadicleRegistrationRecord): ProjectRecord | null => {
  const repoPath = canonicalizePath(registration.repositoryPath)
  let stats: fs.Stats
  try {
    stats = fs.statSync(repoPath)
  } catch {
    return null
  }
  if (!stats.isDirectory()) {
    return null
  }
  if (!hasHyperagentFolder(repoPath)) {
    return null
  }
  return {
    id: deriveProjectId(repoPath),
    name: registration.name ?? (path.basename(repoPath) || repoPath),
    description: registration.description ?? null,
    repositoryPath: repoPath,
    repositoryProvider: 'radicle',
    defaultBranch: registration.defaultBranch ?? 'main',
    createdAt: registration.registeredAt
  }
}

const canonicalizePath = (repositoryPath: string): string => {
  const resolved = path.resolve(repositoryPath)
  const real = resolveRealpath(resolved)
  return real ?? resolved
}

const resolveRealpath = (target: string): string | null => {
  try {
    if (typeof fs.realpathSync.native === 'function') {
      return fs.realpathSync.native(target)
    }
  } catch {
    // ignore native errors and fall back
  }
  try {
    return fs.realpathSync(target)
  } catch {
    return null
  }
}
