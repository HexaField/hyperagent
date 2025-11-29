import { useSearchParams } from '@solidjs/router'
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from 'solid-js'
import WorkflowDetailView from '../../components/WorkflowDetailView'
import WorkflowLaunchModal from '../../components/WorkflowLaunchModal'
import { fetchJson } from '../../shared/api/httpClient'

export type WorkflowRecord = {
  id: string
  projectId: string
  kind: string
  status: string
  createdAt: string
  updatedAt: string
}

export type WorkflowStep = {
  id: string
  workflowId: string
  status: string
  sequence: number
  data: Record<string, unknown>
  result: Record<string, unknown> | null
  runnerInstanceId: string | null
}

export type WorkflowSummary = {
  workflow: WorkflowRecord
  steps: WorkflowStep[]
}

const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed'
}

export type WorkflowsWidgetProps = {
  workspaceId: string
  workspaceName: string
}

export function WorkflowsWidget(props: WorkflowsWidgetProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [focusedWorkflowId, setFocusedWorkflowId] = createSignal<string | null>(
    typeof searchParams.sessionId === 'string' && searchParams.sessionId.length ? searchParams.sessionId : null
  )
  const [launchOpen, setLaunchOpen] = createSignal(false)
  onMount(() => {
    const handleLaunchRequest = () => setLaunchOpen(true)
    window.addEventListener('workspace:launch-workflow', handleLaunchRequest)
    onCleanup(() => window.removeEventListener('workspace:launch-workflow', handleLaunchRequest))
  })

  const [workflows, { refetch }] = createResource(
    () => props.workspaceId,
    async (workspaceId) => {
      if (!workspaceId) return [] as WorkflowSummary[]
      const payload = await fetchJson<{ workflows: WorkflowSummary[] }>('/api/workflows')
      return payload.workflows.filter((summary) => summary.workflow.projectId === workspaceId)
    }
  )

  createEffect(() => {
    const linkParam =
      typeof searchParams.sessionId === 'string' && searchParams.sessionId.length ? searchParams.sessionId : null
    if (linkParam) {
      setFocusedWorkflowId(linkParam)
    }
  })

  const statusCounts = createMemo(() => {
    const list = workflows() ?? []
    return list.reduce<Record<string, number>>((counts, summary) => {
      const status = summary.workflow.status
      counts[status] = (counts[status] ?? 0) + 1
      return counts
    }, {})
  })

  const sortedWorkflows = createMemo(() => {
    const list = workflows() ?? []
    return [...list].sort((a, b) => b.workflow.updatedAt.localeCompare(a.workflow.updatedAt))
  })

  const focusWorkflow = (id: string) => {
    setFocusedWorkflowId(id)
    setSearchParams({ sessionId: id })
  }

  const closeDetail = () => {
    setFocusedWorkflowId(null)
    setSearchParams({ sessionId: undefined })
  }

  const handleWorkflowQueued = (workflowId: string | null) => {
    if (workflowId) {
      focusWorkflow(workflowId)
    }
    void refetch()
    setLaunchOpen(false)
  }

  return (
    <div class="flex h-full flex-col gap-4 p-6 text-[var(--text)]">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <h2 class="text-3xl font-semibold">Runs for {props.workspaceName}</h2>
        <div class="flex flex-wrap items-center gap-2">
          <button
            class="rounded-2xl border border-[var(--border)] px-4 py-2 text-sm"
            type="button"
            onClick={() => refetch()}
          >
            Refresh
          </button>
          <button
            class="rounded-2xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
            type="button"
            onClick={() => setLaunchOpen((prev) => !prev)}
          >
            {launchOpen() ? 'Hide launcher' : 'Launch workflow'}
          </button>
        </div>
      </div>
      <Show when={launchOpen()}>
        <WorkflowLaunchModal
          projectId={props.workspaceId}
          workspaceName={props.workspaceName}
          onClose={() => setLaunchOpen(false)}
          onQueued={handleWorkflowQueued}
        />
      </Show>
      <section class="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 text-sm">
          <p class="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">Status breakdown</p>
          <ul class="space-y-2">
            <For each={Object.entries(statusCounts())}>
              {([status, count]) => (
                <li class="flex items-center justify-between">
                  <span>{STATUS_LABELS[status] ?? status}</span>
                  <span class="text-[var(--text-muted)]">{count}</span>
                </li>
              )}
            </For>
            <Show when={!Object.keys(statusCounts()).length}>
              <li class="text-[var(--text-muted)]">No runs yet.</li>
            </Show>
          </ul>
        </div>
        <div class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
          <p class="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">Recent runs</p>
          <div class="space-y-2">
            <For each={sortedWorkflows()}>
              {(summary) => (
                <button
                  class="flex w-full flex-col rounded-2xl border border-transparent px-3 py-2 text-left hover:border-[var(--border)]"
                  type="button"
                  onClick={() => focusWorkflow(summary.workflow.id)}
                >
                  <div class="flex items-center justify-between text-sm">
                    <span class="font-semibold">{summary.workflow.kind}</span>
                    <span class="text-xs text-[var(--text-muted)]">
                      {new Date(summary.workflow.updatedAt).toLocaleString()}
                    </span>
                  </div>
                  <p class="text-xs text-[var(--text-muted)]">
                    {STATUS_LABELS[summary.workflow.status] ?? summary.workflow.status}
                  </p>
                </button>
              )}
            </For>
            <Show when={!sortedWorkflows().length}>
              <p class="text-sm text-[var(--text-muted)]">No workflows have run for this workspace yet.</p>
            </Show>
          </div>
        </div>
      </section>
      <Show when={focusedWorkflowId()}>
        {(workflowId) => (
          <div class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
            <div class="mb-3 flex items-center justify-between">
              <h3 class="text-lg font-semibold">Workflow detail</h3>
              <button class="text-sm text-blue-500" type="button" onClick={closeDetail}>
                Close
              </button>
            </div>
            <WorkflowDetailView workflowId={workflowId()} />
          </div>
        )}
      </Show>
    </div>
  )
}

export default WorkflowsWidget
