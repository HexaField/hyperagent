import { A, useSearchParams } from '@solidjs/router'
import { For, Show, createEffect, createMemo, createResource, createSignal } from 'solid-js'
import { fetchJson } from '../lib/http'
import WorkflowDetailView from '../components/WorkflowDetailView'
import WorkflowLaunchModal from '../components/WorkflowLaunchModal'

type WorkflowRecord = {
  id: string
  projectId: string
  kind: string
  status: string
  createdAt: string
  updatedAt: string
}

type WorkflowStep = {
  id: string
  workflowId: string
  status: string
  sequence: number
  data: Record<string, unknown>
  result: Record<string, unknown> | null
  runnerInstanceId: string | null
}

type WorkflowSummary = {
  workflow: WorkflowRecord
  steps: WorkflowStep[]
}

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

type ReviewGroup = {
  project: {
    id: string
    name: string
    repositoryPath: string
    defaultBranch: string
  }
  pullRequests: PullRequestSummary[]
}

type WorkflowCategory = 'inProgress' | 'readyForReview' | 'done' | 'failed'
const CATEGORY_LABELS: Record<WorkflowCategory, string> = {
  inProgress: 'In progress',
  readyForReview: 'Ready for review',
  done: 'Done',
  failed: 'Failed'
}
const FILTER_STORAGE_KEY = 'hyperagent.workflows.filters'
const DEFAULT_FILTERS: Record<WorkflowCategory, boolean> = {
  inProgress: true,
  readyForReview: true,
  done: true,
  failed: true
}

