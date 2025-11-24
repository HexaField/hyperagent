import { A, useParams } from '@solidjs/router'
import { Show, createEffect, createMemo, createResource, createSignal, onCleanup } from 'solid-js'
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

type SectionId = 'workspace' | 'agent' | 'diffs'

const SECTION_METADATA: Record<SectionId, { title: string; description: string }> = {
  workspace: {
    title: 'Code workspace',
    description: 'Embedded code-server workspace'
  },
  agent: {
    title: 'Opencode console',
    description: 'Background opencode session controls'
  },
  diffs: {
    title: 'Diffs',
    description: 'Working tree changes'
  }
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

  const [maximizedSection, setMaximizedSection] = createSignal<SectionId | null>(null)
  const [collapsedSections, setCollapsedSections] = createSignal<Set<SectionId>>(new Set())

  createEffect(() => {
    if (typeof document === 'undefined') return
    if (!maximizedSection()) return
    const originalOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    onCleanup(() => {
      document.body.style.overflow = originalOverflow
    })
  })

  const isSectionCollapsed = (sectionId: SectionId) => collapsedSections().has(sectionId)

  const expandSection = (sectionId: SectionId) => {
    setCollapsedSections((prev) => {
      if (!prev.has(sectionId)) return prev
      const next = new Set(prev)
      next.delete(sectionId)
      return next
    })
  }

  const toggleCollapseSection = (sectionId: SectionId) => {
    let shouldCollapse = false
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(sectionId)) {
        next.delete(sectionId)
        shouldCollapse = false
      } else {
        next.add(sectionId)
        shouldCollapse = true
      }
      return next
    })
    if (shouldCollapse && maximizedSection() === sectionId) {
      setMaximizedSection(null)
    }
  }

  const toggleMaximizeSection = (sectionId: SectionId) => {
    setMaximizedSection((prev) => {
      if (prev === sectionId) {
        return null
      }
      expandSection(sectionId)
      return sectionId
    })
  }

  const sectionWrapperClass = (sectionId: SectionId, baseGridClass: string) => {
    const active = maximizedSection()
    if (active && active !== sectionId) {
      return 'hidden'
    }
    if (active === sectionId) {
      return 'fixed inset-0 z-50 flex h-screen w-screen flex-col overflow-y-auto bg-[var(--bg)] px-4 py-4 sm:px-8 sm:py-6'
    }
    return `min-w-0 ${baseGridClass}`
  }

  const SectionControls = (props: { id: SectionId }) => (
    <div class="flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        class="rounded-xl border border-[var(--border)] px-3 py-1 font-semibold text-[var(--text)]"
        onClick={() => toggleMaximizeSection(props.id)}
        aria-pressed={maximizedSection() === props.id}
      >
        <Show when={maximizedSection() === props.id} fallback={'Maximize'}>
          Exit full view
        </Show>
      </button>
      <button
        type="button"
        class="rounded-xl border border-[var(--border)] px-3 py-1 font-semibold text-[var(--text)]"
        onClick={() => toggleCollapseSection(props.id)}
        aria-pressed={isSectionCollapsed(props.id)}
      >
        <Show when={isSectionCollapsed(props.id)} fallback={'Collapse'}>
          Expand
        </Show>
      </button>
    </div>
  )

  const CollapsedNotice = (props: { id: SectionId }) => (
    <div class="rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-muted)] p-4 text-sm text-[var(--text-muted)]">
      <p>
        {SECTION_METADATA[props.id].title} is hidden. Use the controls above to re-open it for this project view.
      </p>
      <button
        type="button"
        class="mt-3 rounded-xl border border-[var(--border)] px-3 py-1 text-xs font-semibold text-[var(--text)]"
        onClick={() => expandSection(props.id)}
      >
        Expand section
      </button>
    </div>
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

          <Show when={maximizedSection()}>
            <div class="fixed inset-0 z-40 bg-slate-950/60 backdrop-blur-sm" />
          </Show>
          <div class="grid gap-6 xl:grid-cols-2">
            <div class={`min-w-0 ${sectionWrapperClass('workspace', 'col-span-2 xl:col-span-1')}`}>
              <section class="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p class="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)]">Code workspace</p>
                    <h2 class="text-lg font-semibold text-[var(--text)]">Embedded code-server</h2>
                  </div>
                  <SectionControls id="workspace" />
                </div>
                <Show when={devspaceError()}>
                  {(message) => <p class="text-xs text-red-500">{message()}</p>}
                </Show>
                <Show
                  when={!isSectionCollapsed('workspace')}
                  fallback={<CollapsedNotice id="workspace" />}
                >
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
                </Show>
              </section>
            </div>

            <div class={`min-w-0 ${sectionWrapperClass('agent', 'col-span-2 xl:col-span-1')}`}>
              <Show
                when={!isSectionCollapsed('agent')}
                fallback={
                  <section class="flex flex-col gap-3 rounded-[1.25rem] border border-[var(--border)] bg-[var(--bg-card)] p-6">
                    <div class="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p class="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)]">Opencode console</p>
                        <h2 class="text-lg font-semibold text-[var(--text)]">Opencode session controls</h2>
                      </div>
                      <SectionControls id="agent" />
                    </div>
                    <p class="text-sm text-[var(--text-muted)]">
                      This section is collapsed for a compact layout. Expand it to launch and monitor opencode sessions.
                    </p>
                  </section>
                }
              >
                <Agent
                  title="Opencode session"
                  description="Prompt the opencode-powered agent directly against this repository."
                  workspacePath={currentProject().repositoryPath}
                  defaultPrompt={defaultPrompt()}
                  headerActions={
                    <div class="flex flex-wrap items-center gap-2">
                      <A
                        href={`/sessions?workspace=${encodeURIComponent(currentProject().repositoryPath)}`}
                        class="rounded-xl border border-[var(--border)] px-3 py-1 text-xs font-semibold text-[var(--text)]"
                      >
                        Sessions page
                      </A>
                      <SectionControls id="agent" />
                    </div>
                  }
                />
              </Show>
            </div>

            <div class={`min-w-0 ${sectionWrapperClass('diffs', 'col-span-2')}`}>
              <section class="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p class="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)]">Diffs</p>
                    <h2 class="text-lg font-semibold text-[var(--text)]">Working tree changes</h2>
                  </div>
                  <div class="flex flex-wrap items-center gap-2">
                    <button
                      class="rounded-xl border border-[var(--border)] px-3 py-1 text-sm"
                      type="button"
                      onClick={handleRefreshDiff}
                      disabled={diff.loading}
                    >
                      {diff.loading ? 'Refreshing…' : 'Refresh diff'}
                    </button>
                    <SectionControls id="diffs" />
                  </div>
                </div>
                <Show when={diffError()}>
                  {(message) => <p class="text-xs text-red-500">{message()}</p>}
                </Show>
                <Show
                  when={!isSectionCollapsed('diffs')}
                  fallback={<CollapsedNotice id="diffs" />}
                >
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
                </Show>
              </section>
            </div>
          </div>
        </div>
      )}
    </Show>
  )
}
