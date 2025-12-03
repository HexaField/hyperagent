import { Router, type Request, type RequestHandler, type Response } from 'express'
import fs from 'fs/promises'
import { spawn } from 'node:child_process'
import path from 'path'
import type { ProjectRecord } from '../../../../src/modules/database'
import { listBranchCommits, listGitBranches } from '../../../../src/modules/git'
import { extractCommitFromWorkflowStep } from '../../../../src/modules/workflows'
import { FILE_STASH_PREFIX, parseGitStashList } from '../../lib/git'
import { createSseStream } from '../../lib/sse'
import type { WorkspaceSummaryDeps } from './types'
import { collectGitMetadata, isGitRepository } from './utils'

export type ProjectsRoutesDeps = WorkspaceSummaryDeps

export const createProjectsRoutes = (deps: ProjectsRoutesDeps) => {
  const router = Router()
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

  const listProjectsHandler: RequestHandler = async (_req, res) => {
    try {
      const projects = persistence.projects.list()
      const gitMap = await collectGitMetadata(
        projects.map((project) => project.repositoryPath),
        readGitMetadata
      )
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
      const gitMap = await collectGitMetadata([project.repositoryPath], readGitMetadata)
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

  const repositoryGraphHandler: RequestHandler = async (req, res) => {
    const project = getProjectOr404(req.params.projectId, res, persistence.projects)
    if (!project) return

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

      const workflows = workflowRuntime.listWorkflows(project.id)
      workflows.forEach((workflow) => {
        const steps = persistence.workflowSteps.listByWorkflow(workflow.id)
        steps.forEach((step) => {
          const commit = extractCommitFromWorkflowStep(step)
          if (!commit) return
          const branchName = commit.branch === 'unknown' ? project.defaultBranch : commit.branch
          const label =
            typeof step.data?.title === 'string' && step.data.title.length ? step.data.title : `Step ${step.sequence}`
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

      const branches = [...branchMap.entries()].map(([name, commits]) => ({ name, commits }))

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
    const project = getProjectOr404(req.params.projectId, res, persistence.projects)
    if (!project) return
    const isRepo = await isGitRepository(project.repositoryPath)
    if (!isRepo) {
      res.status(400).json({ error: 'Project repository is not a Git repository' })
      return
    }
    try {
      const diffText = await runGitCommand(['diff', '--stat', '--patch', '--unified=200'], project.repositoryPath)
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
    try {
      const project = await handleProjectCreation({
        req,
        res,
        persistence,
        radicleModule,
        initializeWorkspaceRepository,
        runGitCommand
      })
      if (project) {
        res.status(201).json(project)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create project'
      res.status(500).json({ error: message })
    }
  }

  const gitStageHandler: RequestHandler = async (req, res) => {
    const project = getProjectOr404(req.params.projectId, res, persistence.projects)
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
      await respondWithUpdatedGit(res, project.repositoryPath, readGitMetadata)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update git stage'
      res.status(500).json({ error: message })
    }
  }

  const gitDiscardHandler: RequestHandler = async (req, res) => {
    const project = getProjectOr404(req.params.projectId, res, persistence.projects)
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
      await respondWithUpdatedGit(res, project.repositoryPath, readGitMetadata)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to discard changes'
      res.status(500).json({ error: message })
    }
  }

  const gitCommitHandler: RequestHandler = async (req, res) => {
    const project = getProjectOr404(req.params.projectId, res, persistence.projects)
    if (!project) return
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
    if (!message) {
      res.status(400).json({ error: 'Commit message is required' })
      return
    }
    try {
      await runGitCommand(['commit', '-m', message], project.repositoryPath)
      await respondWithUpdatedGit(res, project.repositoryPath, readGitMetadata)
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Failed to commit changes'
      res.status(500).json({ error: text })
    }
  }

  const generateCommitMessageHandler: RequestHandler = async (req, res) => {
    const project = getProjectOr404(req.params.projectId, res, persistence.projects)
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
        /* continue without diff context */
      }

      if (diffContext.trim()) {
        prompt += `Here are the changes:\n\n${diffContext}\n\n`
      } else {
        prompt += 'Analyze the repository changes and generate an appropriate commit message. '
      }

      prompt += 'Only return the commit message, nothing else.'

      const result = await runCopilotPrompt(prompt, project.repositoryPath)
      res.json({ commitMessage: result })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate commit message'
      res.status(500).json({ error: message })
    }
  }

  const gitCheckoutHandler: RequestHandler = async (req, res) => {
    const project = getProjectOr404(req.params.projectId, res, persistence.projects)
    if (!project) return
    const ref = typeof req.body?.ref === 'string' ? req.body.ref.trim() : ''
    if (!ref) {
      res.status(400).json({ error: 'ref is required' })
      return
    }
    try {
      await runGitCommand(['checkout', ref], project.repositoryPath)
      await respondWithUpdatedGit(res, project.repositoryPath, readGitMetadata)
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Failed to checkout ref'
      res.status(500).json({ error: text })
    }
  }

  const gitStashHandler: RequestHandler = async (req, res) => {
    const project = getProjectOr404(req.params.projectId, res, persistence.projects)
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
      await respondWithUpdatedGit(res, project.repositoryPath, readGitMetadata)
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Failed to stash file'
      res.status(500).json({ error: text })
    }
  }

  const gitUnstashHandler: RequestHandler = async (req, res) => {
    const project = getProjectOr404(req.params.projectId, res, persistence.projects)
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
      await respondWithUpdatedGit(res, project.repositoryPath, readGitMetadata)
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Failed to apply stash'
      res.status(500).json({ error: text })
    }
  }

  const gitFetchHandler: RequestHandler = async (req, res) => {
    const project = getProjectOr404(req.params.projectId, res, persistence.projects)
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
      await respondWithUpdatedGit(res, project.repositoryPath, readGitMetadata)
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Failed to fetch remote'
      res.status(500).json({ error: text })
    }
  }

  const gitPullHandler: RequestHandler = async (req, res) => {
    const project = getProjectOr404(req.params.projectId, res, persistence.projects)
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
      await respondWithUpdatedGit(res, project.repositoryPath, readGitMetadata)
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Failed to pull remote'
      res.status(500).json({ error: text })
    }
  }

  const gitPushHandler: RequestHandler = async (req, res) => {
    const project = getProjectOr404(req.params.projectId, res, persistence.projects)
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
      await respondWithUpdatedGit(res, project.repositoryPath, readGitMetadata)
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Failed to push remote'
      res.status(500).json({ error: text })
    }
  }

  router.get('/', wrapAsync(listProjectsHandler))
  router.get('/:projectId', wrapAsync(projectDetailHandler))
  router.get('/:projectId/graph', wrapAsync(repositoryGraphHandler))
  router.get('/:projectId/diff', wrapAsync(projectDiffHandler))
  router.post('/', wrapAsync(createProjectHandler))
  router.post('/:projectId/git/stage', wrapAsync(gitStageHandler))
  router.post('/:projectId/git/discard', wrapAsync(gitDiscardHandler))
  router.post('/:projectId/git/commit', wrapAsync(gitCommitHandler))
  router.post('/:projectId/git/generate-commit-message', wrapAsync(generateCommitMessageHandler))
  router.post('/:projectId/git/checkout', wrapAsync(gitCheckoutHandler))
  router.post('/:projectId/git/stash', wrapAsync(gitStashHandler))
  router.post('/:projectId/git/unstash', wrapAsync(gitUnstashHandler))
  router.post('/:projectId/git/fetch', wrapAsync(gitFetchHandler))
  router.post('/:projectId/git/pull', wrapAsync(gitPullHandler))
  router.post('/:projectId/git/push', wrapAsync(gitPushHandler))

  return router
}

