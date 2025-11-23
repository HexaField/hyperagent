import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { CommitResult, DiffResult, RadicleBranchInfo } from './types'

const runCommand = async (
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv }
): Promise<string> => {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })
    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    child.on('error', (error) => {
      reject(error)
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim())
      } else {
        const message = stderr.trim() || stdout.trim() || `Command ${command} failed with code ${code}`
        reject(new Error(message))
      }
    })
  })
}

const runGit = async (args: string[], cwd: string): Promise<string> => {
  return await runCommand('git', args, { cwd })
}

const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

const branchExists = async (repoPath: string, branchName: string) => {
  try {
    await runGit(['show-ref', '--verify', `refs/heads/${branchName}`], repoPath)
    return true
  } catch {
    return false
  }
}

const checkoutBranchFromBase = async (repoPath: string, branchName: string, baseBranch: string) => {
  await runGit(['fetch', '--all'], repoPath).catch(() => undefined)
  await runGit(['branch', branchName, baseBranch], repoPath)
}
 
export const createRadicleRepoManager = ({ repoPath, remote }: { repoPath: string; remote?: string }) => {
  const resolvedRepo = path.resolve(repoPath)
  const remoteName = remote ?? 'origin'

  const initIfNeeded = async () => {
    ensureDir(resolvedRepo)
    if (!fs.existsSync(path.join(resolvedRepo, '.git'))) {
      await runGit(['init'], resolvedRepo)
    }
  }

  const ensureBranch = async (branch: RadicleBranchInfo) => {
    await initIfNeeded()
    const exists = await branchExists(resolvedRepo, branch.name)
    if (!exists) {
      await checkoutBranchFromBase(resolvedRepo, branch.name, branch.baseBranch)
    }
  }

  const addWorktree = async (workspacePath: string, branchName: string) => {
    await runGit(['worktree', 'add', '--force', workspacePath, branchName], resolvedRepo)
  }

  const removeWorktree = async (workspacePath: string) => {
    await runGit(['worktree', 'remove', '--force', workspacePath], resolvedRepo)
  }

  const commitInWorktree = async (
    workspacePath: string,
    branchName: string,
    message: string,
    author: { name: string; email: string },
    metadata?: Record<string, string>
  ): Promise<CommitResult | null> => {
    const status = await runGit(['status', '--porcelain'], workspacePath)
    if (!status.trim()) {
      return null
    }

    const commitMessage = buildCommitMessage(message, metadata)
    await runGit(['add', '--all'], workspacePath)
    await runCommand('git', ['commit', '-m', commitMessage], {
      cwd: workspacePath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email
      }
    })

    const commitHash = await runGit(['rev-parse', 'HEAD'], workspacePath)
    const changedFilesRaw = await runGit(['show', '--pretty=', '--name-only', 'HEAD'], workspacePath)
    const changedFiles = changedFilesRaw.split('\n').filter(Boolean)

    return {
      branch: branchName,
      commitHash,
      message: commitMessage,
      changedFiles
    }
  }

  const pushBranch = async (branchName: string) => {
    await runGit(['push', remoteName, branchName], resolvedRepo)
  }

  const getDiffForBranch = async (branchName: string, baseBranch: string): Promise<DiffResult> => {
    const diffText = await runGit(['diff', `${baseBranch}..${branchName}`], resolvedRepo)
    return { branch: branchName, diffText }
  }

  return {
    initIfNeeded,
    ensureBranch,
    addWorktree,
    removeWorktree,
    commitInWorktree,
    pushBranch,
    getDiffForBranch
  }
}

const buildCommitMessage = (message: string, metadata?: Record<string, string>): string => {
  if (!metadata || !Object.keys(metadata).length) {
    return message
  }
  const metaText = Object.entries(metadata)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
  return `${message}\n\n${metaText}`
}
