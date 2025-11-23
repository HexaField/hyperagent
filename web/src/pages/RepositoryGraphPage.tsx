import { A, useParams } from '@solidjs/router'
import { For, Show, createResource } from 'solid-js'
import { fetchJson } from '../lib/http'

type GraphCommit = {
  id: string
  commitHash: string
  branch: string
  message: string
  label: string
  workflowId: string
  stepId: string
  timestamp: string
}

type GraphResponse = {
  project: {
    id: string
    name: string
    repositoryPath: string
    defaultBranch: string
  }
  branches: Array<{
    name: string
    commits: GraphCommit[]
  }>
}

export default function RepositoryGraphPage () {
  const params = useParams()
  const [graph] = createResource(() => params.projectId, async (projectId) => {
    if (!projectId) return null
    return await fetchJson<GraphResponse>(`/api/projects/${projectId}/graph`)
  })

  return (
    <div class="flex flex-col gap-6">
      <header class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p class="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)]">Repository graph</p>
          <h1 class="text-3xl font-semibold text-[var(--text)]">
            <Show when={graph()?.project} fallback={'Loading…'}>
              {project => project().name}
            </Show>
          </h1>
          <Show when={graph()?.project}>
            {project => (
              <p class="text-[var(--text-muted)]">
                {project().repositoryPath} — default branch {project().defaultBranch}
              </p>
            )}
          </Show>
        </div>
        <A href="/repositories" class="text-sm text-blue-600">Back to repositories</A>
      </header>

      <Show when={graph()} fallback={<p class="text-sm text-[var(--text-muted)]">Loading graph…</p>}>
        {payload => (
          <Show when={payload().branches.length} fallback={<p class="text-sm text-[var(--text-muted)]">No commits captured yet. Kick off a workflow to populate the graph.</p>}>
            <div class="flex flex-col gap-6">
              <For each={payload().branches}>
                {branch => (
                  <section class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
                    <header class="mb-4 flex items-center justify-between">
                      <div>
                        <p class="text-lg font-semibold text-[var(--text)]">{branch.name}</p>
                        <p class="text-xs text-[var(--text-muted)]">{branch.commits.length} commits tracked</p>
                      </div>
                    </header>
                    <div class="flex flex-col gap-4">
                      <For each={branch.commits}>
                        {commit => (
                          <article class="flex flex-col gap-1 rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-4">
                            <div class="flex flex-wrap items-center justify-between gap-3">
                              <div>
                                <p class="text-sm font-semibold text-[var(--text)]">{commit.label}</p>
                                <p class="text-xs text-[var(--text-muted)]">{commit.message || 'No commit message recorded'}</p>
                              </div>
                              <div class="text-xs text-[var(--text-muted)]">
                                {new Date(commit.timestamp).toLocaleString()}
                              </div>
                            </div>
                            <div class="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                              <span class="rounded-full bg-[var(--bg-card)] px-2 py-0.5 font-mono">{commit.commitHash.slice(0, 8)}</span>
                              <A href={`/workflows/${commit.workflowId}`} class="text-blue-600">
                                View workflow
                              </A>
                            </div>
                          </article>
                        )}
                      </For>
                    </div>
                  </section>
                )}
              </For>
            </div>
          </Show>
        )}
      </Show>
    </div>
  )
}
