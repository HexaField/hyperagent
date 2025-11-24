import { spawn } from 'node:child_process'
import path from 'node:path'
import type { ProjectRecord } from '../projects'
import type { FileDiff, DiffHunk, DiffLine, PullRequestRecord } from './types'

export type DiffModule = ReturnType<typeof createDiffModule>

export function createDiffModule() {
  return {
    getPullRequestDiff
  }

  async function getPullRequestDiff(pullRequest: PullRequestRecord, project: ProjectRecord): Promise<FileDiff[]> {
    const repoPath = path.resolve(project.repositoryPath)
    const diffText = await runGit(['diff', '--unified=5', `${pullRequest.targetBranch}..${pullRequest.sourceBranch}`], repoPath)
    if (!diffText.trim()) return []
    return parseUnifiedDiff(diffText)
  }
}

function parseUnifiedDiff(diffText: string): FileDiff[] {
  const files: FileDiff[] = []
  const lines = diffText.split('\n')
  let currentFile: FileDiff | null = null
  let currentHunk: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0

  const mutateCurrentFile = (mutator: (file: FileDiff) => void) => {
    if (currentFile) {
      mutator(currentFile)
    }
  }

  const finalizeHunk = () => {
    if (currentFile && currentHunk) {
      currentFile.hunks.push(currentHunk)
    }
    currentHunk = null
  }

  const finalizeFile = () => {
    finalizeHunk()
    if (currentFile) {
      files.push(currentFile)
      currentFile = null
    }
  }

  const beginFile = (rawPath: string, previousPath?: string, status: FileDiff['status'] = 'modified') => {
    finalizeFile()
    currentFile = {
      path: rawPath,
      previousPath,
      status,
      hunks: []
    } as FileDiff
  }

  let pendingStatus: FileDiff['status'] = 'modified'
  let pendingPrevPath: string | undefined

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const parts = line.split(' ')
      const pathA = parts[2]?.replace(/^a\//, '') ?? ''
      const pathB = parts[3]?.replace(/^b\//, '') ?? pathA
      pendingStatus = 'modified'
      pendingPrevPath = undefined
      beginFile(pathB, pathA !== pathB ? pathA : undefined)
      continue
    }
    if (!currentFile) {
      continue
    }
    if (line.startsWith('new file mode')) {
      pendingStatus = 'added'
      mutateCurrentFile((file) => {
        file.status = 'added'
      })
      continue
    }
    if (line.startsWith('deleted file mode')) {
      pendingStatus = 'deleted'
      mutateCurrentFile((file) => {
        file.status = 'deleted'
      })
      continue
    }
    if (line.startsWith('rename from ')) {
      pendingStatus = 'renamed'
      pendingPrevPath = line.slice('rename from '.length).trim()
      mutateCurrentFile((file) => {
        file.previousPath = pendingPrevPath
      })
      continue
    }
    if (line.startsWith('rename to ')) {
      if (pendingStatus === 'renamed') {
        mutateCurrentFile((file) => {
          file.status = 'renamed'
          file.path = line.slice('rename to '.length).trim()
        })
      }
      continue
    }
    if (line.startsWith('index ') || line.startsWith('similarity index') || line.startsWith('dissimilarity index')) {
      continue
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      continue
    }
    if (line.startsWith('@@')) {
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
      if (!match) continue
      finalizeHunk()
      const oldStart = Number(match[1])
      const oldLines = match[2] ? Number(match[2]) : 1
      const newStart = Number(match[3])
      const newLinesCount = match[4] ? Number(match[4]) : 1
      oldLine = oldStart
      newLine = newStart
      currentHunk = {
        header: line,
        oldStart,
        newStart,
        oldLines,
        newLines: newLinesCount,
        lines: []
      }
      if (pendingStatus) {
        mutateCurrentFile((file) => {
          file.status = pendingStatus
        })
      }
      continue
    }
    if (!currentHunk) {
      continue
    }
    if (line.startsWith('\\ No newline at end of file')) {
      continue
    }
    let diffLine: DiffLine
    if (line.startsWith('+')) {
      diffLine = {
        type: 'added',
        content: line.slice(1),
        oldLineNumber: undefined,
        newLineNumber: newLine++
      }
    } else if (line.startsWith('-')) {
      diffLine = {
        type: 'removed',
        content: line.slice(1),
        oldLineNumber: oldLine++,
        newLineNumber: undefined
      }
    } else {
      diffLine = {
        type: 'context',
        content: line.startsWith(' ') ? line.slice(1) : line,
        oldLineNumber: oldLine++,
        newLineNumber: newLine++
      }
    }
    currentHunk.lines.push(diffLine)
  }

  finalizeFile()
  return files
}

async function runGit(args: string[], repoPath: string): Promise<string> {
  const cwd = path.resolve(repoPath)
  return await new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd })
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
