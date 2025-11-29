import { useSearchParams } from '@solidjs/router'
import { For, Show, createEffect, createMemo, createResource, createSignal, onMount } from 'solid-js'
import { buildSessionWorkflowPayload } from '../../../lib/sessions'
import { fetchJson } from '../../../shared/api/httpClient'
import type { GitInfo } from '../../../types/git'
import { useWorkspaceSelection } from '../../state/WorkspaceSelectionContext'

const BROWSER_PAGE_SIZE = 10
const BROWSER_STATE_STORAGE_KEY = 'hyperagent:repoBrowser'

export type Project = {
  id: string
  name: string
  description?: string | null
  repositoryPath: string
  defaultBranch: string
  createdAt: string
  git?: GitInfo | null
}

type RadicleRepositoryEntry = {
  project: Project
  radicle: {
    repositoryPath: string
    radicleProjectId: string | null
    remoteUrl: string | null
    defaultBranch: string | null
    registered: boolean
  } | null
  git: GitInfo | null
  error?: string | null
}

type DirectoryEntry = {
  name: string
  path: string
  isGitRepository: boolean
  radicleRegistered: boolean
  radicleRegistrationReason: string | null
}

type DirectoryListing = {
  path: string
  parent: string | null
  entries: DirectoryEntry[]
}

type WorkflowCreationResponse = {
  workflow: {
    id: string
  }
}

const toBasename = (input: string) => {
  const normalized = input.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = normalized.split('/')
  return parts[parts.length - 1] || normalized
}

const normalizeFsPath = (input: string | undefined | null) => {
  if (!input) return ''
  const replaced = input.replace(/\\/g, '/')
  if (replaced === '/') return replaced
  const trimmed = replaced.replace(/\/+$/, '')
  return trimmed.length ? trimmed : replaced
}

