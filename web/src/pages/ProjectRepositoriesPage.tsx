import { A, useParams } from '@solidjs/router'
import { Show, createMemo, createResource, createSignal } from 'solid-js'
import Agent from '../components/Agent'
import DiffViewer from '../components/DiffViewer'
import { fetchJson } from '../lib/http'
import type { Project } from './RepositoriesPage'

type ProjectResponse = {
  project: Project
}

type DevspaceResponse = {
  projectId: string
  sessionId: string
  codeServerUrl: string | null
  workspacePath: string
  branch: string
}

type ProjectDiffResponse = {
  projectId: string
  diffText: string
  hasChanges: boolean
  status: string
}

export default function ProjectRepositoriesPage() {
  const params = useParams()
  const [project, { refetch: refetchProject }] = createResource(async () => {
    if (!params.projectId) return null
    const payload = await fetchJson<ProjectResponse>(`/api/projects/${params.projectId}`)
    return payload.project
  })

  const [devspaceError, setDevspaceError] = createSignal<string | null>(null)
  const [diffError, setDiffError] = createSignal<string | null>(null)

  const [devspace, { refetch: refetchDevspace }] = createResource(
    () => project()?.id,
    async (projectId) => {
      if (!projectId) return null
      setDevspaceError(null)
      try {
        return await fetchJson<DevspaceResponse>(`/api/projects/${projectId}/devspace`, { method: 'POST' })
      } catch (error) {
        setDevspaceError(error instanceof Error ? error.message : 'Failed to launch code-server')
        return null
      }
    }
  )

  const [diff, { refetch: refetchDiff }] = createResource(
    () => project()?.id,
    async (projectId) => {
      if (!projectId) return null
      setDiffError(null)
      try {
        return await fetchJson<ProjectDiffResponse>(`/api/projects/${projectId}/diff`)
      } catch (error) {
        setDiffError(error instanceof Error ? error.message : 'Failed to load diff')
        return null
      }
    }
  )

  const pageTitle = createMemo(() => project()?.name ?? 'Repository workspace')
  const defaultPrompt = createMemo(() =>
    project() ? `Review ${project()!.name} and propose the next improvement.` : undefined
  )

  const handleRefreshDiff = () => {
    void refetchDiff()
  }

  const handleRestartDevspace = () => {
    void refetchDevspace()
  }

  return (
    <Show
      when={project()}
      fallback={
        <section class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-6 text-[var(--text)]">
          <p class="font-semibold">Loading project…</p>
          <Show when={project.error}>
            {(err) => (
              <div class="mt-2 flex flex-col gap-2 text-sm">
                <p class="text-red-500">{err()?.message ?? 'Unable to load project details.'}</p>
                <button
                  class="self-start rounded-xl border border-[var(--border)] px-3 py-1"
                  type="button"
                  onClick={() => refetchProject()}
                >
                  Retry
                </button>
              </div>
            )}
          </Show>
        </section>
      }
    >
      {(currentProject) => (
        <div class="flex flex-col gap-6">
          <header class="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p class="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)]">Repositories</p>
              <h1 class="text-3xl font-semibold text-[var(--text)]">{pageTitle()}</h1>
              <p class="text-[var(--text-muted)]">{currentProject().repositoryPath}</p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <A class="rounded-xl border border-[var(--border)] px-3 py-1 text-sm" href="/repositories">
                Back to projects
              </A>
              <button
                class="rounded-xl border border-[var(--border)] px-3 py-1 text-sm"
                type="button"
                onClick={handleRestartDevspace}
                disabled={devspace.loading}
              >
                {devspace.loading ? 'Starting…' : 'Restart workspace'}
              </button>
            </div>
          </header>

          <div class="grid gap-6 lg:grid-cols-2">
            <section class="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)]">Code workspace</p>
                  <h2 class="text-lg font-semibold text-[var(--text)]">Embedded code-server</h2>
                </div>
                <Show when={devspaceError()}>
                  {(message) => <p class="text-xs text-red-500">{message()}</p>}
                </Show>
              </div>
              <Show
                when={devspace()?.codeServerUrl}
                fallback={
                  <div class="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--text-muted)]">
                    {devspace.loading ? 'Launching code-server…' : 'Start the workspace to open code-server.'}
                  </div>
                }
              >
                {(url) => (
                  <iframe
                    src={url()}
                    title="Project code-server"
                    allow="clipboard-write"
                    class="min-h-[420px] w-full rounded-2xl border border-[var(--border)] bg-[#0f172a]"
                  />
                )}
              </Show>
              <Show when={devspace()?.workspacePath}>
                {(path) => (
                  <p class="text-xs text-[var(--text-muted)]" title={path()}>
                    Workspace · {path()}
                  </p>
                )}
              </Show>
            </section>

            <section class="flex flex-col gap-4">
              <Agent
                title="Opencode session"
                description="Prompt the opencode-powered agent directly against this repository."
                projectId={currentProject().id}
                provider="opencode"
                defaultPrompt={defaultPrompt()}
                showWorkspacePanel={false}
                onRunComplete={handleRefreshDiff}
              />
              <section class="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p class="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)]">Diffs</p>
                    <h2 class="text-lg font-semibold text-[var(--text)]">Working tree changes</h2>
                  </div>
                  <div class="flex items-center gap-2">
                    <button
                      class="rounded-xl border border-[var(--border)] px-3 py-1 text-sm"
                      type="button"
                      onClick={handleRefreshDiff}
                      disabled={diff.loading}
                    >
                      {diff.loading ? 'Refreshing…' : 'Refresh diff'}
                    </button>
                  </div>
                </div>
                <Show when={diffError()}>
                  {(message) => <p class="text-xs text-red-500">{message()}</p>}
                </Show>
                <Show
                  when={diff()}
                  fallback={
                    <p class="text-sm text-[var(--text-muted)]">
                      {diff.loading ? 'Loading latest diff…' : 'No diff data yet.'}
                    </p>
                  }
                >
                  {(payload) => (
                    <div class="flex flex-col gap-3">
                      <pre class="overflow-x-auto rounded-xl bg-[var(--bg-muted)] p-3 text-xs text-[var(--text)]">
                        {payload().status}
                      </pre>
                      <Show when={payload().hasChanges} fallback={<p class="text-sm text-[var(--text-muted)]">Working tree clean.</p>}>
                        <DiffViewer diffText={payload().diffText} />
                      </Show>
                    </div>
                  )}
                </Show>
              </section>
            </section>
          </div>
        </div>
      )}
    </Show>
  )
}
