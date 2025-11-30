import { spawnSync } from 'node:child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { CommitResult, RadicleModule } from './types'

type TempDirFactory = (prefix: string) => Promise<string>

type TestRadicleModuleOptions = {
  makeTempDir?: TempDirFactory
}

const defaultMakeTempDir: TempDirFactory = async (prefix) => {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

export function createTestRadicleModule(
  repoPath: string,
  options: TestRadicleModuleOptions = {}
): RadicleModule {
  const activeWorkspaces = new Map<string, string>()
  const makeTempDir = options.makeTempDir ?? defaultMakeTempDir

  const cleanupWorkspace = async (workspacePath: string) => {
    if (!activeWorkspaces.has(workspacePath)) return
    try {
      runGitCommand(['worktree', 'remove', '--force', workspacePath], repoPath)
    } catch {
      // ignore cleanup failures
    }
    await fs.rm(path.dirname(workspacePath), { recursive: true, force: true }).catch(() => undefined)
    activeWorkspaces.delete(workspacePath)
  }

  return {
    createSession: async (init) => {
      let workspaceInfo: { workspacePath: string; branchName: string; baseBranch: string } | null = null
      let closed = false
      const workspaceRoot = await makeTempDir(`radicle-workspace-${init.taskId}-`)
      const workspacePath = path.join(workspaceRoot, 'worktree')

      const start = async () => {
        if (workspaceInfo) return workspaceInfo
        await fs.mkdir(workspaceRoot, { recursive: true })
        runGitCommand(['worktree', 'add', '-B', init.branchInfo.name, workspacePath, init.branchInfo.baseBranch], repoPath)
        workspaceInfo = {
          workspacePath,
          branchName: init.branchInfo.name,
          baseBranch: init.branchInfo.baseBranch
        }
        activeWorkspaces.set(workspacePath, workspacePath)
        return workspaceInfo
      }

      const getWorkspace = () => {
        if (!workspaceInfo) {
          throw new Error('Radicle session has not been started')
        }
        return workspaceInfo
      }

      const commit = async (message: string): Promise<CommitResult | null> => {
        const workspace = getWorkspace()
        const status = runGitCommand(['status', '--porcelain'], workspace.workspacePath)
        if (!status.trim()) {
          return null
        }
        runGitCommand(['config', 'user.name', init.author.name], workspace.workspacePath)
        runGitCommand(['config', 'user.email', init.author.email], workspace.workspacePath)
        runGitCommand(['add', '--all'], workspace.workspacePath)
        runGitCommand(['commit', '-m', message], workspace.workspacePath)
        const commitHash = runGitCommand(['rev-parse', 'HEAD'], workspace.workspacePath)
        const changedFilesRaw = runGitCommand(['show', '--pretty=', '--name-only', 'HEAD'], workspace.workspacePath)
        const changedFiles = changedFilesRaw
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
        return {
          branch: workspace.branchName,
          commitHash,
          message,
          changedFiles
        }
      }

      const finish = async (message: string) => {
        const result = await commit(message)
        await cleanup()
        return result
      }

      const abort = async () => {
        await cleanup()
      }

      const cleanup = async () => {
        if (closed || !workspaceInfo) return
        closed = true
        await cleanupWorkspace(workspaceInfo.workspacePath)
        workspaceInfo = null
      }

      return {
        start,
        getWorkspace,
        commitAndPush: commit,
        finish,
        abort
      }
    },
    cleanup: async () => {
      for (const workspacePath of activeWorkspaces.keys()) {
        await cleanupWorkspace(workspacePath)
      }
    },
    inspectRepository: async () => ({
      repositoryPath: repoPath,
      radicleProjectId: 'rad:test-harness',
      remoteUrl: repoPath,
      defaultBranch: 'main',
      registered: true
    }),
    registerRepository: async () => ({
      repositoryPath: repoPath,
      radicleProjectId: 'rad:test-harness',
      remoteUrl: repoPath,
      defaultBranch: 'main',
      registered: true
    }),
    getStatus: async () => ({ reachable: true, loggedIn: true, identity: 'rad-test', alias: 'rad-test' })
  }
}

const runGitCommand = (args: string[], cwd: string): string => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    const message = result.stderr || result.stdout || `git ${args.join(' ')} failed`
    throw new Error(message.trim())
  }
  return (result.stdout ?? '').trim()
}
