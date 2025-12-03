import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'

export type GitCommitInfo = {
  hash: string
  message: string
  authorName: string
  authorEmail: string
  timestamp: string
}

export type GitLogOptions = {
  repoPath: string
  branch: string
  limit?: number
}

const DEFAULT_COMMIT_LIMIT = 25

export type RunGitCommandOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export type RunGitCommandSyncOptions = RunGitCommandOptions & {
  stdio?: 'inherit' | 'pipe'
}

export async function runGitCommand(args: string[], cwd: string, options: RunGitCommandOptions = {}): Promise<string> {
  const resolvedCwd = path.resolve(options.cwd ?? cwd)
  return await new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: resolvedCwd, env: options.env ?? process.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `git ${args.join(' ')} failed with code ${code}`))
      }
    })
  })
}

export function runGitCommandSync(args: string[], cwd: string, options: RunGitCommandSyncOptions = {}): string {
  const resolvedCwd = path.resolve(options.cwd ?? cwd)
  const stdio = options.stdio ?? 'pipe'
  const result = spawnSync('git', args, {
    cwd: resolvedCwd,
    env: options.env ?? process.env,
    stdio,
    encoding: 'utf8'
  })
  if (result.error) {
    throw result.error
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : ''
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : ''
    const detail = stderr || stdout || `git ${args.join(' ')} failed with code ${result.status}`
    throw new Error(detail)
  }
  return typeof result.stdout === 'string' ? result.stdout : ''
}

export async function listGitBranches(repoPath: string): Promise<string[]> {
  try {
    const raw = await runGitCommand(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], repoPath)
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length)
  } catch {
    return []
  }
}

export async function listBranchCommits(options: GitLogOptions): Promise<GitCommitInfo[]> {
  const { repoPath, branch, limit = DEFAULT_COMMIT_LIMIT } = options
  const format = '%H%x1f%an%x1f%ae%x1f%aI%x1f%s'
  try {
    const raw = await runGitCommand(
      ['log', '--date-order', '-n', String(limit), '--date=iso-strict', `--pretty=format:${format}`, branch],
      repoPath
    )
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length)
      .map((line) => {
        const [hash, authorName, authorEmail, timestamp, message] = line.split('\x1f')
        return {
          hash,
          authorName,
          authorEmail,
          timestamp,
          message
        }
      })
  } catch {
    return []
  }
}
