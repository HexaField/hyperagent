import { spawn } from 'node:child_process'
import path from 'node:path'
import type { ProjectsRepository, ProjectRecord } from '../projects'
import type {
  PullRequestCommitInput,
  PullRequestCommitsRepository,
  PullRequestEventsRepository,
  PullRequestsRepository
} from './persistence'
import type { PullRequestCommitRecord, PullRequestEventRecord, PullRequestRecord } from './types'

export type PullRequestDetail = {
  pullRequest: PullRequestRecord
  project: ProjectRecord
  commits: PullRequestCommitRecord[]
  events: PullRequestEventRecord[]
}

export type CreatePullRequestInput = {
  projectId: string
  title: string
  description?: string | null
  sourceBranch: string
  targetBranch?: string
  radiclePatchId?: string | null
  authorUserId: string
}

export type PullRequestModule = ReturnType<typeof createPullRequestModule>

export function createPullRequestModule(deps: {
  projects: ProjectsRepository
  pullRequests: PullRequestsRepository
  pullRequestCommits: PullRequestCommitsRepository
  pullRequestEvents: PullRequestEventsRepository
}) {
  return {
    createPullRequest,
    listPullRequests,
    getPullRequestWithCommits,
    updatePullRequestCommits,
    mergePullRequest,
    closePullRequest
  }

  async function createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRecord> {
    const project = ensureProject(deps.projects.getById(input.projectId))
    const targetBranch = input.targetBranch ?? project.defaultBranch
    await ensureBranchExists(project.repositoryPath, targetBranch)
    await ensureBranchExists(project.repositoryPath, input.sourceBranch)

    const record = deps.pullRequests.insert({
      projectId: project.id,
      title: input.title,
      description: input.description ?? null,
      sourceBranch: input.sourceBranch,
      targetBranch,
      radiclePatchId: input.radiclePatchId ?? null,
      authorUserId: input.authorUserId,
      status: 'open'
    })

    const commits = await readCommitsBetweenBranches(project.repositoryPath, input.sourceBranch, targetBranch)
    deps.pullRequestCommits.replaceAll(record.id, commits)

    deps.pullRequestEvents.insert({
      pullRequestId: record.id,
      kind: 'opened',
      actorUserId: input.authorUserId,
      data: {
        title: input.title,
        sourceBranch: input.sourceBranch,
        targetBranch
      }
    })
    commits.forEach((commit) =>
      deps.pullRequestEvents.insert({
        pullRequestId: record.id,
        kind: 'commit_added',
        actorUserId: commit.authorName,
        data: { commitHash: commit.commitHash, message: commit.message }
      })
    )
    return record
  }

  function listPullRequests(projectId: string): PullRequestRecord[] {
    return deps.pullRequests.listByProject(projectId)
  }

  function ensureProject(project: ProjectRecord | null): ProjectRecord {
    if (!project) {
      throw new Error('Unknown project')
    }
    if (!project.repositoryPath || !project.repositoryPath.length) {
      throw new Error('Project does not have a repository path')
    }
    return project
  }

  async function getPullRequestWithCommits(pullRequestId: string): Promise<PullRequestDetail | null> {
    const pullRequest = deps.pullRequests.getById(pullRequestId)
    if (!pullRequest) return null
    const project = ensureProject(deps.projects.getById(pullRequest.projectId))
    const commits = deps.pullRequestCommits.listByPullRequest(pullRequestId)
    const events = deps.pullRequestEvents.listByPullRequest(pullRequestId)
    return { pullRequest, project, commits, events }
  }

  async function updatePullRequestCommits(pullRequestId: string): Promise<void> {
    const detail = await getPullRequestWithCommits(pullRequestId)
    if (!detail) return
    const { project, pullRequest } = detail
    const previousHashes = new Set(detail.commits.map((commit) => commit.commitHash))
    const commits = await readCommitsBetweenBranches(
      project.repositoryPath,
      pullRequest.sourceBranch,
      pullRequest.targetBranch
    )
    deps.pullRequestCommits.replaceAll(pullRequest.id, commits)
    const newCommits = commits.filter((commit) => !previousHashes.has(commit.commitHash))
    newCommits.forEach((commit) =>
      deps.pullRequestEvents.insert({
        pullRequestId: pullRequest.id,
        kind: 'commit_added',
        actorUserId: commit.authorName,
        data: { commitHash: commit.commitHash, message: commit.message }
      })
    )
    deps.pullRequests.touch(pullRequest.id)
  }

  async function mergePullRequest(pullRequestId: string, actorUserId: string): Promise<void> {
    const detail = await getPullRequestWithCommits(pullRequestId)
    if (!detail) {
      throw new Error('Unknown pull request')
    }
    const { pullRequest, project } = detail
    if (pullRequest.status !== 'open') {
      throw new Error('Only open pull requests can be merged')
    }
    const repoPath = path.resolve(project.repositoryPath)
    const currentBranch = await readCurrentBranch(repoPath)
    try {
      await runGit(['checkout', pullRequest.targetBranch], repoPath)
      await runGit(['merge', '--no-ff', pullRequest.sourceBranch], repoPath)
    } catch (error) {
      await runGit(['merge', '--abort'], repoPath).catch(() => undefined)
      throw error
    } finally {
      if (currentBranch) {
        await runGit(['checkout', currentBranch], repoPath).catch(() => undefined)
      }
    }
    const mergedAt = new Date().toISOString()
    deps.pullRequests.updateStatus(pullRequest.id, 'merged', { mergedAt })
    deps.pullRequestEvents.insert({
      pullRequestId: pullRequest.id,
      kind: 'merged',
      actorUserId,
      data: { mergedAt }
    })
  }

  async function closePullRequest(pullRequestId: string, actorUserId: string): Promise<void> {
    const pullRequest = deps.pullRequests.getById(pullRequestId)
    if (!pullRequest) {
      throw new Error('Unknown pull request')
    }
    const closedAt = new Date().toISOString()
    deps.pullRequests.updateStatus(pullRequestId, 'closed', { closedAt })
    deps.pullRequestEvents.insert({
      pullRequestId,
      kind: 'closed',
      actorUserId,
      data: { closedAt }
    })
  }
}

async function ensureBranchExists(repoPath: string, branch: string): Promise<void> {
  await runGit(['rev-parse', '--verify', branch], repoPath)
}

async function readCommitsBetweenBranches(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string
): Promise<PullRequestCommitInput[]> {
  const format = '%H%x1f%an%x1f%ae%x1f%aI%x1f%s'
  const raw = await runGit(['log', `${targetBranch}..${sourceBranch}`, `--pretty=format:${format}`], repoPath)
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length)
    .map((line) => {
      const [commitHash, authorName, authorEmail, authoredAt, message] = line.split('\x1f')
      return {
        commitHash,
        authorName,
        authorEmail,
        authoredAt,
        message
      }
    })
}

async function readCurrentBranch(repoPath: string): Promise<string | null> {
  try {
    const output = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)
    return output.length ? output : null
  } catch {
    return null
  }
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
        resolve(stdout.trim())
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `git ${args.join(' ')} failed with code ${code}`))
      }
    })
  })
}
