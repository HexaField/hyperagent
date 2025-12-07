import type { RequestHandler } from 'express'
import type { Persistence } from '../../../../src/modules/database'
import type { RadicleModule } from '../../../../src/modules/radicle'
import type { ReadGitMetadata } from './utils'

export type WrapAsync = (handler: RequestHandler) => RequestHandler

export type WorkspaceSummaryPersistence = Pick<Persistence, 'projects' | 'radicleRegistrations'>

export type WorkspaceSummaryDeps = {
  wrapAsync: WrapAsync
  persistence: WorkspaceSummaryPersistence
  radicleModule: RadicleModule
  readGitMetadata: ReadGitMetadata
  runGitCommand: (args: string[], cwd: string) => Promise<string>
  graphBranchLimit: number
  graphCommitsPerBranch: number
  initializeWorkspaceRepository: (dirPath: string, defaultBranch: string) => Promise<string>
}
