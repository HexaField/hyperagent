import type { FileDiff, PullRequestCommitRecord, PullRequestRecord, ReviewEngineResult } from './types'

export type ReviewEngineInput = {
  pullRequest: PullRequestRecord
  diff: FileDiff[]
  commits: PullRequestCommitRecord[]
}

export type ReviewEngineModule = ReturnType<typeof createReviewEngineModule>

export function createReviewEngineModule(options: { maxCommentsPerFile?: number } = {}) {
  const maxCommentsPerFile = Math.max(options.maxCommentsPerFile ?? 2, 1)

  return {
    reviewPullRequest
  }

  async function reviewPullRequest(input: ReviewEngineInput): Promise<ReviewEngineResult> {
    const totals = summarizeDiff(input.diff)
    const summary = buildSummary(input.pullRequest.title, totals)
    const highLevelFindings = buildFindings(totals, input.commits)
    const riskAssessment = classifyRisk(totals)
    const fileComments = buildFileComments(input.diff, maxCommentsPerFile)
    return {
      summary,
      highLevelFindings,
      riskAssessment,
      fileComments
    }
  }
}

type DiffTotals = {
  filesChanged: number
  additions: number
  deletions: number
  largestFile?: { path: string; delta: number }
}

function summarizeDiff(diff: FileDiff[]): DiffTotals {
  return diff.reduce<DiffTotals>(
    (acc, file) => {
      let additions = 0
      let deletions = 0
      file.hunks.forEach((hunk) => {
        hunk.lines.forEach((line) => {
          if (line.type === 'added') additions += 1
          if (line.type === 'removed') deletions += 1
        })
      })
      const delta = additions + deletions
      if (!acc.largestFile || delta > acc.largestFile.delta) {
        acc.largestFile = { path: file.path, delta }
      }
      acc.filesChanged += 1
      acc.additions += additions
      acc.deletions += deletions
      return acc
    },
    { filesChanged: 0, additions: 0, deletions: 0 }
  )
}

function buildSummary(title: string, totals: DiffTotals): string {
  return `Review summary for "${title}": ${totals.filesChanged} files changed with ${totals.additions} additions and ${totals.deletions} deletions.`
}

function buildFindings(totals: DiffTotals, commits: PullRequestCommitRecord[]): string[] {
  const findings: string[] = []
  if (totals.largestFile) {
    findings.push(
      `Largest change: ${totals.largestFile.path} (${totals.largestFile.delta} line${totals.largestFile.delta === 1 ? '' : 's'} touched).`
    )
  }
  if (commits.length) {
    const latest = commits[0]
    findings.push(`Latest commit "${latest.message}" by ${latest.authorName}.`)
  }
  if (!findings.length) {
    findings.push('No notable findings beyond trivial changes.')
  }
  return findings
}

function classifyRisk(totals: DiffTotals): string {
  const size = totals.additions + totals.deletions
  if (size > 200 || totals.filesChanged > 20) return 'high'
  if (size > 80 || totals.filesChanged > 10) return 'medium'
  return 'low'
}

function buildFileComments(diff: FileDiff[], maxCommentsPerFile: number): ReviewEngineResult['fileComments'] {
  return diff
    .map((file) => {
      const hunkComments = file.hunks.slice(0, maxCommentsPerFile).map((hunk) => {
        const additions = hunk.lines.filter((line) => line.type === 'added').length
        const deletions = hunk.lines.filter((line) => line.type === 'removed').length
        const severity: 'warning' | 'suggestion' = additions + deletions > 20 ? 'warning' : 'suggestion'
        const comment = [
          `Lines ${hunk.newStart}-${hunk.newStart + Math.max(0, hunk.newLines - 1)}:`,
          additions && `+${additions} additions`,
          deletions && `-${deletions} deletions`
        ]
          .filter(Boolean)
          .join(' ')
        return {
          diffHunkHeader: hunk.header,
          comment: comment || 'Review the surrounding context for potential regressions.',
          severity
        }
      })
      return {
        filePath: file.path,
        hunkComments: hunkComments.filter((entry) => entry.comment.trim().length)
      }
    })
    .filter((entry) => entry.hunkComments.length)
}
