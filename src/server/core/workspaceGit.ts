import fs from 'fs/promises'
import path from 'path'
import type { GitFileChange, GitInfo } from '../../interfaces/core/git'
import { listGitBranches, runGitCommand } from '../../modules/git'
import { parseGitStashList } from '../lib/git'

export const parseGitStatusOutput = (output: string | null): GitFileChange[] => {
  if (!output) return []
  const entries: GitFileChange[] = []
  output.split('\n').forEach((rawLine) => {
    const line = rawLine.replace(/\r$/, '')
    if (!line.trim()) return
    if (line.startsWith('!!')) {
      return
    }
    const statusPart = line.slice(0, 2)
    const stagedStatus = statusPart[0] ?? ' '
    const worktreeStatus = statusPart[1] ?? ' '
    const isUntracked = statusPart === '??'
    let remainder = line.slice(2)
    if (!isUntracked && remainder.startsWith(' ')) {
      remainder = remainder.slice(1)
    }
    remainder = remainder.trim()
    let renameFrom: string | null = null
    let renameTo: string | null = null
    if (remainder.includes('->')) {
      const [from, to] = remainder.split('->').map((segment) => segment.trim())
      renameFrom = from
      renameTo = to
      remainder = to
    }
    entries.push({
      path: remainder,
      displayPath: remainder,
      stagedStatus,
      worktreeStatus,
      renameFrom,
      renameTo,
      isUntracked
    })
  })
  return entries
}

export async function ensureWorkspaceDirectory(dirPath: string): Promise<void> {
  const stats = await fs.stat(dirPath)
  if (!stats.isDirectory()) {
    throw new Error('Project repository path is not a directory')
  }
}

export async function initializeWorkspaceRepository(dirPath: string, defaultBranch: string): Promise<string> {
  const resolved = path.resolve(dirPath)
  await fs.mkdir(resolved, { recursive: true })
  const stats = await fs.stat(resolved)
  if (!stats.isDirectory()) {
    throw new Error('Workspace path is not a directory')
  }
  let gitExists = true
  try {
    await fs.access(path.join(resolved, '.git'))
  } catch {
    gitExists = false
  }
  if (!gitExists) {
    await runGitCommand(['init'], resolved)
    const branch = defaultBranch.trim()
    if (branch.length) {
      const ref = `refs/heads/${branch}`
      try {
        await runGitCommand(['symbolic-ref', 'HEAD', ref], resolved)
      } catch (symbolicError) {
        try {
          await runGitCommand(['checkout', '-B', branch], resolved)
        } catch (checkoutError) {
          const reason =
            checkoutError instanceof Error
              ? checkoutError.message
              : symbolicError instanceof Error
                ? symbolicError.message
                : 'unknown failure'
          throw new Error(`Failed to set default branch "${branch}": ${reason}`)
        }
      }
    }
  }
  try {
    return await fs.realpath(resolved)
  } catch {
    return resolved
  }
}

export const readGitMetadata = async (repoPath: string): Promise<GitInfo | null> => {
  const resolved = path.resolve(repoPath)
  try {
    await fs.stat(resolved)
  } catch {
    return null
  }

  const readValue = async (
    args: string[],
    options?: {
      preserveWhitespace?: boolean
    }
  ): Promise<string | null> => {
    try {
      const output = await runGitCommand(args, resolved)
      if (options?.preserveWhitespace) {
        return output.replace(/\r/g, '')
      }
      return output.trim()
    } catch {
      return null
    }
  }

  const [
    branch,
    commitHash,
    commitMessage,
    commitTimestamp,
    remotesRaw,
    statusOutput,
    diffStat,
    diffText,
    stashOutput,
    branchList
  ] = await Promise.all([
    readValue(['rev-parse', '--abbrev-ref', 'HEAD']),
    readValue(['rev-parse', 'HEAD']),
    readValue(['log', '-1', '--pretty=%s']),
    readValue(['log', '-1', '--pretty=%cI']),
    readValue(['remote', '-v']),
    readValue(['status', '--short'], { preserveWhitespace: true }),
    readValue(['diff', '--stat']),
    readValue(['diff', '--no-color']),
    readValue(['stash', 'list', '--pretty=%gd::%s']),
    listGitBranches(resolved)
  ])

  const remotes: Array<{ name: string; url: string; ahead?: number; behind?: number }> = []
  if (remotesRaw) {
    const seen = new Set<string>()
    const remoteLines = remotesRaw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

    for (const line of remoteLines) {
      const parts = line.split(/\s+/)
      if (parts.length < 2) continue
      const [name, url] = parts
      const key = `${name}:${url}`
      if (seen.has(key)) continue
      seen.add(key)

      let ahead: number | undefined
      let behind: number | undefined

      if (branch) {
        try {
          const remoteBranch = `${name}/${branch}`
          const remoteBranchExists = await readValue(['rev-parse', '--verify', remoteBranch])
          if (remoteBranchExists) {
            const aheadBehindOutput = await readValue(['rev-list', '--count', '--left-right', `${remoteBranch}...HEAD`])
            if (aheadBehindOutput) {
              const [behindStr, aheadStr] = aheadBehindOutput.split('\t')
              behind = behindStr ? parseInt(behindStr, 10) : 0
              ahead = aheadStr ? parseInt(aheadStr, 10) : 0
              if (ahead === 0) ahead = undefined
              if (behind === 0) behind = undefined
            }
          }
        } catch {
          // ignore ahead/behind errors
        }
      }

      remotes.push({ name, url, ahead, behind })
    }
  }

  const changedFiles = statusOutput
    ? statusOutput
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean).length
    : 0

  return {
    repositoryPath: resolved,
    branch,
    commit: commitHash
      ? {
          hash: commitHash,
          message: commitMessage,
          timestamp: commitTimestamp
        }
      : null,
    remotes,
    status: {
      isClean: changedFiles === 0,
      changedFiles,
      summary: statusOutput ? statusOutput.split('\n').slice(0, 8).join('\n') : null
    },
    diffStat: diffStat ?? null,
    diffText: diffText ?? null,
    changes: parseGitStatusOutput(statusOutput),
    stashes: parseGitStashList(stashOutput),
    branches: branchList
  }
}
