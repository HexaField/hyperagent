import { spawn } from 'node:child_process'
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

async function runGitCommand(args: string[], cwd: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: path.resolve(cwd) })
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
