import { A } from '@solidjs/router'
import { For, Show, createResource, createSignal } from 'solid-js'
import { fetchJson } from '../lib/http'

type Project = {
  id: string
  name: string
  description?: string | null
  repositoryPath: string
  defaultBranch: string
  createdAt: string
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
  error?: string | null
}

export default function RepositoriesPage () {
  const [form, setForm] = createSignal({
    name: '',
    repositoryPath: '',
    description: '',
    defaultBranch: 'main'
  })
  const [status, setStatus] = createSignal<string | null>(null)

  const [projects, { refetch: refetchProjects }] = createResource(async () => {
    const payload = await fetchJson<{ projects: Project[] }>('/api/projects')
    return payload.projects
  })

  const [radicleRepositories, { refetch: refetchRadicleRepositories }] = createResource(async () => {
    const payload = await fetchJson<{ repositories: RadicleRepositoryEntry[] }>('/api/radicle/repositories')
    return payload.repositories
  })

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
      await Promise.all([refetchProjects(), refetchRadicleRepositories()])
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to create project')
    }
  }

  const refreshProjects = async () => {
    await Promise.all([refetchProjects(), refetchRadicleRepositories()])
  }

  return (
    <div class="flex flex-col gap-6">
      <header>
        <p class="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)]">Repositories</p>
        <h1 class="text-3xl font-semibold text-[var(--text)]">Projects</h1>
        <p class="text-[var(--text-muted)]">Register repositories to unlock workflow orchestration, commit graphs, and diffs.</p>
      </header>

      <section class="grid gap-6 lg:grid-cols-[360px,1fr]">
        <form class="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4" onSubmit={handleSubmit}>
          <h2 class="text-lg font-semibold text-[var(--text)]">New repository</h2>
          <label class="text-xs font-semibold text-[var(--text-muted)]" for="repo-name">Name</label>
          <input
            id="repo-name"
            type="text"
            class="rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-2 text-sm text-[var(--text)]"
            value={form().name}
            onInput={event => setForm(prev => ({ ...prev, name: event.currentTarget.value }))}
          />
          <label class="text-xs font-semibold text-[var(--text-muted)]" for="repo-path">Repository path</label>
          <input
            id="repo-path"
            type="text"
            class="rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-2 text-sm text-[var(--text)]"
            value={form().repositoryPath}
            onInput={event => setForm(prev => ({ ...prev, repositoryPath: event.currentTarget.value }))}
          />
          <label class="text-xs font-semibold text-[var(--text-muted)]" for="repo-branch">Default branch</label>
          <input
            id="repo-branch"
            type="text"
            class="rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-2 text-sm text-[var(--text)]"
            value={form().defaultBranch}
            onInput={event => setForm(prev => ({ ...prev, defaultBranch: event.currentTarget.value }))}
          />
          <label class="text-xs font-semibold text-[var(--text-muted)]" for="repo-description">Description (optional)</label>
          <textarea
            id="repo-description"
            rows={3}
            class="rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-2 text-sm text-[var(--text)]"
            value={form().description}
            onInput={event => setForm(prev => ({ ...prev, description: event.currentTarget.value }))}
          />
          <button class="rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white" type="submit">
            Save repository
          </button>
          <Show when={status()}>
            {message => <p class="text-xs text-[var(--text-muted)]">{message()}</p>}
          </Show>
        </form>

        <div class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-lg font-semibold text-[var(--text)]">Hyperagent projects</h2>
            <button class="text-sm text-blue-600" type="button" onClick={refreshProjects}>
              Refresh
            </button>
          </div>
          <Show when={projects()} fallback={<p class="text-sm text-[var(--text-muted)]">No repositories yet.</p>}>
            {list => (
              <ul class="flex flex-col gap-3">
                <For each={list()}>
                  {project => (
                    <li class="rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-4">
                      <div class="flex items-center justify-between gap-4">
                        <div>
                          <p class="text-lg font-semibold text-[var(--text)]">{project.name}</p>
                          <p class="text-xs text-[var(--text-muted)]">{project.repositoryPath}</p>
                        </div>
                        <A
                          href={`/repositories/${project.id}/graph`}
                          class="rounded-xl border border-blue-600 px-3 py-1.5 text-sm font-semibold text-blue-600"
                        >
                          View graph
                        </A>
                      </div>
                      <div class="mt-3 flex flex-wrap items-center gap-4 text-xs text-[var(--text-muted)]">
                        <span>Default branch: {project.defaultBranch}</span>
                        <span>Created: {new Date(project.createdAt).toLocaleString()}</span>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            )}
          </Show>
        </div>

      </section>

      <section class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 class="text-lg font-semibold text-[var(--text)]">Radicle tracked repositories</h2>
            <p class="text-sm text-[var(--text-muted)]">Direct from your rad remote, independent of workflow activity.</p>
          </div>
          <button class="text-sm text-blue-600" type="button" onClick={() => refetchRadicleRepositories()}>
            Refresh
          </button>
        </div>
        <Show when={radicleRepositories()} fallback={<p class="text-sm text-[var(--text-muted)]">Loading Radicle repositories…</p>}>
          {items => (
            <Show when={items().length} fallback={<p class="text-sm text-[var(--text-muted)]">No Radicle repositories detected yet.</p>}>
              <ul class="flex flex-col gap-3">
                <For each={items()}>
                  {entry => (
                    <li
                      class="rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-4"
                      classList={{ 'border-green-500': entry.radicle?.registered }}
                    >
                      <div class="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p class="text-lg font-semibold text-[var(--text)]">{entry.project.name}</p>
                          <p class="text-xs text-[var(--text-muted)]">{entry.project.repositoryPath}</p>
                        </div>
                        <Show when={entry.radicle?.registered} fallback={<span class="rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-700">Not registered</span>}>
                          <span class="rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-700">Registered</span>
                        </Show>
                      </div>
                      <div class="mt-3 flex flex-wrap items-center gap-3 text-xs text-[var(--text-muted)]">
                        <Show when={entry.radicle?.radicleProjectId} fallback={<span>No Radicle project detected</span>}>
                          {id => <span>Project ID: <code class="rounded bg-[var(--bg-card)] px-1">{id()}</code></span>}
                        </Show>
                        <Show when={entry.radicle?.defaultBranch}>
                          {branch => <span>Default branch: {branch()}</span>}
                        </Show>
                        <Show when={entry.error}>
                          {error => <span class="text-red-600">{error()}</span>}
                        </Show>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          )}
        </Show>
      </section>
    </div>
  )
}