const respondWithUpdatedGit = async (
  res: Response,
  repoPath: string,
  readGitMetadata: ProjectsRoutesDeps['readGitMetadata']
) => {
  try {
    const git = await readGitMetadata(repoPath)
    res.json({ git })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read git metadata'
    res.status(500).json({ error: message })
  }
}

const getProjectOr404 = (
  projectId: string | undefined,
  res: Response,
  projectsRepo: ProjectsRoutesDeps['persistence']['projects']
): ProjectRecord | null => {
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' })
    return null
  }
  const project = projectsRepo.getById(projectId)
  if (!project) {
    res.status(404).json({ error: 'Unknown project' })
    return null
  }
  return project
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

const runCopilotPrompt = async (prompt: string, cwd: string): Promise<string> => {
  return await new Promise<string>((resolve, reject) => {
    const args = [
      'copilot',
      '-p',
      prompt,
      '--add-dir',
      cwd,
      '--allow-tool',
      'shell(git:status)',
      '--allow-tool',
      'shell(git:diff)',
      '--allow-tool',
      'shell(git:diff --staged)',
      '--silent'
    ]

    const child = spawn('npx', args, {
      cwd,
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
}

type ProjectCreationContext = {
  req: Request
  res: Response
  persistence: ProjectsRoutesDeps['persistence']
  radicleModule: ProjectsRoutesDeps['radicleModule']
  initializeWorkspaceRepository: ProjectsRoutesDeps['initializeWorkspaceRepository']
  runGitCommand: ProjectsRoutesDeps['runGitCommand']
}

const handleProjectCreation = async (ctx: ProjectCreationContext): Promise<ProjectRecord | null> => {
  const { req, res, persistence, radicleModule, initializeWorkspaceRepository, runGitCommand } = ctx
  const { name, repositoryPath, description, defaultBranch, visibility, templateId } = req.body ?? {}
  const normalizedBranch =
    typeof defaultBranch === 'string' && defaultBranch.trim().length ? defaultBranch.trim() : 'main'
  const normalizedDescription =
    typeof description === 'string' && description.trim().length ? description.trim() : undefined
  const normalizedVisibility = visibility === 'public' || visibility === 'private' ? visibility : 'private'

  let resolvedPath: string
  if (typeof templateId === 'string' && templateId.trim()) {
    const requestPathRaw =
      typeof repositoryPath === 'string' && repositoryPath.trim()
        ? repositoryPath.trim()
        : typeof req.body?.path === 'string' && req.body.path.trim()
          ? req.body.path.trim()
          : ''
    const wantsStream = String(req.headers.accept ?? '').includes('text/event-stream')
    if (wantsStream) {
      return await createProjectFromTemplateStream({
        templateId,
        requestPathRaw,
        normalizedBranch,
        normalizedDescription,
        normalizedVisibility,
        req,
        res,
        radicleModule,
        persistence,
        runGitCommand,
        initializeWorkspaceRepository
      })
    }
    return await createProjectFromTemplate({
      templateId,
      requestPathRaw,
      normalizedBranch,
      normalizedDescription,
      normalizedVisibility,
      radicleModule,
      persistence,
      runGitCommand,
      initializeWorkspaceRepository,
      res
    })
  }

  if (!name || typeof name !== 'string' || !repositoryPath || typeof repositoryPath !== 'string') {
    res.status(400).json({ error: 'name and repositoryPath are required' })
    return null
  }
  const normalizedName = name.trim()
  const normalizedPath = repositoryPath.trim()
  try {
    resolvedPath = await initializeWorkspaceRepository(normalizedPath, normalizedBranch)
    await fs.mkdir(path.join(resolvedPath, '.hyperagent'), { recursive: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to initialize workspace directory'
    res.status(500).json({ error: message })
    return null
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
    return null
  }

  const project = persistence.projects.getByRepositoryPath(resolvedPath)
  if (!project) {
    res.status(500).json({ error: 'Workspace is not eligible for Hyperagent (missing .hyperagent folder)' })
    return null
  }
  return project
}

type TemplateProjectContext = {
  templateId: string
  requestPathRaw: string
  normalizedBranch: string
  normalizedDescription?: string
  normalizedVisibility: 'public' | 'private'
  radicleModule: ProjectsRoutesDeps['radicleModule']
  persistence: ProjectsRoutesDeps['persistence']
  runGitCommand: ProjectsRoutesDeps['runGitCommand']
  initializeWorkspaceRepository: ProjectsRoutesDeps['initializeWorkspaceRepository']
  res: Response
}

type TemplateStreamContext = TemplateProjectContext & {
  req: Request
}

const createProjectFromTemplate = async (ctx: TemplateProjectContext): Promise<ProjectRecord | null> => {
  const {
    templateId,
    requestPathRaw,
    normalizedBranch,
    normalizedDescription,
    normalizedVisibility,
    radicleModule,
    persistence,
    initializeWorkspaceRepository,
    res
  } = ctx

  if (!requestPathRaw) {
    res.status(400).json({ error: 'repositoryPath (or path) is required when creating from template' })
    return null
  }
  const templateDir = path.resolve(process.cwd(), 'templates', templateId.trim())
  const targetPath = path.resolve(requestPathRaw)

  try {
    await fs.stat(templateDir)
  } catch {
    res.status(404).json({ error: `Template not found: ${templateId}` })
    return null
  }

  try {
    const existing = await fs.stat(targetPath)
    if (existing) {
      res.status(400).json({ error: `Target path already exists: ${targetPath}` })
      return null
    }
  } catch {
    /* not exists */
  }

  try {
    await fs.mkdir(targetPath, { recursive: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create target directory'
    res.status(500).json({ error: message })
    return null
  }

  const manifestPath = path.join(templateDir, 'template.json')
  let manifest: any = null
  try {
    const raw = await fs.readFile(manifestPath, 'utf8')
    manifest = JSON.parse(raw)
  } catch {
    /* manifest optional */
  }

  if (manifest && typeof manifest.url === 'string' && manifest.url.trim()) {
    const cloneUrl = manifest.url.trim()
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('git', ['clone', cloneUrl, targetPath], { stdio: 'inherit' })
        child.once('error', reject)
        child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`git clone failed with ${code}`))))
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : `Failed to clone template url: ${String(err)}`
      res.status(500).json({ error: message })
      return null
    }
  } else {
    try {
      try {
        await fs.cp(templateDir, targetPath, { recursive: true })
      } catch {
        const cp = spawn('cp', ['-a', `${templateDir}/.`, targetPath])
        await new Promise<void>((resolve, reject) => {
          cp.once('error', reject)
          cp.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`cp failed with ${code}`))))
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to copy template files'
      res.status(500).json({ error: message })
      return null
    }
  }

  if (manifest && Array.isArray(manifest.setup) && manifest.setup.length) {
    for (let i = 0; i < manifest.setup.length; i++) {
      const cmd = String(manifest.setup[i])
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(cmd, { shell: true, cwd: targetPath, env: process.env })
          child.once('error', (err2) => reject(err2))
          child.once('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`Command failed with code ${code}`))
          })
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Template setup command failed'
        res.status(500).json({ error: message })
        return null
      }
    }
  }

  try {
    await fs.mkdir(path.join(targetPath, '.hyperagent'), { recursive: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create .hyperagent'
    res.status(500).json({ error: message })
    return null
  }

  let resolvedPath: string
  try {
    resolvedPath = await initializeWorkspaceRepository(targetPath, normalizedBranch)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to initialize workspace repository'
    res.status(500).json({ error: message })
    return null
  }

  try {
    const rawName = path.basename(resolvedPath)
    let normalizedName = rawName.replace(/[^A-Za-z0-9._-]+/g, '-')
    normalizedName = normalizedName.replace(/^[._-]+|[._-]+$/g, '')
    if (!normalizedName.length) normalizedName = rawName

    await radicleModule.registerRepository({
      repositoryPath: resolvedPath,
      name: normalizedName,
      description: manifest?.description ?? normalizedDescription,
      visibility: manifest?.visibility === 'public' ? 'public' : normalizedVisibility
    })
    persistence.radicleRegistrations.upsert({
      repositoryPath: resolvedPath,
      name: path.basename(resolvedPath),
      description: manifest?.description ?? normalizedDescription ?? null,
      visibility: manifest?.visibility === 'public' ? 'public' : normalizedVisibility,
      defaultBranch: normalizedBranch
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to register repository with Radicle'
    res.status(500).json({ error: message })
    return null
  }

  const project = persistence.projects.getByRepositoryPath(resolvedPath)
  if (!project) {
    res.status(500).json({ error: 'Workspace is not eligible for Hyperagent (missing .hyperagent folder)' })
    return null
  }
  return project
}

const createProjectFromTemplateStream = async (ctx: TemplateStreamContext): Promise<ProjectRecord | null> => {
  const {
    templateId,
    requestPathRaw,
    normalizedBranch,
    normalizedDescription,
    normalizedVisibility,
    req,
    res,
    radicleModule,
    persistence,
    runGitCommand,
    initializeWorkspaceRepository
  } = ctx

  const sse = createSseStream(res, req, { keepAliveMs: 15000 })
  const emit = (packet: Record<string, unknown>) => {
    try {
      sse.emit(packet)
    } catch {
      /* ignore */
    }
  }

  emit({
    type: 'start',
    level: 'info',
    message: 'Create from template started',
    templateId,
    path: requestPathRaw ?? null
  })

  if (!requestPathRaw) {
    emit({ type: 'error', level: 'error', message: 'repositoryPath (or path) is required when creating from template' })
    sse.close()
    return null
  }
  const templateDir = path.resolve(process.cwd(), 'templates', templateId.trim())
  const targetPath = path.resolve(requestPathRaw)

  try {
    await fs.stat(templateDir)
  } catch {
    emit({ type: 'error', level: 'error', message: `Template not found: ${templateId}` })
    sse.close()
    return null
  }

  try {
    const existing = await fs.stat(targetPath)
    if (existing) {
      emit({ type: 'error', level: 'error', message: `Target path already exists: ${targetPath}` })
      sse.close()
      return null
    }
  } catch {
    /* ok */
  }

  emit({ type: 'step', level: 'info', message: 'Creating target directory', path: targetPath })
  try {
    await fs.mkdir(targetPath, { recursive: true })
  } catch (err) {
    emit({ type: 'error', level: 'error', message: String(err) })
    sse.close()
    return null
  }

  emit({ type: 'step', level: 'info', message: 'Reading template manifest' })
  const manifestPath = path.join(templateDir, 'template.json')
  let manifest: any = null
  try {
    const raw = await fs.readFile(manifestPath, 'utf8')
    manifest = JSON.parse(raw)
  } catch {
    /* optional */
  }

  if (manifest && typeof manifest.url === 'string' && manifest.url.trim()) {
    const cloneUrl = manifest.url.trim()
    emit({ type: 'step', level: 'info', message: `Cloning template from ${cloneUrl}` })
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('git', ['clone', cloneUrl, targetPath], { stdio: ['ignore', 'pipe', 'pipe'] })
        child.stdout?.on('data', (chunk) =>
          emit({ type: 'stdout', level: 'info', chunk: String(chunk), message: String(chunk) })
        )
        child.stderr?.on('data', (chunk) =>
          emit({ type: 'stderr', level: 'warn', chunk: String(chunk), message: String(chunk) })
        )
        child.once('error', reject)
        child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`git clone failed with ${code}`))))
      })
    } catch (err) {
      emit({
        type: 'error',
        level: 'error',
        message: `Failed to clone template url: ${err instanceof Error ? err.message : String(err)}`
      })
      sse.close()
      return null
    }
  } else {
    emit({ type: 'step', level: 'info', message: 'Copying template files' })
    try {
      try {
        await fs.cp(templateDir, targetPath, { recursive: true })
      } catch {
        const cp = spawn('cp', ['-a', `${templateDir}/.`, targetPath])
        await new Promise<void>((resolve, reject) => {
          cp.once('error', reject)
          cp.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`cp failed with ${code}`))))
        })
      }
    } catch (err) {
      emit({ type: 'error', level: 'error', message: `Failed to copy template files: ${String(err)}` })
      sse.close()
      return null
    }
  }

  if (manifest && Array.isArray(manifest.setup) && manifest.setup.length) {
    for (let i = 0; i < manifest.setup.length; i++) {
      const cmd = String(manifest.setup[i])
      emit({ type: 'step', level: 'info', message: `Running setup command: ${cmd}`, index: i })
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(cmd, { shell: true, cwd: targetPath, env: process.env })
          child.stdout?.on('data', (chunk) =>
            emit({ type: 'stdout', level: 'info', chunk: String(chunk), message: String(chunk) })
          )
          child.stderr?.on('data', (chunk) =>
            emit({ type: 'stderr', level: 'warn', chunk: String(chunk), message: String(chunk) })
          )
          child.once('error', (err2) => reject(err2))
          child.once('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`Command failed with code ${code}`))
          })
        })
      } catch (err) {
        emit({
          type: 'error',
          level: 'error',
          message: `Setup command failed: ${err instanceof Error ? err.message : String(err)}`
        })
        sse.close()
        return null
      }
    }
  }

  try {
    emit({ type: 'step', level: 'info', message: 'Initializing hyperagent metadata' })
    await fs.mkdir(path.join(targetPath, '.hyperagent'), { recursive: true })
  } catch (err) {
    emit({ type: 'error', level: 'error', message: `Failed to create .hyperagent: ${String(err)}` })
    sse.close()
    return null
  }

  emit({ type: 'step', level: 'info', message: 'Initializing Git repository (if missing)' })
  try {
    await initializeWorkspaceRepository(targetPath, normalizedBranch)

    let hasHead = true
    try {
      await runGitCommand(['rev-parse', '--verify', 'HEAD'], targetPath)
    } catch {
      hasHead = false
    }

    if (!hasHead) {
      emit({ type: 'step', level: 'info', message: 'Creating initial Git commit' })
      try {
        await runGitCommand(['add', '--all'], targetPath)
        const authorFlag = `${(req.app as any).commitAuthor?.name ?? 'Hyperagent'} <${(req.app as any).commitAuthor?.email ?? 'workflow@hyperagent.local'}>`
        await runGitCommand(
          ['commit', '-m', 'Initial commit (created from template)', `--author=${authorFlag}`],
          targetPath
        )
        emit({ type: 'info', level: 'info', message: 'Initial commit created' })
      } catch (commitErr) {
        emit({
          type: 'error',
          level: 'error',
          message: `Failed to create initial commit: ${commitErr instanceof Error ? commitErr.message : String(commitErr)}`
        })
        sse.close()
        return null
      }
    } else {
      emit({ type: 'info', level: 'info', message: 'Repository already has commits' })
    }
  } catch (err) {
    emit({
      type: 'error',
      level: 'error',
      message: `Git initialization failed: ${err instanceof Error ? err.message : String(err)}`
    })
    sse.close()
    return null
  }

  emit({ type: 'step', level: 'info', message: 'Registering repository with Radicle' })
  try {
    const rawName = path.basename(targetPath)
    let normalizedName = rawName.replace(/[^A-Za-z0-9._-]+/g, '-')
    normalizedName = normalizedName.replace(/^[._-]+|[._-]+$/g, '')
    if (!normalizedName.length) normalizedName = rawName
    if (normalizedName !== rawName)
      emit({ type: 'info', level: 'info', message: `Template name sanitized to '${normalizedName}'` })

    const registration = await radicleModule.registerRepository({
      repositoryPath: targetPath,
      name: normalizedName,
      description: manifest?.description ?? normalizedDescription,
      visibility: manifest?.visibility === 'public' ? 'public' : normalizedVisibility
    })

    try {
      persistence.radicleRegistrations.upsert({
        repositoryPath: targetPath,
        name: path.basename(targetPath),
        description: manifest?.description ?? normalizedDescription ?? null,
        visibility: manifest?.visibility === 'public' ? 'public' : normalizedVisibility,
        defaultBranch: registration.defaultBranch ?? normalizedBranch
      })
    } catch (err) {
      console.warn('Failed to persist radicle registration', { error: err })
    }

    emit({
      type: 'done',
      level: 'info',
      message: 'Template creation complete',
      repository: registration,
      repositoryName: normalizedName
    })
    sse.close()
  } catch (err) {
    emit({
      type: 'error',
      level: 'error',
      message: `Radicle registration_failed: ${err instanceof Error ? err.message : String(err)}`
    })
    sse.close()
    return null
  }

  const project = persistence.projects.getByRepositoryPath(targetPath)
  return project ?? null
}

export type GraphCommitNode = {
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

export type GraphEdge = {
  from: string
  to: string
}