export default function RepositoryNavigator() {
  const selection = useWorkspaceSelection()
  const [, setSearchParams] = useSearchParams()
  const [form, setForm] = createSignal({
    name: '',
    repositoryPath: '',
    description: '',
    defaultBranch: 'main'
  })
  const [status, setStatus] = createSignal<string | null>(null)
  const [browser, setBrowser] = createSignal<DirectoryListing | null>(null)
  const [browserLoading, setBrowserLoading] = createSignal(false)
  const [browserError, setBrowserError] = createSignal<string | null>(null)
  const [browserPathInput, setBrowserPathInput] = createSignal('')
  const [browserExpanded, setBrowserExpanded] = createSignal(true)
  const [browserPage, setBrowserPage] = createSignal(1)
  const [browserPathInvalid, setBrowserPathInvalid] = createSignal(false)
  const [folderStatus, setFolderStatus] = createSignal<string | null>(null)
  const [expandedProjects, setExpandedProjects] = createSignal(new Set<string>())
  const [expandedRadRepos, setExpandedRadRepos] = createSignal(new Set<string>())
  const [newRepoModalOpen, setNewRepoModalOpen] = createSignal(false)
  const [sessionProject, setSessionProject] = createSignal<Project | null>(null)
  const [sessionName, setSessionName] = createSignal('')
  const [sessionDetails, setSessionDetails] = createSignal('')
  const [sessionStatus, setSessionStatus] = createSignal<string | null>(null)
  const [sessionSubmitting, setSessionSubmitting] = createSignal(false)
  const [radicleConversionPath, setRadicleConversionPath] = createSignal<string | null>(null)
  const [radicleConversionStatus, setRadicleConversionStatus] = createSignal<string | null>(null)
  let lastKnownBrowserPath: string | undefined

  const [projects, { refetch: refetchProjects }] = createResource(async () => {
    const payload = await fetchJson<{ projects: Project[] }>('/api/projects')
    return payload.projects
  })

  const [radicleRepositories, { refetch: refetchRadicleRepositories }] = createResource(async () => {
    const payload = await fetchJson<{ repositories: RadicleRepositoryEntry[] }>('/api/radicle/repositories')
    return payload.repositories
  })

  const registeredRadiclePaths = createMemo(() => {
    const entries = radicleRepositories()
    if (!entries) return new Set<string>()
    const registered = new Set<string>()
    entries.forEach((entry) => {
      if (!entry.radicle?.registered) return
      const repoPath = entry.radicle.repositoryPath
      if (repoPath) {
        registered.add(normalizeFsPath(repoPath))
      }
    })
    return registered
  })

  const isPathRegisteredWithRadicle = (repoPath: string, precomputed?: boolean) => {
    if (precomputed) return true
    return registeredRadiclePaths().has(normalizeFsPath(repoPath))
  }

  const handleSubmit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!form().name.trim() || !form().repositoryPath.trim()) {
      setStatus('Project name and repository path are required')
      return
    }
    try {
      await fetchJson<Project>('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form().name.trim(),
          repositoryPath: form().repositoryPath.trim(),
          description: form().description.trim() || undefined,
          defaultBranch: form().defaultBranch.trim() || undefined
        })
      })
      setForm({ name: '', repositoryPath: '', description: '', defaultBranch: 'main' })
      setStatus('Project created')
      await refreshProjects()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to create project')
    }
  }

  const refreshProjects = async () => {
    await Promise.all([refetchProjects(), refetchRadicleRepositories(), selection.refetchWorkspaces()])
  }

  const loadDirectory = async (targetPath?: string) => {
    setBrowserLoading(true)
    const query = targetPath ? `?path=${encodeURIComponent(targetPath)}` : ''
    try {
      const payload = await fetchJson<DirectoryListing>(`/api/fs/browse${query}`)
      setBrowser(payload)
      setBrowserPathInput(payload.path)
      setBrowserError(null)
      setBrowserPage(1)
      setBrowserPathInvalid(false)
      lastKnownBrowserPath = payload.path
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to browse filesystem'
      setBrowserError(message)
      const normalized = message.toLowerCase()
      const invalid =
        normalized.includes('no such file') ||
        normalized.includes('enoent') ||
        normalized.includes('not a directory') ||
        normalized.includes('path is not a directory')
      setBrowserPathInvalid(invalid)
    } finally {
      setBrowserLoading(false)
    }
  }

  const browseToParent = async () => {
    const parent = browser()?.parent
    if (!parent) return
    await loadDirectory(parent)
  }

  const registerRadicleRepo = async (repoPath: string) => {
    setFolderStatus(`Registering ${repoPath}…`)
    try {
      await fetchJson('/api/radicle/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repositoryPath: repoPath,
          name: toBasename(repoPath),
          description: 'Registered via Hyperagent',
          visibility: 'private'
        })
      })
      setFolderStatus('Repository registered with Radicle')
      await Promise.all([refreshProjects(), loadDirectory(browserPathInput())])
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to register repository'
      setFolderStatus(message)
    }
  }

  const toggleExpanded = (
    setCollection: (value: Set<string> | ((prev: Set<string>) => Set<string>)) => void,
    id: string
  ) => {
    setCollection((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const openNewRepoModal = () => {
    setStatus(null)
    setNewRepoModalOpen(true)
  }

  const closeNewRepoModal = () => {
    setNewRepoModalOpen(false)
    setStatus(null)
  }

  const openSessionModal = (project: Project) => {
    setSessionProject(project)
    setSessionName(`${project.name} session`)
    setSessionDetails('')
    setSessionStatus(null)
  }

  const isSyntheticProject = (project: Project) => project.id.startsWith('rad-only-')

  const convertRadicleRepository = async (entry: RadicleRepositoryEntry) => {
    const repoPath = entry.project.repositoryPath
    setRadicleConversionPath(repoPath)
    setRadicleConversionStatus(null)
    try {
      await fetchJson<Project>('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: entry.project.name,
          repositoryPath: repoPath,
          description: entry.project.description ?? undefined,
          defaultBranch: entry.radicle?.defaultBranch ?? entry.project.defaultBranch ?? 'main'
        })
      })
      setRadicleConversionStatus(`Converted ${entry.project.name} into a Hyperagent project`)
      await refreshProjects()
    } catch (error) {
      setRadicleConversionStatus(error instanceof Error ? error.message : 'Failed to convert repository')
    } finally {
      setRadicleConversionPath(null)
    }
  }

  const closeSessionModal = (force = false) => {
    if (sessionSubmitting() && !force) return
    setSessionProject(null)
    setSessionName('')
    setSessionDetails('')
    setSessionStatus(null)
    setSessionSubmitting(false)
  }

  const handleSessionSubmit = async (event: SubmitEvent) => {
    event.preventDefault()
    const project = sessionProject()
    if (!project) return
    let payload
    try {
      payload = buildSessionWorkflowPayload({
        projectId: project.id,
        sessionName: sessionName(),
        sessionDetails: sessionDetails()
      })
    } catch (error) {
      setSessionStatus(error instanceof Error ? error.message : 'Invalid session details')
      return
    }
    try {
      setSessionSubmitting(true)
      const response = await fetchJson<WorkflowCreationResponse>('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const workflowId = response.workflow.id
      closeSessionModal(true)
      selection.setWorkspaceId(project.id)
      setSearchParams({ workspaceId: project.id, sessionId: workflowId })
    } catch (error) {
      setSessionStatus(error instanceof Error ? error.message : 'Failed to start session')
    } finally {
      setSessionSubmitting(false)
    }
  }

  onMount(() => {
    let initialPath: string | undefined
    if (typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem(BROWSER_STATE_STORAGE_KEY)
        if (raw) {
          const stored = JSON.parse(raw)
          if (typeof stored === 'object' && stored !== null) {
            if (typeof stored.expanded === 'boolean') {
              setBrowserExpanded(stored.expanded)
            }
            if (typeof stored.path === 'string' && stored.path.length) {
              initialPath = stored.path
              lastKnownBrowserPath = stored.path
            }
          }
        }
      } catch {
        // ignore storage errors
      }
    }
    void loadDirectory(initialPath)
  })

  const entriesCount = () => browser()?.entries.length ?? 0
  const totalPages = () => {
    const count = entriesCount()
    return count ? Math.ceil(count / BROWSER_PAGE_SIZE) : 1
  }

  createEffect(() => {
    const maxPage = totalPages()
    setBrowserPage((prev) => (prev > maxPage ? maxPage : prev))
  })

  createEffect(() => {
    if (typeof window === 'undefined') return
    const currentPath = browser()?.path
    if (currentPath) {
      lastKnownBrowserPath = currentPath
    }
    const pathToPersist = lastKnownBrowserPath ?? ''
    try {
      window.localStorage.setItem(
        BROWSER_STATE_STORAGE_KEY,
        JSON.stringify({
          expanded: browserExpanded(),
          path: pathToPersist
        })
      )
    } catch {
      // ignore storage errors
    }
  })

  const paginatedEntries = () => {
    const entries = browser()?.entries ?? []
    const page = Math.min(browserPage(), totalPages())
    const start = (page - 1) * BROWSER_PAGE_SIZE
    return entries.slice(start, start + BROWSER_PAGE_SIZE)
  }

  const goToPreviousPage = () => {
    setBrowserPage((prev) => Math.max(1, prev - 1))
  }

  const goToNextPage = () => {
    setBrowserPage((prev) => Math.min(totalPages(), prev + 1))
  }

  const focusPreferredWorkspace = () => {
    const target = selection.currentWorkspaceId() ?? projects()?.[0]?.id ?? null
    if (target) {
      selection.setWorkspaceId(target)
    }
  }

  return (
    <div class="flex flex-col gap-6 p-4 text-[var(--text)]">
      <section class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)]">
        <button
          class="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
          type="button"
          onClick={() => setBrowserExpanded((prev) => !prev)}
        >
          <div>
            <p class="text-xs uppercase tracking-[0.35em] text-[var(--text-muted)]">Repository browser</p>
            <p class="text-sm text-[var(--text-muted)]">Inspect folders to register or convert</p>
          </div>
          <span class="text-xs text-[var(--text-muted)]">{browserExpanded() ? 'Hide' : 'Show'}</span>
        </button>
        <Show when={browserExpanded()}>
          <div class="space-y-3 border-t border-[var(--border)] p-4">
            <div class="flex items-center gap-2">
              <button
                class="flex h-11 w-11 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] text-[var(--text)] disabled:opacity-40"
                type="button"
                aria-label="Go to parent folder"
                disabled={!browser()?.parent}
                onClick={() => void browseToParent()}
              >
                ↑
              </button>
              <input
                type="text"
                class={`flex-1 rounded-2xl border bg-[var(--bg-muted)] p-3 text-sm focus:outline-none focus:ring-2 ${
                  browserPathInvalid()
                    ? 'border-red-500 focus:ring-red-500'
                    : 'border-[var(--border)] focus:ring-blue-500'
                }`}
                value={browserPathInput()}
                onInput={(event) => {
                  setBrowserPathInput(event.currentTarget.value)
                  if (browserPathInvalid()) setBrowserPathInvalid(false)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void loadDirectory(browserPathInput())
                  }
                }}
                placeholder="/Users/me/dev"
              />
              <button
                class="flex h-11 w-11 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] text-[var(--text)]"
                type="button"
                aria-label="Open folder"
                onClick={() => void loadDirectory(browserPathInput())}
              >
                →
              </button>
            </div>
            <Show when={browserError()}>{(message) => <p class="text-xs text-red-600">{message()}</p>}</Show>
            <div class="flex flex-col gap-2 rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-3">
              <Show
                when={!browserLoading()}
                fallback={<p class="text-sm text-[var(--text-muted)]">Loading folders…</p>}
              >
                <Show
                  when={(browser()?.entries.length ?? 0) > 0}
                  fallback={<p class="text-sm text-[var(--text-muted)]">No subfolders here.</p>}
                >
                  <ul class="flex flex-col divide-y divide-[var(--border)]">
                    <For each={paginatedEntries()}>
                      {(entry) => {
                        const entryIsRegistered = () => isPathRegisteredWithRadicle(entry.path, entry.radicleRegistered)
                        const registrationReason = () => entry.radicleRegistrationReason
                        const canRegister = () => entry.isGitRepository && !entryIsRegistered() && !registrationReason()
                        return (
                          <li class="flex flex-wrap items-center justify-between gap-3 py-2">
                            <div>
                              <p class="font-semibold">{entry.name}</p>
                              <p class="text-xs text-[var(--text-muted)]">{entry.path}</p>
                            </div>
                            <div class="flex flex-wrap items-center gap-2 text-xs">
                              <button
                                class="rounded-xl border border-[var(--border)] px-3 py-1 font-semibold"
                                type="button"
                                onClick={() => void loadDirectory(entry.path)}
                              >
                                Open
                              </button>
                              <button
                                class="rounded-xl border border-[var(--border)] px-3 py-1"
                                type="button"
                                onClick={() => setForm((prev) => ({ ...prev, repositoryPath: entry.path }))}
                              >
                                Use in form
                              </button>
                              <Show when={entryIsRegistered()}>
                                <span class="rounded-xl bg-green-600 px-3 py-1 font-semibold text-white">
                                  Registered
                                </span>
                              </Show>
                              <Show when={!entryIsRegistered()}>
                                <Show
                                  when={canRegister()}
                                  fallback={
                                    <Show when={registrationReason()}>
                                      {(reason) => (
                                        <span
                                          class="rounded-xl bg-red-600 px-3 py-1 font-semibold text-white"
                                          title={reason()}
                                        >
                                          Cannot register
                                        </span>
                                      )}
                                    </Show>
                                  }
                                >
                                  <button
                                    class="rounded-xl bg-blue-600 px-3 py-1 font-semibold text-white"
                                    type="button"
                                    onClick={() => void registerRadicleRepo(entry.path)}
                                  >
                                    Register via Radicle
                                  </button>
                                </Show>
                              </Show>
                            </div>
                          </li>
                        )
                      }}
                    </For>
                  </ul>
                  <div class="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--text-muted)]">
                    <span>
                      Showing page {browserPage()} of {totalPages()} ({entriesCount()} items)
                    </span>
                    <div class="flex gap-2">
                      <button
                        class="rounded-xl border border-[var(--border)] px-3 py-1"
                        type="button"
                        disabled={browserPage() <= 1 || entriesCount() === 0}
                        onClick={goToPreviousPage}
                      >
                        Previous
                      </button>
                      <button
                        class="rounded-xl border border-[var(--border)] px-3 py-1"
                        type="button"
                        disabled={entriesCount() === 0 || browserPage() >= totalPages()}
                        onClick={goToNextPage}
                      >
                        Next
                      </button>
                    </div>
                  </div>
                </Show>
              </Show>
            </div>
            <Show when={folderStatus()}>
              {(message) => <p class="text-xs text-[var(--text-muted)]">{message()}</p>}
            </Show>
          </div>
        </Show>
      </section>

      <section class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p class="text-xs uppercase tracking-[0.35em] text-[var(--text-muted)]">Projects</p>
            <h2 class="text-lg font-semibold">Hyperagent workspaces</h2>
          </div>
          <div class="flex flex-wrap items-center gap-2 text-sm">
            <button
              class="rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white"
              type="button"
              onClick={openNewRepoModal}
            >
              New repository
            </button>
            <button class="rounded-xl border border-[var(--border)] px-4 py-2" type="button" onClick={refreshProjects}>
              Refresh
            </button>
          </div>
        </div>
        <Show when={projects()} fallback={<p class="text-sm text-[var(--text-muted)]">Loading repositories…</p>}>
          {(list) => (
            <Show when={list().length} fallback={<p class="text-sm text-[var(--text-muted)]">No workspaces yet.</p>}>
              <ul class="flex flex-col gap-3">
                <For each={list()}>
                  {(project) => (
                    <li class="rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-4">
                      <div class="flex items-center justify-between gap-4">
                        <div>
                          <p class="text-lg font-semibold">{project.name}</p>
                          <p class="text-xs text-[var(--text-muted)]">{project.repositoryPath}</p>
                        </div>
                        <div class="flex flex-wrap items-center gap-2 text-sm">
                          <button
                            class="rounded-xl border border-blue-600 px-3 py-1.5 font-semibold text-blue-600"
                            type="button"
                            onClick={() => selection.setWorkspaceId(project.id)}
                          >
                            Focus workspace
                          </button>
                          <button
                            class="rounded-xl bg-blue-600 px-3 py-1.5 font-semibold text-white"
                            type="button"
                            onClick={() => openSessionModal(project)}
                          >
                            New session
                          </button>
                        </div>
                      </div>
                      <div class="mt-3 flex flex-wrap items-center gap-4 text-xs text-[var(--text-muted)]">
                        <span>Default branch: {project.defaultBranch}</span>
                        <span>Created: {new Date(project.createdAt).toLocaleString()}</span>
                      </div>
                      <button
                        class="mt-3 text-xs font-semibold text-blue-600"
                        type="button"
                        onClick={() => toggleExpanded(setExpandedProjects, project.id)}
                      >
                        {expandedProjects().has(project.id) ? 'Hide repo info' : 'Show repo info'}
                      </button>
                      <Show when={expandedProjects().has(project.id)}>
                        <RepoInfoPanel git={project.git ?? null} path={project.repositoryPath} />
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          )}
        </Show>
      </section>

      <section class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p class="text-xs uppercase tracking-[0.35em] text-[var(--text-muted)]">Radicle</p>
            <h2 class="text-lg font-semibold">Tracked repositories</h2>
          </div>
          <button class="text-sm text-blue-600" type="button" onClick={() => refetchRadicleRepositories()}>
            Refresh
          </button>
        </div>
        <Show
          when={radicleRepositories()}
          fallback={<p class="text-sm text-[var(--text-muted)]">Loading Radicle repositories…</p>}
        >
          {(items) => (
            <Show
              when={items().length}
              fallback={<p class="text-sm text-[var(--text-muted)]">No Radicle repositories detected yet.</p>}
            >
              <ul class="flex flex-col gap-3">
                <For each={items()}>
                  {(entry) => (
                    <li
                      class="rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-4"
                      classList={{ 'border-green-500': entry.radicle?.registered }}
                    >
                      <div class="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p class="text-lg font-semibold">{entry.project.name}</p>
                          <p class="text-xs text-[var(--text-muted)]">{entry.project.repositoryPath}</p>
                        </div>
                        <Show
                          when={entry.radicle?.registered}
                          fallback={
                            <span class="rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-700">
                              Not registered
                            </span>
                          }
                        >
                          <span class="rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-700">
                            Registered
                          </span>
                        </Show>
                      </div>
                      <div class="mt-3 flex flex-wrap items-center gap-3 text-xs text-[var(--text-muted)]">
                        <Show
                          when={entry.radicle?.radicleProjectId}
                          fallback={<span>No Radicle project detected</span>}
                        >
                          {(id) => (
                            <span>
                              Project ID: <code class="rounded bg-[var(--bg-card)] px-1">{id()}</code>
                            </span>
                          )}
                        </Show>
                        <Show when={entry.radicle?.defaultBranch}>
                          {(branch) => <span>Default branch: {branch()}</span>}
                        </Show>
                        <Show when={entry.error}>{(error) => <span class="text-red-600">{error()}</span>}</Show>
                      </div>
                      <button
                        class="mt-3 text-xs font-semibold text-blue-600"
                        type="button"
                        onClick={() => toggleExpanded(setExpandedRadRepos, entry.project.id)}
                      >
                        {expandedRadRepos().has(entry.project.id) ? 'Hide repo info' : 'Show repo info'}
                      </button>
                      <Show when={isSyntheticProject(entry.project)}>
                        <button
                          class="mt-2 rounded-xl bg-green-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                          type="button"
                          disabled={radicleConversionPath() === entry.project.repositoryPath}
                          onClick={() => void convertRadicleRepository(entry)}
                        >
                          {radicleConversionPath() === entry.project.repositoryPath
                            ? 'Converting…'
                            : 'Convert to Hyperagent project'}
                        </button>
                      </Show>
                      <Show when={expandedRadRepos().has(entry.project.id)}>
                        <RepoInfoPanel git={entry.git ?? null} path={entry.project.repositoryPath} />
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          )}
        </Show>
        <Show when={radicleConversionStatus()}>
          {(message) => <p class="mt-3 text-xs text-[var(--text-muted)]">{message()}</p>}
        </Show>
      </section>

      <section class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 text-sm">
        <p class="text-xs uppercase tracking-[0.35em] text-[var(--text-muted)]">Quick actions</p>
        <div class="mt-3 grid gap-2">
          <button
            class="rounded-xl border border-[var(--border)] px-3 py-2 text-left hover:border-blue-500"
            type="button"
            onClick={focusPreferredWorkspace}
          >
            Launch workflows
          </button>
          <button
            class="rounded-xl border border-[var(--border)] px-3 py-2 text-left hover:border-blue-500"
            type="button"
            onClick={focusPreferredWorkspace}
          >
            Terminal sessions
          </button>
          <button
            class="rounded-xl border border-[var(--border)] px-3 py-2 text-left hover:border-blue-500"
            type="button"
            onClick={focusPreferredWorkspace}
          >
            Session history
          </button>
        </div>
      </section>

      <Show when={sessionProject()}>
        {(activeProject) => (
          <div
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            role="dialog"
            aria-modal="true"
            onClick={() => closeSessionModal()}
          >
            <form
              class="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-6 shadow-2xl"
              onClick={(event) => event.stopPropagation()}
              onSubmit={handleSessionSubmit}
            >
              <header class="mb-4">
                <p class="text-xs uppercase tracking-[0.25em] text-[var(--text-muted)]">New session</p>
                <h2 class="text-2xl font-semibold">{activeProject().name}</h2>
                <p class="text-xs text-[var(--text-muted)]">{activeProject().repositoryPath}</p>
              </header>
              <label class="text-xs font-semibold text-[var(--text-muted)]" for="session-name">
                Session name
              </label>
              <input
                id="session-name"
                type="text"
                class="mb-3 mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-2 text-sm"
                value={sessionName()}
                onInput={(event) => setSessionName(event.currentTarget.value)}
                disabled={sessionSubmitting()}
              />
              <label class="text-xs font-semibold text-[var(--text-muted)]" for="session-details">
                Details / prompt
              </label>
              <textarea
                id="session-details"
                rows={5}
                class="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-2 text-sm"
                value={sessionDetails()}
                onInput={(event) => setSessionDetails(event.currentTarget.value)}
                disabled={sessionSubmitting()}
              />
              <Show when={sessionStatus()}>{(message) => <p class="mt-2 text-xs text-red-500">{message()}</p>}</Show>
              <div class="mt-4 flex justify-end gap-2">
                <button
                  class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm"
                  type="button"
                  onClick={() => closeSessionModal()}
                  disabled={sessionSubmitting()}
                >
                  Cancel
                </button>
                <button
                  class="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  type="submit"
                  disabled={sessionSubmitting()}
                >
                  {sessionSubmitting() ? 'Creating…' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        )}
      </Show>

      <Show when={newRepoModalOpen()}>
        <div
          class="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          onClick={closeNewRepoModal}
        >
          <form
            data-testid="new-repo-form"
            class="w-full max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-6"
            onSubmit={handleSubmit}
            onClick={(event) => event.stopPropagation()}
          >
            <header class="mb-4">
              <p class="text-xs uppercase tracking-[0.35em] text-[var(--text-muted)]">New project</p>
              <h2 class="text-2xl font-semibold">Register repository</h2>
            </header>
            <label class="text-xs font-semibold text-[var(--text-muted)]" for="repo-name">
              Name
            </label>
            <input
              id="repo-name"
              class="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-2 text-sm"
              type="text"
              value={form().name}
              onInput={(event) => setForm((prev) => ({ ...prev, name: event.currentTarget.value }))}
            />
            <label class="mt-3 text-xs font-semibold text-[var(--text-muted)]" for="repo-path">
              Repository path
            </label>
            <input
              id="repo-path"
              class="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-2 text-sm"
              type="text"
              value={form().repositoryPath}
              onInput={(event) => setForm((prev) => ({ ...prev, repositoryPath: event.currentTarget.value }))}
            />
            <label class="mt-3 text-xs font-semibold text-[var(--text-muted)]" for="repo-branch">
              Default branch
            </label>
            <input
              id="repo-branch"
              class="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-2 text-sm"
              type="text"
              value={form().defaultBranch}
              onInput={(event) => setForm((prev) => ({ ...prev, defaultBranch: event.currentTarget.value }))}
            />
            <label class="mt-3 text-xs font-semibold text-[var(--text-muted)]" for="repo-description">
              Description (optional)
            </label>
            <textarea
              id="repo-description"
              rows={3}
              class="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-2 text-sm"
              value={form().description}
              onInput={(event) => setForm((prev) => ({ ...prev, description: event.currentTarget.value }))}
            />
            <Show when={status()}>{(message) => <p class="mt-2 text-xs text-[var(--text-muted)]">{message()}</p>}</Show>
            <div class="mt-4 flex justify-end gap-2 text-sm">
              <button
                class="rounded-xl border border-[var(--border)] px-4 py-2"
                type="button"
                onClick={closeNewRepoModal}
              >
                Cancel
              </button>
              <button class="rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white" type="submit">
                Save project
              </button>
            </div>
          </form>
        </div>
      </Show>
    </div>
  )
}

const RepoInfoPanel = (props: { git: GitInfo | null; path: string }) => {
  const commit = () => props.git?.commit ?? null
  const shortHash = () => (commit()?.hash ? commit()!.hash!.slice(0, 7) : null)
  return (
    <div class="mt-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 text-sm text-[var(--text)]">
      <div class="flex flex-col gap-2">
        <div>
          <p class="text-xs font-semibold text-[var(--text-muted)]">Repository path</p>
          <code class="mt-1 block overflow-hidden text-ellipsis whitespace-nowrap rounded bg-[var(--bg-muted)] px-2 py-1 text-xs">
            {props.git?.repositoryPath ?? props.path}
          </code>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <div>
            <p class="text-xs font-semibold text-[var(--text-muted)]">Current branch</p>
            <p>{props.git?.branch ?? 'Unknown'}</p>
          </div>
          <div>
            <p class="text-xs font-semibold text-[var(--text-muted)]">Current commit</p>
            <Show when={commit()} fallback={<p>Unavailable</p>}>
              {(current) => (
                <p>
                  <span class="font-mono">{shortHash()}</span>
                  <Show when={current().message}>
                    {(message) => <span class="ml-2 text-[var(--text-muted)]">{message()}</span>}
                  </Show>
                </p>
              )}
            </Show>
          </div>
        </div>
        <div>
          <p class="text-xs font-semibold text-[var(--text-muted)]">Remotes</p>
          <Show when={(props.git?.remotes?.length ?? 0) > 0} fallback={<p>No remotes configured.</p>}>
            <ul class="mt-1 flex flex-col gap-1">
              <For each={props.git?.remotes ?? []}>
                {(remote) => (
                  <li class="flex flex-wrap items-center gap-2">
                    <span class="rounded-full bg-[var(--bg-muted)] px-2 py-0.5 text-xs font-semibold">
                      {remote.name}
                    </span>
                    <code class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap rounded bg-[var(--bg-muted)] px-2 py-0.5 text-xs">
                      {remote.url}
                    </code>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </div>
    </div>
  )
}
