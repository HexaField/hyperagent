import type Database from 'better-sqlite3'
import crypto from 'crypto'
import type { PersistenceContext, PersistenceModule, Timestamp } from './database'

export type ProjectRecord = {
  id: string
  name: string
  description: string | null
  repositoryPath: string
  repositoryProvider: string | null
  defaultBranch: string
  createdAt: Timestamp
}

export type ProjectInput = {
  id?: string
  name: string
  description?: string
  repositoryPath: string
  repositoryProvider?: string
  defaultBranch?: string
}

export type ProjectsRepository = {
  upsert: (input: ProjectInput) => ProjectRecord
  getById: (id: string) => ProjectRecord | null
  list: () => ProjectRecord[]
}

export type ProjectsBindings = {
  projects: ProjectsRepository
}

export const projectsPersistence: PersistenceModule<ProjectsBindings> = {
  name: 'projects',
  applySchema: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        repository_path TEXT NOT NULL,
        repository_provider TEXT,
        default_branch TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
  },
  createBindings: ({ db }: PersistenceContext) => ({
    projects: createProjectsRepository(db)
  })
}

function createProjectsRepository(db: Database.Database): ProjectsRepository {
  return {
    upsert: (input) => {
      const now = new Date().toISOString()
      const id = input.id ?? crypto.randomUUID()
      db.prepare(
        `INSERT INTO projects (id, name, description, repository_path, repository_provider, default_branch, created_at)
         VALUES (@id, @name, @description, @repositoryPath, @repositoryProvider, @defaultBranch, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name,
           description=excluded.description,
           repository_path=excluded.repository_path,
           repository_provider=excluded.repository_provider,
           default_branch=excluded.default_branch`
      ).run({
        id,
        name: input.name,
        description: input.description ?? null,
        repositoryPath: input.repositoryPath,
        repositoryProvider: input.repositoryProvider ?? null,
        defaultBranch: input.defaultBranch ?? 'main',
        createdAt: now
      })
      const record = db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
      return mapProject(record)
    },
    getById: (id) => {
      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
      return row ? mapProject(row) : null
    },
    list: () => {
      const rows = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all()
      return rows.map(mapProject)
    }
  }
}

function mapProject(row: any): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    repositoryPath: row.repository_path,
    repositoryProvider: row.repository_provider ?? null,
    defaultBranch: row.default_branch,
    createdAt: row.created_at
  }
}
