import { A, useSearchParams } from '@solidjs/router'
import { For, Show, createResource } from 'solid-js'
import { fetchJson } from '../lib/http'
import WorkflowDetailView from '../components/WorkflowDetailView'

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

export default function WorkflowsPage() {
  const [workflows, { refetch }] = createResource(async () => {
    const payload = await fetchJson<{ workflows: WorkflowSummary[] }>('/api/workflows')
    return payload.workflows
  })
  const [searchParams, setSearchParams] = useSearchParams()
  const focusedSessionId = () => {
    const value = searchParams.sessionId
    return typeof value === 'string' && value.length ? value : null
  }
  const closeSessionView = () => {
    setSearchParams({ sessionId: undefined })
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
        <div class="flex gap-3">
          <A href="/launch" class="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white">
            Launch workflow
          </A>
          <button
            class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm text-[var(--text)]"
            type="button"
            onClick={() => refetch()}
          >
            Refresh
          </button>
        </div>
      </header>

      <Show when={workflows()} fallback={<p class="text-sm text-[var(--text-muted)]">Loading workflows…</p>}>
        {(items) => (
          <Show
            when={items().length}
            fallback={<p class="text-sm text-[var(--text-muted)]">No workflows queued yet.</p>}
          >
            <div class="flex flex-col gap-4">
              <For each={items()}>
                {(item) => (
                  <article class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
                    <header class="mb-4 flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p class="text-lg font-semibold text-[var(--text)]">{item.workflow.kind}</p>
                        <p class="text-xs text-[var(--text-muted)]">Workflow · {item.workflow.status}</p>
                      </div>
                      <div class="flex gap-2 text-sm">
                        <A
                          href={`/workflows/${item.workflow.id}`}
                          class="rounded-xl border border-blue-600 px-3 py-1.5 text-blue-600"
                        >
                          Inspect
                        </A>
                      </div>
                    </header>
                    <ol class="flex flex-col gap-2 text-sm">
                      <For each={item.steps}>
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
                  </article>
                )}
              </For>
            </div>
          </Show>
        )}
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
