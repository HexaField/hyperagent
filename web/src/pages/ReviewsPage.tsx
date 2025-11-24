import { For, Show, createResource } from 'solid-js'
import { fetchJson } from '../lib/http'

type ReviewRunSummary = {
  id: string
  status: string
  summary: string | null
  createdAt: string
  completedAt: string | null
}

type PullRequestSummary = {
  id: string
  projectId: string
  title: string
  description: string | null
  sourceBranch: string
  targetBranch: string
  status: string
  authorUserId: string
  createdAt: string
  updatedAt: string
  latestReviewRun: ReviewRunSummary | null
}

type ProjectSummary = {
  id: string
  name: string
  repositoryPath: string
  defaultBranch: string
}

type ReviewGroup = {
  project: ProjectSummary
  pullRequests: PullRequestSummary[]
}

export default function ReviewsPage() {
  const [groups, { refetch }] = createResource(async () => {
    const payload = await fetchJson<{ groups: ReviewGroup[] }>('/api/reviews/active')
    return payload.groups
  })

  return (
    <div class="flex flex-col gap-6">
      <header class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p class="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)]">Reviews</p>
          <h1 class="text-3xl font-semibold text-[var(--text)]">Active pull requests</h1>
          <p class="text-[var(--text-muted)]">
            Monitor open pull requests across projects and track their latest automated review runs.
          </p>
        </div>
        <button
          class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm text-[var(--text)]"
          type="button"
          onClick={() => refetch()}
        >
          Refresh
        </button>
      </header>

      <Show when={groups()} fallback={<p class="text-sm text-[var(--text-muted)]">Loading active reviews…</p>}>
        {(payload) => (
          <Show when={payload().length} fallback={<p class="text-sm text-[var(--text-muted)]">No open pull requests right now.</p>}>
            <div class="flex flex-col gap-4">
              <For each={payload()}>
                {(group) => (
                  <section class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
                    <header class="mb-4 flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p class="text-lg font-semibold text-[var(--text)]">{group.project.name}</p>
                        <p class="text-xs text-[var(--text-muted)]">{group.project.repositoryPath}</p>
                      </div>
                      <span class="rounded-full bg-blue-600/10 px-3 py-1 text-xs font-semibold text-blue-600">
                        {group.pullRequests.length} open PR{group.pullRequests.length === 1 ? '' : 's'}
                      </span>
                    </header>
                    <ol class="flex flex-col gap-3">
                      <For each={group.pullRequests}>
                        {(pr) => (
                          <li class="rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-4">
                            <div class="flex flex-wrap items-center justify-between gap-3">
                              <div>
                                <p class="text-base font-semibold text-[var(--text)]">{pr.title}</p>
                                <p class="text-xs text-[var(--text-muted)]">
                                  {pr.sourceBranch} → {pr.targetBranch}
                                </p>
                              </div>
                              <span class="text-xs uppercase tracking-wide text-emerald-600">Open</span>
                            </div>
                            <Show when={pr.description}>
                              {(body) => (
                                <p class="mt-2 text-sm text-[var(--text-muted)] whitespace-pre-wrap">{body()}</p>
                              )}
                            </Show>
                            <ReviewRunStatus run={pr.latestReviewRun} />
                          </li>
                        )}
                      </For>
                    </ol>
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

function ReviewRunStatus(props: { run: ReviewRunSummary | null }) {
  return (
    <div class="mt-3 rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-card)] p-3 text-sm text-[var(--text)]">
      <Show when={props.run} fallback={<p class="text-[var(--text-muted)]">No automated review runs yet.</p>}>
        {(run) => (
          <div class="flex flex-col gap-1">
            <p class="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Latest review run</p>
            <p>
              Status ·
              <span class="ml-1 font-semibold capitalize">{run().status}</span>
              <Show when={run().completedAt}>
                {(timestamp) => <span class="ml-2 text-[var(--text-muted)]">Completed {formatDate(timestamp())}</span>}
              </Show>
            </p>
            <Show when={run().summary}>
              {(summary) => <p class="text-sm text-[var(--text-muted)] whitespace-pre-wrap">{summary()}</p>}
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}

function formatDate(input: string): string {
  if (!input) return ''
  try {
    return new Date(input).toLocaleString()
  } catch {
    return input
  }
}
