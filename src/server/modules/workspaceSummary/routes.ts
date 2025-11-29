import { Router, type RequestHandler, type Response } from 'express'
import fs from 'fs/promises'
import { spawn } from 'node:child_process'
import os from 'os'
import path from 'path'
import type { Persistence, ProjectRecord, RadicleRegistrationRecord } from '../../../../src/modules/database'
import { listBranchCommits, listGitBranches } from '../../../../src/modules/git'
import type { RadicleModule } from '../../../../src/modules/radicle'
import type { WorkflowDetail, WorkflowRuntime } from '../../../../src/modules/workflows'
import { FILE_STASH_PREFIX, parseGitStashList } from '../../lib/git'

type WrapAsync = (handler: RequestHandler) => RequestHandler

type WorkspaceSummaryPersistence = Pick<Persistence, 'projects' | 'radicleRegistrations' | 'workflowSteps'>

type ReadGitMetadata = (repoPath: string) => Promise<any>

type GraphCommitNode = {
  id: string
  commitHash: string
  branch: string
  message: string
  label: string
  workflowId: string | null
  stepId: string | null
  timestamp: string
  authorName: string | null
  authorEmail: string | null
  source: 'hyperagent' | 'git'
}

type GraphEdge = {
  from: string
  to: string
}

export type WorkspaceSummaryDeps = {
  wrapAsync: WrapAsync
  persistence: WorkspaceSummaryPersistence
  radicleModule: RadicleModule
  workflowRuntime: WorkflowRuntime
  readGitMetadata: ReadGitMetadata
  runGitCommand: (args: string[], cwd: string) => Promise<string>
  graphBranchLimit: number
  graphCommitsPerBranch: number
  initializeWorkspaceRepository: (dirPath: string, defaultBranch: string) => Promise<string>
}

