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

const remoteExists = async (repoPath: string, remoteName: string): Promise<boolean> => {
  try {
    await runGit(['config', '--get', `remote.${remoteName}.url`], repoPath)
    return true
  } catch {
    return false
  }
}

const listGitRemotes = async (repoPath: string): Promise<string[]> => {
  try {
    const raw = await runGit(['remote'], repoPath)
    return raw
      .split('\n')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length)
  } catch {
    return []
  }
}

const detectPushRemote = async (repoPath: string, preferred?: string | null): Promise<string> => {
  const candidates = Array.from(
    new Set([
      preferred?.trim().length ? preferred.trim() : null,
      'rad',
      'origin'
    ].filter((entry): entry is string => Boolean(entry)))
  )
  for (const candidate of candidates) {
    if (await remoteExists(repoPath, candidate)) {
      return candidate
    }
  }
  const remotes = await listGitRemotes(repoPath)
  if (remotes.length) {
    return remotes[0]!
  }
  throw new Error(
    `No Git remotes configured for ${repoPath}. Register the repository with Radicle or configure RADICLE_REMOTE.`
  )
}

export const createRadicleRepoManager = ({
  repoPath,
  remote,
  radCliPath
}: {
  repoPath: string
  remote?: string
  radCliPath?: string
}) => {
  const resolvedRepo = path.resolve(repoPath)
  let resolvedRemoteName: string | null = null
  const radBinary = radCliPath?.trim().length ? radCliPath.trim() : process.env.RADICLE_CLI_PATH ?? 'rad'

  const getRemoteName = async () => {
    if (resolvedRemoteName) return resolvedRemoteName
    resolvedRemoteName = await detectPushRemote(resolvedRepo, remote ?? null)
    return resolvedRemoteName
  }

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

  const remoteUrl = async (remoteName: string): Promise<string | null> => {
    try {
      const output = await runGit(['config', '--get', `remote.${remoteName}.url`], resolvedRepo)
      return output || null
    } catch {
      return null
    }
  }

  const runRadCli = async (args: string[]) => {
    await runCommand(radBinary, args, { cwd: resolvedRepo })
  }

  const pushBranch = async (branchName: string) => {
    const pushRemote = await getRemoteName()
    const remoteUrlValue = await remoteUrl(pushRemote)
    const requiresRadHelper = isRadUrl(remoteUrlValue)
    const radHelperAvailable = requiresRadHelper ? hasGitRemoteRadHelper() : true

    if (!requiresRadHelper || radHelperAvailable) {
      await runGit(['push', pushRemote, branchName], resolvedRepo)
    } else {
      console.warn('[radicle]', {
        action: 'skip_git_push_missing_rad_helper',
        remote: pushRemote,
        remoteUrl: remoteUrlValue ?? null
      })
    }

    if (await shouldInvokeRadPush(pushRemote)) {
      await runRadCli(['push', pushRemote, branchName])
    }
  }

  const shouldInvokeRadPush = async (pushRemote: string): Promise<boolean> => {
    if (pushRemote === 'rad') {
      return true
    }
    const url = await remoteUrl(pushRemote)
    if (!url) return false
    return url.startsWith('rad://') || url.startsWith('rad:')
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

const isRadUrl = (url?: string | null): boolean => {
  if (!url) return false
  return url.startsWith('rad://') || url.startsWith('rad:')
}

const hasGitRemoteRadHelper = (() => {
  let cached: boolean | null = null
  return () => {
    if (cached !== null) return cached
    cached = commandExists('git-remote-rad')
    return cached
  }
})()

const commandExists = (binaryName: string): boolean => {
  const pathEntries = process.env.PATH?.split(path.delimiter) ?? []
  for (const entry of pathEntries) {
    if (!entry) continue
    const candidate = path.join(entry, binaryName)
    try {
      const stats = fs.statSync(candidate)
      if ((stats.isFile() || stats.isSymbolicLink()) && isExecutable(candidate)) {
        return true
      }
    } catch {
      // ignore missing candidate
    }
  }
  return false
}

const isExecutable = (filePath: string): boolean => {
  try {
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}
