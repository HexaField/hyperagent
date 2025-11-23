import { A, useParams } from '@solidjs/router'
import { For, Show, createEffect, createResource, createSignal } from 'solid-js'
import DiffViewer from '../components/DiffViewer'
import { fetchJson } from '../lib/http'

type WorkflowRecord = {
  id: string
  projectId: string
  status: string
  kind: string
  data: Record<string, unknown>
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
  updatedAt: string
}

type WorkflowDetail = {
  workflow: WorkflowRecord
  steps: WorkflowStep[]
}

type DiffPayload = {
  workflowId: string
  stepId: string
  commitHash: string
  branch: string
  message: string
  diffText: string
}

export default function WorkflowDetailPage() {
  const params = useParams()
  const [selectedStepId, setSelectedStepId] = createSignal<string | null>(null)
  const [diffError, setDiffError] = createSignal<string | null>(null)

  const [detail] = createResource(
    () => params.workflowId,
    async (workflowId) => {
      if (!workflowId) return null
      return await fetchJson<WorkflowDetail>(`/api/workflows/${workflowId}`)
    }
  )

  const workflowRecord = () => detail()?.workflow ?? null

  createEffect(() => {
    const summary = detail()
    if (!summary) return
    if (!selectedStepId()) {
      const firstWithCommit = summary.steps.find((step) => hasCommit(step))
      setSelectedStepId(firstWithCommit?.id ?? summary.steps[0]?.id ?? null)
    }
  })

  const [diff] = createResource(
    () => {
      const workflowId = params.workflowId
      const stepId = selectedStepId()
      if (!workflowId || !stepId) return null
      return { workflowId, stepId }
    },
    async (input) => {
      if (!input) return null
      try {
        setDiffError(null)
        return await fetchJson<DiffPayload>(`/api/workflows/${input.workflowId}/steps/${input.stepId}/diff`)
      } catch (error) {
        setDiffError(error instanceof Error ? error.message : 'Diff unavailable')
        return null
      }
    }
  )

  return (
    <div class="flex flex-col gap-6">
      <header class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p class="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)]">Workflow detail</p>
          <h1 class="text-3xl font-semibold text-[var(--text)]">
            {workflowRecord() ? `${workflowRecord()!.kind} workflow` : 'Loading…'}
          </h1>
          <Show when={workflowRecord()}>
            {(workflow) => (
              <p class="text-[var(--text-muted)]">
                Status · {workflow().status} — started {new Date(workflow().createdAt).toLocaleString()}
              </p>
            )}
          </Show>
        </div>
        <A href="/workflows" class="text-sm text-blue-600">
          Back to workflows
        </A>
      </header>

      <div class="grid gap-6 lg:grid-cols-[320px,1fr]">
        <section class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
          <h2 class="mb-3 text-lg font-semibold text-[var(--text)]">Steps</h2>
          <Show when={detail()} fallback={<p class="text-sm text-[var(--text-muted)]">Loading steps…</p>}>
            {(payload) => (
              <ol class="flex flex-col gap-2">
                <For each={payload().steps}>
                  {(step) => (
                    <li>
                      <button
                        type="button"
                        class="w-full rounded-xl border border-[var(--border)] px-3 py-2 text-left text-sm"
                        classList={{
                          'bg-blue-600 text-white': selectedStepId() === step.id,
                          'bg-[var(--bg-muted)] text-[var(--text)]': selectedStepId() !== step.id
                        }}
                        onClick={() => setSelectedStepId(step.id)}
                      >
                        <div class="flex items-center justify-between gap-3">
                          <span class="font-semibold">
                            {typeof step.data?.title === 'string'
                              ? (step.data.title as string)
                              : `Step ${step.sequence}`}
                          </span>
                          <span class="text-xs capitalize">{step.status}</span>
                        </div>
                        <Show when={hasCommit(step)}>
                          <p class="text-xs opacity-70">Commit ready</p>
                        </Show>
                      </button>
                    </li>
                  )}
                </For>
              </ol>
            )}
          </Show>
        </section>

        <section class="flex flex-col gap-3">
          <header>
            <h2 class="text-lg font-semibold text-[var(--text)]">Diff preview</h2>
            <Show when={diffError()}>{(message) => <p class="text-xs text-red-500">{message()}</p>}</Show>
          </header>
          <DiffViewer diffText={diff()?.diffText ?? null} />
        </section>
      </div>
    </div>
  )
}

function hasCommit(step: WorkflowStep): boolean {
  const commitPayload = (step.result as Record<string, any> | null)?.commit as Record<string, any> | undefined
  return typeof commitPayload?.commitHash === 'string'
}