export default function WorkflowsPage() {
  const [workflows, { refetch }] = createResource(async () => {
    const payload = await fetchJson<{ workflows: WorkflowSummary[] }>('/api/workflows')
    return payload.workflows
  })
  const [reviews, { refetch: refetchReviews }] = createResource(async () => {
    const payload = await fetchJson<{ groups: ReviewGroup[] }>('/api/reviews/active')
    return payload.groups
  })
  const [launchOpen, setLaunchOpen] = createSignal(false)
  const [filterMenuOpen, setFilterMenuOpen] = createSignal(false)
  const [filters, setFilters] = createSignal<Record<WorkflowCategory, boolean>>(loadStoredFilters())
  createEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters()))
    } catch {
      /* ignore storage failures */
    }
  })
  const [searchParams, setSearchParams] = useSearchParams()
  const focusedSessionId = () => {
    const value = searchParams.sessionId
    return typeof value === 'string' && value.length ? value : null
  }
  const closeSessionView = () => {
    setSearchParams({ sessionId: undefined })
  }
  const reviewMap = createMemo(() => {
    const groups = reviews()
    const map = new Map<string, PullRequestSummary[]>()
    if (!groups) return map
    for (const group of groups) {
      map.set(group.project.id, group.pullRequests)
    }
    return map
  })
  const categorized = createMemo(() => {
    const list = workflows() ?? []
    const map = reviewMap()
    return list.map((summary) => {
      const category = deriveCategory(summary, map)
      const pullRequests = map.get(summary.workflow.projectId) ?? []
      return { summary, category, pullRequests }
    })
  })
  const filtered = createMemo(() => {
    const enabled = filters()
    return categorized().filter((entry) => enabled[entry.category])
  })
  const categoryCounts = createMemo(() => {
    const base: Record<WorkflowCategory, number> = {
      inProgress: 0,
      readyForReview: 0,
      done: 0,
      failed: 0
    }
    categorized().forEach((entry) => {
      base[entry.category] += 1
    })
    return base
  })
  const toggleFilter = (category: WorkflowCategory) => {
    setFilters((prev) => ({ ...prev, [category]: !prev[category] }))
  }
  const refreshAll = () => {
    refetch()
    refetchReviews()
  }

  return (
    <div class="flex flex-col gap-6">
      <header class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p class="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)]">Workflows</p>
          <h1 class="text-3xl font-semibold text-[var(--text)]">Queued & historical runs</h1>
          <p class="text-[var(--text-muted)]">
            Inspect orchestration progress, jump into steps, and switch to repository graphs for deeper context.
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <div class="relative">
            <button
              class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm text-[var(--text)]"
              type="button"
              onClick={() => setFilterMenuOpen((prev) => !prev)}
            >
              Filters
            </button>
            <Show when={filterMenuOpen()}>
              <div class="absolute right-0 z-10 mt-2 w-56 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-3 shadow-xl">
                <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Show workflows</p>
                <ul class="space-y-2 text-sm">
                  <For each={Object.entries(CATEGORY_LABELS) as Array<[WorkflowCategory, string]>}>
                    {(entry) => {
                      const [key, label] = entry
                      return (
                        <li class="flex items-center justify-between gap-3">
                          <label class="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={filters()[key]}
                              onChange={() => toggleFilter(key)}
                            />
                            <span>{label}</span>
                          </label>
                          <span class="text-xs text-[var(--text-muted)]">{categoryCounts()[key]}</span>
                        </li>
                      )
                    }}
                  </For>
                </ul>
              </div>
            </Show>
          </div>
          <button
            class="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
            type="button"
            onClick={() => setLaunchOpen(true)}
          >
            Launch workflow
          </button>
          <button
            class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm text-[var(--text)]"
            type="button"
            onClick={refreshAll}
          >
            Refresh
          </button>
        </div>
      </header>

      <Show when={workflows()} fallback={<p class="text-sm text-[var(--text-muted)]">Loading workflows…</p>}>
        {(items) => (
          <Show
            when={filtered().length}
            fallback={<p class="text-sm text-[var(--text-muted)]">No workflows queued yet.</p>}
          >
            <div class="flex flex-col gap-4">
              <For each={filtered()}>
                {({ summary, category, pullRequests }) => (
                  <article class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
                    <header class="mb-4 flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p class="text-lg font-semibold text-[var(--text)]">{summary.workflow.kind}</p>
                        <p class="text-xs text-[var(--text-muted)]">Workflow · {summary.workflow.status}</p>
                      </div>
                      <div class="flex gap-2 text-sm">
                        <span
                          class="rounded-full bg-[var(--bg-muted)] px-3 py-1 text-xs font-semibold capitalize text-[var(--text-muted)]"
                        >
                          {CATEGORY_LABELS[category]}
                        </span>
                        <A
                          href={`/workflows/${summary.workflow.id}`}
                          class="rounded-xl border border-blue-600 px-3 py-1.5 text-blue-600"
                        >
                          Inspect
                        </A>
                      </div>
                    </header>
                    <ol class="flex flex-col gap-2 text-sm">
                      <For each={summary.steps}>
                        {(step) => (
                          <li class="rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-3">
                            <div class="flex flex-wrap items-center justify-between gap-3">
                              <p class="font-semibold text-[var(--text)]">
                                {typeof step.data?.title === 'string'
                                  ? (step.data.title as string)
                                  : `Step ${step.sequence}`}
                              </p>
                              <span class="text-xs text-[var(--text-muted)]">{step.status}</span>
                            </div>
                            <Show when={runnerStatus(step)}>
                              {(label) => <p class="mt-1 text-xs text-[var(--text-muted)]">{label()}</p>}
                            </Show>
                          </li>
                        )}
                      </For>
                    </ol>
                    <Show when={pullRequests.length > 0}>
                      <div class="mt-4 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--bg-muted)] p-4">
                        <p class="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                          Open pull requests
                        </p>
                        <ul class="mt-2 space-y-2 text-sm">
                          <For each={pullRequests}>
                            {(pr) => (
                              <li class="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
                                <div class="flex flex-wrap items-center justify-between gap-2">
                                  <p class="font-semibold text-[var(--text)]">{pr.title}</p>
                                  <span class="text-xs text-[var(--text-muted)]">
                                    {pr.sourceBranch} → {pr.targetBranch}
                                  </span>
                                </div>
                                <Show when={pr.latestReviewRun}>
                                  {(run) => (
                                    <p class="text-xs text-[var(--text-muted)]">
                                      Latest review · {run().status}
                                      <Show when={run().completedAt}>
                                        {(ts) => <span class="ml-1">({formatDate(ts())})</span>}
                                      </Show>
                                    </p>
                                  )}
                                </Show>
                              </li>
                            )}
                          </For>
                        </ul>
                      </div>
                    </Show>
                  </article>
                )}
              </For>
            </div>
          </Show>
        )}
      </Show>
      <Show when={launchOpen()}>
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={() => setLaunchOpen(false)}>
          <div
            class="max-h-[95vh] w-full max-w-5xl overflow-y-auto rounded-3xl border border-[var(--border)] bg-[var(--bg-card)] p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <WorkflowLaunchModal onClose={() => setLaunchOpen(false)} />
          </div>
        </div>
      </Show>
      <Show when={focusedSessionId()}>
        {(workflowId) => (
          <div
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
            data-testid="workflow-session-viewer"
            onClick={closeSessionView}
          >
            <div
              class="max-h-[95vh] w-full max-w-5xl overflow-y-auto rounded-3xl border border-[var(--border)] bg-[var(--bg-card)] p-6 shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <WorkflowDetailView
                workflowId={workflowId()}
                actions={
                  <button
                    type="button"
                    class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm text-[var(--text)]"
                    onClick={closeSessionView}
                  >
                    Close session
                  </button>
                }
              />
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}

function runnerStatus(step: WorkflowStep): string | null {
  if (step.status !== 'running') return null
  if (!step.runnerInstanceId) return 'Waiting for Docker runner'
  return `Runner ${shortToken(step.runnerInstanceId)}`
}

function shortToken(token: string): string {
  return token.length <= 14 ? token : `${token.slice(0, 6)}…${token.slice(-4)}`
}

function deriveCategory(summary: WorkflowSummary, map: Map<string, PullRequestSummary[]>): WorkflowCategory {
  const rawStatus = summary.workflow.status
  const status = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : ''
  const openPullRequests = map.get(summary.workflow.projectId) ?? []
  if (status === 'failed') {
    return 'failed'
  }
  if (status === 'completed' && openPullRequests.length) {
    return 'readyForReview'
  }
  if (status === 'completed' || status === 'cancelled') {
    return 'done'
  }
  return 'inProgress'
}

function formatDate(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function loadStoredFilters(): Record<WorkflowCategory, boolean> {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_FILTERS }
  }
  try {
    const serialized = window.localStorage.getItem(FILTER_STORAGE_KEY)
    if (!serialized) {
      return { ...DEFAULT_FILTERS }
    }
    const candidate = JSON.parse(serialized)
    const next: Record<WorkflowCategory, boolean> = { ...DEFAULT_FILTERS }
    if (candidate && typeof candidate === 'object') {
      for (const key of Object.keys(DEFAULT_FILTERS) as WorkflowCategory[]) {
        const value = (candidate as Record<string, unknown>)[key]
        if (typeof value === 'boolean') {
          next[key] = value
        }
      }
    }
    return next
  } catch {
    return { ...DEFAULT_FILTERS }
  }
}
