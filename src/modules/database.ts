import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import {
  agentRunsPersistence,
  type AgentRunInput,
  type AgentRunRecord,
  type AgentRunStatus,
  type AgentRunsBindings,
  type AgentRunsRepository
} from './agent'
import {
  codeServerSessionsPersistence,
  type CodeServerSessionInput,
  type CodeServerSessionRecord,
  type CodeServerSessionStatus,
  type CodeServerSessionsBindings,
  type CodeServerSessionsRepository
} from './codeServer'
import {
  projectsPersistence,
  type ProjectInput,
  type ProjectRecord,
  type ProjectsBindings,
  type ProjectsRepository
} from './projects'
import {
  radicleRegistrationsPersistence,
  type RadicleRegistrationInput,
  type RadicleRegistrationRecord,
  type RadicleRegistrationsBindings,
  type RadicleRegistrationsRepository
} from './radicle'
import {
  terminalSessionsPersistence,
  type TerminalSessionCreateInput,
  type TerminalSessionRecord,
  type TerminalSessionStatus,
  type TerminalSessionUpdateInput,
  type TerminalSessionsBindings,
  type TerminalSessionsRepository
} from './terminal'
import {
  workflowsPersistence,
  type WorkflowInput,
  type WorkflowKind,
  type WorkflowRecord,
  type WorkflowStatus,
  type WorkflowStepInput,
  type WorkflowStepRecord,
  type WorkflowStepStatus,
  type WorkflowStepsRepository,
  type WorkflowsBindings,
  type WorkflowsRepository
} from './workflows'
import {
  reviewPersistence,
  type PullRequestCommitInput,
  type PullRequestCommitsRepository,
  type PullRequestEventsRepository,
  type PullRequestInsertInput,
  type PullRequestsRepository,
  type ReviewBindings,
  type ReviewCommentsRepository,
  type ReviewRunInsertInput,
  type ReviewRunsRepository,
  type ReviewThreadsRepository
} from './review/persistence'

export type Timestamp = string

export type PersistenceOptions = {
  file?: string
}

export type PersistenceContext = {
  db: Database.Database
}

export type PersistenceModule<TBindings extends Record<string, unknown>> = {
  name: string
  applySchema: (db: Database.Database) => void
  createBindings: (ctx: PersistenceContext) => TBindings
}

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'hyperagent.db')

export function createDatabase(options: PersistenceOptions = {}): Database.Database {
  const file = options.file ?? DEFAULT_DB_PATH
  ensureParentDir(file)
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  return db
}

function ensureParentDir(file: string): void {
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

const defaultModules: readonly PersistenceModule<Record<string, unknown>>[] = [
  projectsPersistence,
  workflowsPersistence,
  agentRunsPersistence,
  codeServerSessionsPersistence,
  radicleRegistrationsPersistence,
  terminalSessionsPersistence,
  reviewPersistence
]

type DefaultBindings = ProjectsBindings &
  WorkflowsBindings &
  AgentRunsBindings &
  CodeServerSessionsBindings &
  RadicleRegistrationsBindings &
  TerminalSessionsBindings &
  ReviewBindings

export type Persistence = { db: Database.Database } & DefaultBindings

export function createPersistence(options: PersistenceOptions = {}): Persistence {
  const db = createDatabase(options)
  defaultModules.forEach((module) => module.applySchema(db))
  const ctx: PersistenceContext = { db }
  const bindings = defaultModules.reduce(
    (acc, module) => Object.assign(acc, module.createBindings(ctx)),
    {} as DefaultBindings
  )
  return { db, ...bindings }
}

export type {
  AgentRunInput,
  AgentRunRecord,
  AgentRunStatus,
  AgentRunsRepository,
  CodeServerSessionInput,
  CodeServerSessionRecord,
  CodeServerSessionStatus,
  CodeServerSessionsRepository,
  ProjectInput,
  ProjectRecord,
  ProjectsRepository,
  RadicleRegistrationInput,
  RadicleRegistrationRecord,
  RadicleRegistrationsRepository,
  PullRequestCommitInput,
  PullRequestCommitsRepository,
  PullRequestEventsRepository,
  PullRequestInsertInput,
  PullRequestsRepository,
  TerminalSessionCreateInput,
  TerminalSessionRecord,
  TerminalSessionStatus,
  TerminalSessionUpdateInput,
  TerminalSessionsRepository,
  ReviewRunInsertInput,
  ReviewRunsRepository,
  ReviewThreadsRepository,
  ReviewCommentsRepository,
  WorkflowInput,
  WorkflowKind,
  WorkflowRecord,
  WorkflowStatus,
  WorkflowStepInput,
  WorkflowStepRecord,
  WorkflowStepStatus,
  WorkflowStepsRepository,
  WorkflowsRepository
}