export const createWorkspaceSummaryRouter = (deps: WorkspaceSummaryDeps) => {
  const {
    wrapAsync,
    persistence,
    radicleModule,
    workflowRuntime,
    readGitMetadata,
    runGitCommand,
    graphBranchLimit,
    graphCommitsPerBranch,
    initializeWorkspaceRepository
  } = deps
  const router = Router()

  const collectGitMetadata = async (paths: string[]): Promise<Map<string, any>> => {
    const unique = [...new Set(paths.map((entry) => path.resolve(entry)))]
    const results = await Promise.all(unique.map(async (entry) => ({ path: entry, git: await readGitMetadata(entry) })))
    const map = new Map<string, any>()
    results.forEach((item) => {
      map.set(item.path, item.git)
    })
    return map
  }

  const isGitRepository = async (dirPath: string): Promise<boolean> => {
    try {
      await fs.access(path.join(dirPath, '.git'))
      return true
    } catch {
      return false
    }
  }

  const sortCommitsByTimestamp = (entries: GraphCommitNode[]): GraphCommitNode[] => {
    return entries.sort((a, b) => {
      const aTime = Date.parse(a.timestamp)
      const bTime = Date.parse(b.timestamp)
      if (!Number.isFinite(aTime) || !Number.isFinite(bTime)) {
        return a.timestamp.localeCompare(b.timestamp)
      }
      return aTime - bTime
    })
  }

  const extractCommitFromStep = (
    step: WorkflowDetail['steps'][number]
  ): { commitHash: string; branch: string; message: string } | null => {
    if (!step.result) return null
    const commitPayload = (step.result as Record<string, any>).commit as Record<string, any> | undefined
    if (!commitPayload?.commitHash) {
      return null
    }
    const branch =
      typeof commitPayload.branch === 'string' && commitPayload.branch.length ? commitPayload.branch : 'unknown'
    const message = typeof commitPayload.message === 'string' ? commitPayload.message : ''
    return {
      commitHash: String(commitPayload.commitHash),
      branch,
      message
    }
  }

  const sanitizeRepoIdComponent = (repoPath: string): string => {
    const normalized = repoPath.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    return normalized.length ? normalized : 'radicle-repo'
  }

  function createSyntheticProjectRecord(
    repoPath: string,
    registration: RadicleRegistrationRecord | null
  ): ProjectRecord {
    return {
      id: `rad-only-${sanitizeRepoIdComponent(repoPath)}`,
      name: registration?.name ?? (path.basename(repoPath) || repoPath),
      description: registration?.description ?? null,
      repositoryPath: repoPath,
      repositoryProvider: 'radicle',
      defaultBranch: registration?.defaultBranch ?? 'main',
      createdAt: registration?.registeredAt ?? new Date().toISOString()
    }
  }

  const radicleStatusHandler: RequestHandler = async (_req, res) => {
    try {
      const status = await radicleModule.getStatus()
      res.json({ status })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read Radicle status'
      res.status(500).json({ error: message })
    }
  }

  const radicleRepositoriesHandler: RequestHandler = async (_req, res) => {
    try {
      const projects = persistence.projects.list()
      const radicleRegistrations = persistence.radicleRegistrations.list()
      const projectMap = new Map(projects.map((project) => [path.resolve(project.repositoryPath), project]))
      const registrationMap = new Map(radicleRegistrations.map((entry) => [path.resolve(entry.repositoryPath), entry]))
      const uniquePaths = [...new Set([...projectMap.keys(), ...registrationMap.keys()])]
      if (!uniquePaths.length) {
        res.json({ repositories: [] })
        return
      }
      const gitMetadata = await collectGitMetadata(uniquePaths)
      const inspections = await Promise.all(
        uniquePaths.map(async (repoPath) => {
          try {
            const info = await radicleModule.inspectRepository(repoPath)
            if (info.registered) {
              const existingRegistration = registrationMap.get(repoPath)
              const stored = persistence.radicleRegistrations.upsert({
                repositoryPath: repoPath,
                name: existingRegistration?.name ?? projectMap.get(repoPath)?.name ?? path.basename(repoPath),
                description: existingRegistration?.description ?? undefined,
                visibility: existingRegistration?.visibility ?? undefined,
                defaultBranch: info.defaultBranch ?? existingRegistration?.defaultBranch ?? undefined
              })
              registrationMap.set(repoPath, stored)
            }
            return { path: repoPath, info }
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Radicle inspection failed'
            return { path: repoPath, info: null, error: message }
          }
        })
      )
      const inspectionMap = new Map<string, { info: unknown; error?: string }>()
      inspections.forEach((entry) => {
        inspectionMap.set(entry.path, entry)
      })
      const payload = uniquePaths.map((repoPath) => {
        const project =
          projectMap.get(repoPath) ?? createSyntheticProjectRecord(repoPath, registrationMap.get(repoPath) ?? null)
        const inspection = inspectionMap.get(repoPath)
        return {
          project,
          radicle: inspection?.info ?? null,
          git: gitMetadata.get(repoPath) ?? null,
          error: inspection?.error ?? null
        }
      })
      payload.sort((a, b) => a.project.name.localeCompare(b.project.name))
      res.json({ repositories: payload })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list Radicle repositories'
      res.status(500).json({ error: message })
    }
  }

  const registerRadicleRepositoryHandler: RequestHandler = async (req, res) => {
    const { repositoryPath, name, description, visibility } = req.body ?? {}
    if (!repositoryPath || typeof repositoryPath !== 'string') {
      res.status(400).json({ error: 'repositoryPath is required' })
      return
    }
    try {
      const resolvedPath = path.resolve(repositoryPath.trim())
      const repository = await radicleModule.registerRepository({
        repositoryPath: resolvedPath,
        name: typeof name === 'string' && name.length ? name : undefined,
        description: typeof description === 'string' && description.length ? description : undefined,
        visibility: visibility === 'public' || visibility === 'private' ? visibility : undefined
      })
      persistence.radicleRegistrations.upsert({
        repositoryPath: resolvedPath,
        name: typeof name === 'string' && name.length ? name : undefined,
        description: typeof description === 'string' && description.length ? description : undefined,
        visibility: visibility === 'public' || visibility === 'private' ? visibility : undefined,
        defaultBranch: repository.defaultBranch ?? undefined
      })
      res.json({ repository })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to register repository with Radicle'
      res.status(500).json({ error: message })
    }
  }

  const browseFilesystemHandler: RequestHandler = async (req, res) => {
    const requestedPath = typeof req.query.path === 'string' && req.query.path.length ? req.query.path : os.homedir()
    try {
      const resolved = path.resolve(requestedPath)
      const stats = await fs.stat(resolved)
      if (!stats.isDirectory()) {
        res.status(400).json({ error: 'Path is not a directory' })
        return
      }
      const entries = await fs.readdir(resolved, { withFileTypes: true })
      const directories = entries.filter((entry) => entry.isDirectory())
      const payload = await Promise.all(
        directories.map(async (entry) => {
          const absolute = path.join(resolved, entry.name)
          const gitRepo = await isGitRepository(absolute)
          let radicleRegistered = false
          let radicleRegistrationReason: string | null = null
          if (!gitRepo) {
            radicleRegistrationReason = 'Not a Git repository'
          } else {
            try {
              const info = await radicleModule.inspectRepository(absolute)
              radicleRegistered = info.registered
              if (radicleRegistered) {
                persistence.radicleRegistrations.upsert({
                  repositoryPath: absolute,
                  name: entry.name,
                  defaultBranch: info.defaultBranch ?? undefined
                })
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Failed to inspect repository for Radicle'
              radicleRegistrationReason = message
            }
          }
          return {
            name: entry.name,
            path: absolute,
            isGitRepository: gitRepo,
            radicleRegistered,
            radicleRegistrationReason
          }
        })
      )
      payload.sort((a, b) => a.name.localeCompare(b.name))
      const parent = path.dirname(resolved)
      const isRoot = resolved === path.parse(resolved).root
      res.json({
        path: resolved,
        parent: isRoot ? null : parent,
        entries: payload
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to browse filesystem'
      res.status(500).json({ error: message })
    }
  }

  const listProjectsHandler: RequestHandler = async (_req, res) => {
    try {
      const projects = persistence.projects.list()
      const gitMap = await collectGitMetadata(projects.map((project) => project.repositoryPath))
      const payload = projects.map((project) => ({
        ...project,
        git: gitMap.get(path.resolve(project.repositoryPath)) ?? null
      }))
      res.json({ projects: payload })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list projects'
      res.status(500).json({ error: message })
    }
  }

  const projectDetailHandler: RequestHandler = async (req, res) => {
    const projectId = req.params.projectId
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' })
      return
    }
    const project = persistence.projects.getById(projectId)
    if (!project) {
      res.status(404).json({ error: 'Unknown project' })
      return
    }
    try {
      const gitMap = await collectGitMetadata([project.repositoryPath])
      const payload = {
        ...project,
        git: gitMap.get(path.resolve(project.repositoryPath)) ?? null
      }
      res.json({ project: payload })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read project metadata'
      res.status(500).json({ error: message })
    }
  }

  const getProjectOr404 = (projectId: string | undefined, res: Response): ProjectRecord | null => {
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' })
      return null
    }
    const project = persistence.projects.getById(projectId)
    if (!project) {
      res.status(404).json({ error: 'Unknown project' })
      return null
    }
    return project
  }

  const respondWithUpdatedGit = async (res: Response, repoPath: string) => {
    try {
      const git = await readGitMetadata(repoPath)
      res.json({ git })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read git metadata'
      res.status(500).json({ error: message })
    }
  }

  const repositoryGraphHandler: RequestHandler = async (req, res) => {
    const projectId = req.params.projectId
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' })
      return
    }
    const project = persistence.projects.getById(projectId)
    if (!project) {
      res.status(404).json({ error: 'Unknown project' })
      return
    }

    try {
      const branchCandidates = [project.defaultBranch, ...(await listGitBranches(project.repositoryPath))]
      const gitBranches = [...new Set(branchCandidates)].slice(0, graphBranchLimit)
      const branchCommits = await Promise.all(
        gitBranches.map(async (branch) => {
          const commits = await listBranchCommits({
            repoPath: project.repositoryPath,
            branch,
            limit: graphCommitsPerBranch
          })
          return {
            branch,
            commits: commits.map<GraphCommitNode>((commit) => ({
              id: commit.hash,
              commitHash: commit.hash,
              branch,
              message: commit.message,
              label: commit.message || commit.hash,
              workflowId: null,
              stepId: null,
              timestamp: commit.timestamp,
              authorName: commit.authorName || null,
              authorEmail: commit.authorEmail || null,
              source: 'git'
            }))
          }
        })
      )

      const branchMap = new Map<string, GraphCommitNode[]>()
      branchCommits.forEach(({ branch, commits }) => {
        branchMap.set(branch, sortCommitsByTimestamp(commits))
      })
      if (!branchMap.size) {
        branchMap.set(project.defaultBranch, [])
      }

      const workflows = workflowRuntime.listWorkflows(projectId)
      workflows.forEach((workflow) => {
        const steps = persistence.workflowSteps.listByWorkflow(workflow.id)
        steps.forEach((step) => {
          const commit = extractCommitFromStep(step)
          if (!commit) return
          const branchName = commit.branch === 'unknown' ? project.defaultBranch : commit.branch
          const label =
            typeof step.data?.title === 'string' && step.data.title.length
              ? (step.data.title as string)
              : `Step ${step.sequence}`
          const node: GraphCommitNode = {
            id: commit.commitHash,
            commitHash: commit.commitHash,
            branch: branchName,
            message: commit.message,
            label,
            workflowId: workflow.id,
            stepId: step.id,
            timestamp: step.updatedAt,
            authorName: 'Hyperagent Workflow',
            authorEmail: null,
            source: 'hyperagent'
          }
          const list = branchMap.get(branchName) ?? []
          const existingIndex = list.findIndex((entry) => entry.commitHash === node.commitHash)
          if (existingIndex >= 0) {
            const existing = list[existingIndex]
            list[existingIndex] = {
              ...existing,
              label: node.label,
              workflowId: node.workflowId,
              stepId: node.stepId,
              source: 'hyperagent',
              timestamp: node.timestamp,
              authorName: existing.authorName ?? node.authorName,
              authorEmail: existing.authorEmail ?? node.authorEmail
            }
          } else {
            list.push(node)
          }
          branchMap.set(branchName, sortCommitsByTimestamp(list).slice(-graphCommitsPerBranch))
        })
      })

      const branches = [...branchMap.entries()].map(([name, commits]) => ({
        name,
        commits
      }))

      const edges: GraphEdge[] = []
      branches.forEach((branch) => {
        for (let index = 1; index < branch.commits.length; index++) {
          edges.push({ from: branch.commits[index - 1].id, to: branch.commits[index].id })
        }
      })

      res.json({ project, branches, edges })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to build repository graph'
      res.status(500).json({ error: message })
    }
  }

  const projectDiffHandler: RequestHandler = async (req, res) => {
    const projectId = req.params.projectId
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' })
      return
    }
    const project = persistence.projects.getById(projectId)
    if (!project) {
      res.status(404).json({ error: 'Unknown project' })
      return
    }
    const isRepo = await isGitRepository(project.repositoryPath)
    if (!isRepo) {
      res.status(400).json({ error: 'Project repository is not a Git repository' })
      return
    }
    try {
      const diffArgs = ['diff', '--stat', '--patch', '--unified=200']
      const diffText = await runGitCommand(diffArgs, project.repositoryPath)
      const statusText = await runGitCommand(['status', '-sb'], project.repositoryPath)
      res.json({
        projectId: project.id,
        diffText,
        hasChanges: diffText.trim().length > 0,
        status: statusText
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to compute project diff'
      res.status(500).json({ error: message })
    }
  }

  const createProjectHandler: RequestHandler = async (req, res) => {
    const { name, repositoryPath, description, defaultBranch, visibility } = req.body ?? {}
    if (!name || typeof name !== 'string' || !repositoryPath || typeof repositoryPath !== 'string') {
      res.status(400).json({ error: 'name and repositoryPath are required' })
      return
    }
    const normalizedName = name.trim()
    const normalizedBranch =
      typeof defaultBranch === 'string' && defaultBranch.trim().length ? defaultBranch.trim() : 'main'
    const normalizedDescription =
      typeof description === 'string' && description.trim().length ? description.trim() : undefined
    const normalizedPath = repositoryPath.trim()
    const normalizedVisibility = visibility === 'public' || visibility === 'private' ? visibility : 'private'
    let resolvedPath: string
    try {
      resolvedPath = await initializeWorkspaceRepository(normalizedPath, normalizedBranch)
      await fs.mkdir(path.join(resolvedPath, '.hyperagent'), { recursive: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to initialize workspace directory'
      res.status(500).json({ error: message })
      return
    }

    try {
      const registration = await radicleModule.registerRepository({
        repositoryPath: resolvedPath,
        name: normalizedName,
        description: normalizedDescription,
        visibility: normalizedVisibility
      })
      persistence.radicleRegistrations.upsert({
        repositoryPath: resolvedPath,
        name: normalizedName,
        description: normalizedDescription ?? null,
        visibility: normalizedVisibility,
        defaultBranch: registration.defaultBranch ?? normalizedBranch
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to register repository with Radicle'
      res.status(500).json({ error: message })
      return
    }

    const project = persistence.projects.getByRepositoryPath(resolvedPath)
    if (!project) {
      res.status(500).json({ error: 'Workspace is not eligible for Hyperagent (missing .hyperagent folder)' })
      return
    }
    res.status(201).json(project)
  }

  const gitStageHandler: RequestHandler = async (req, res) => {
    const project = getProjectOr404(req.params.projectId, res)
    if (!project) return
    const body = req.body ?? {}
    const paths = Array.isArray(body.paths)
      ? body.paths
          .filter((entry: unknown): entry is string => typeof entry === 'string')
          .map((entry: string) => entry.trim())
          .filter((entry: string) => entry.length)
      : []
    const mode = body.mode === 'unstage' ? 'unstage' : 'stage'
    if (!paths.length) {
      res.status(400).json({ error: 'paths are required' })
      return
    }
    try {
      if (mode === 'stage') {
        await runGitCommand(['add', '--', ...paths], project.repositoryPath)
      } else {
        await runGitCommand(['reset', 'HEAD', '--', ...paths], project.repositoryPath)
      }
      await respondWithUpdatedGit(res, project.repositoryPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update git stage'
      res.status(500).json({ error: message })
    }
  }

  const gitDiscardHandler: RequestHandler = async (req, res) => {
    const project = getProjectOr404(req.params.projectId, res)
    if (!project) return
    const { path: targetPath, isUntracked } = req.body ?? {}
    if (typeof targetPath !== 'string' || !targetPath.trim()) {
      res.status(400).json({ error: 'path is required' })
      return
    }
    try {
      if (isUntracked) {
        await runGitCommand(['clean', '-f', '-d', '--', targetPath], project.repositoryPath)
      } else {
        await runGitCommand(['checkout', '--', targetPath], project.repositoryPath)
      }
      await respondWithUpdatedGit(res, project.repositoryPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to discard changes'
      res.status(500).json({ error: message })
    }
  }

  const gitCommitHandler: RequestHandler = async (req, res) => {
    const project = getProjectOr404(req.params.projectId, res)
    if (!project) return
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
    if (!message) {
      res.status(400).json({ error: 'Commit message is required' })
      return
    }
    try {
      await runGitCommand(['commit', '-m', message], project.repositoryPath)
      await respondWithUpdatedGit(res, project.repositoryPath)
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Failed to commit changes'
      res.status(500).json({ error: text })
    }
  }

  const generateCommitMessageHandler: RequestHandler = async (req, res) => {
    const project = getProjectOr404(req.params.projectId, res)
    if (!project) return

    try {
      let prompt = 'Generate a concise git commit message following conventional commit format (type: description). '

      let diffContext = ''
      try {
        diffContext = await runGitCommand(['diff', '--staged'], project.repositoryPath)
        if (!diffContext.trim()) {
          diffContext = await runGitCommand(['diff'], project.repositoryPath)
        }
      } catch {
        // continue without diff context
      }

      if (diffContext.trim()) {
        prompt += `Here are the changes:\n\n${diffContext}\n\n`
      } else {
        prompt += 'Analyze the repository changes and generate an appropriate commit message. '
      }

      prompt += 'Only return the commit message, nothing else.'

      const result = await new Promise<string>((resolve, reject) => {
        const args = [
          'copilot',
          '-p',
          prompt,
          '--add-dir',
          project.repositoryPath,
          '--allow-tool',
          'shell(git:status)',
          '--allow-tool',
          'shell(git:diff)',
          '--allow-tool',
          'shell(git:diff --staged)',
          '--silent'
        ]

        const child = spawn('npx', args, {
          cwd: project.repositoryPath,
          stdio: ['pipe', 'pipe', 'pipe']
        })

        let stdout = ''
        let stderr = ''

        child.stdout?.on('data', (data) => {
          stdout += data.toString()
        })

        child.stderr?.on('data', (data) => {
          stderr += data.toString()
        })

        child.on('error', (error) => {
          reject(new Error(`Failed to spawn copilot: ${error.message}`))
        })

        child.on('close', (code) => {
          if (code === 0) {
            const message = stdout.trim()
            if (message) {
              resolve(message)
            } else {
              reject(new Error('No commit message generated'))
            }
          } else {
            const errorMsg = stderr.trim() || `copilot exited with code ${code}`
            reject(new Error(`Failed to generate commit message: ${errorMsg}`))
          }
        })
      })

      res.json({ commitMessage: result })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate commit message'
      res.status(500).json({ error: message })
    }
  }

  const gitCheckoutHandler: RequestHandler = async (req, res) => {
    const project = getProjectOr404(req.params.projectId, res)
    if (!project) return
    const ref = typeof req.body?.ref === 'string' ? req.body.ref.trim() : ''
    if (!ref) {
      res.status(400).json({ error: 'ref is required' })
      return
    }
    try {
      await runGitCommand(['checkout', ref], project.repositoryPath)
      await respondWithUpdatedGit(res, project.repositoryPath)
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Failed to checkout ref'
      res.status(500).json({ error: text })
    }
  }

  const gitStashHandler: RequestHandler = async (req, res) => {
    const project = getProjectOr404(req.params.projectId, res)
    if (!project) return
    const pathInput = typeof req.body?.path === 'string' ? req.body.path.trim() : ''
    if (!pathInput) {
      res.status(400).json({ error: 'path is required' })
      return
    }
    try {
      await runGitCommand(
        ['stash', 'push', '--include-untracked', '-m', `${FILE_STASH_PREFIX}${pathInput}`, '--', pathInput],
        project.repositoryPath
      )
      await respondWithUpdatedGit(res, project.repositoryPath)
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Failed to stash file'
      res.status(500).json({ error: text })
    }
  }

  const gitUnstashHandler: RequestHandler = async (req, res) => {
    const project = getProjectOr404(req.params.projectId, res)
    if (!project) return
    const pathInput = typeof req.body?.path === 'string' ? req.body.path.trim() : ''
    if (!pathInput) {
      res.status(400).json({ error: 'path is required' })
      return
    }
    try {
      const stashListRaw = await runGitCommand(['stash', 'list', '--pretty=%gd::%s'], project.repositoryPath)
      const stashEntries = parseGitStashList(stashListRaw)
      const entry = stashEntries.find((candidate) => candidate.filePath === pathInput)
      if (!entry) {
        res.status(404).json({ error: 'No stash found for path' })
        return
      }
      await runGitCommand(['checkout', entry.name, '--', pathInput], project.repositoryPath)
      await runGitCommand(['stash', 'drop', entry.name], project.repositoryPath)
      await respondWithUpdatedGit(res, project.repositoryPath)
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Failed to apply stash'
      res.status(500).json({ error: text })
    }
  }

  const gitFetchHandler: RequestHandler = async (req, res) => {
    const project = getProjectOr404(req.params.projectId, res)
    if (!project) return
    const remote = typeof req.body?.remote === 'string' ? req.body.remote.trim() : ''
    const branchInput = typeof req.body?.branch === 'string' ? req.body.branch.trim() : ''
    if (!remote) {
      res.status(400).json({ error: 'remote is required' })
      return
    }
    const args = branchInput ? ['fetch', remote, branchInput] : ['fetch', remote]
    try {
      await runGitCommand(args, project.repositoryPath)
      await respondWithUpdatedGit(res, project.repositoryPath)
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Failed to fetch remote'
      res.status(500).json({ error: text })
    }
  }

  const gitPullHandler: RequestHandler = async (req, res) => {
    const project = getProjectOr404(req.params.projectId, res)
    if (!project) return
    const remote = typeof req.body?.remote === 'string' ? req.body.remote.trim() : ''
    const branchInput = typeof req.body?.branch === 'string' ? req.body.branch.trim() : ''
    if (!remote) {
      res.status(400).json({ error: 'remote is required' })
      return
    }
    const args = branchInput ? ['pull', remote, branchInput] : ['pull', remote]
    try {
      await runGitCommand(args, project.repositoryPath)
      await respondWithUpdatedGit(res, project.repositoryPath)
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Failed to pull remote'
      res.status(500).json({ error: text })
    }
  }

  const gitPushHandler: RequestHandler = async (req, res) => {
    const project = getProjectOr404(req.params.projectId, res)
    if (!project) return
    const remote = typeof req.body?.remote === 'string' ? req.body.remote.trim() : ''
    const branchInput = typeof req.body?.branch === 'string' ? req.body.branch.trim() : ''
    if (!remote) {
      res.status(400).json({ error: 'remote is required' })
      return
    }
    const args = branchInput ? ['push', remote, branchInput] : ['push', remote]
    try {
      await runGitCommand(args, project.repositoryPath)
      await respondWithUpdatedGit(res, project.repositoryPath)
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Failed to push remote'
      res.status(500).json({ error: text })
    }
  }

  router.get('/api/radicle/status', wrapAsync(radicleStatusHandler))
  router.get('/api/radicle/repositories', wrapAsync(radicleRepositoriesHandler))
  router.post('/api/radicle/register', wrapAsync(registerRadicleRepositoryHandler))
  router.get('/api/fs/browse', wrapAsync(browseFilesystemHandler))
  router.get('/api/projects', wrapAsync(listProjectsHandler))
  router.get('/api/projects/:projectId', wrapAsync(projectDetailHandler))
  router.get('/api/projects/:projectId/graph', wrapAsync(repositoryGraphHandler))
  router.get('/api/projects/:projectId/diff', wrapAsync(projectDiffHandler))
  router.post('/api/projects', wrapAsync(createProjectHandler))
  router.post('/api/projects/:projectId/git/stage', wrapAsync(gitStageHandler))
  router.post('/api/projects/:projectId/git/discard', wrapAsync(gitDiscardHandler))
  router.post('/api/projects/:projectId/git/commit', wrapAsync(gitCommitHandler))
  router.post('/api/projects/:projectId/git/generate-commit-message', wrapAsync(generateCommitMessageHandler))
  router.post('/api/projects/:projectId/git/checkout', wrapAsync(gitCheckoutHandler))
  router.post('/api/projects/:projectId/git/stash', wrapAsync(gitStashHandler))
  router.post('/api/projects/:projectId/git/unstash', wrapAsync(gitUnstashHandler))
  router.post('/api/projects/:projectId/git/fetch', wrapAsync(gitFetchHandler))
  router.post('/api/projects/:projectId/git/pull', wrapAsync(gitPullHandler))
  router.post('/api/projects/:projectId/git/push', wrapAsync(gitPushHandler))

  return router
}
