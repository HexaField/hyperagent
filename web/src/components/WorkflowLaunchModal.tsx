import { Show, createSignal } from 'solid-js'
import { fetchJson } from '../lib/http'

type WorkflowLaunchModalProps = {
  projectId: string
  workspaceName?: string
  onClose?: () => void
  onQueued?: (workflowId: string | null) => void
}

type WorkflowCreationResponse = {
  workflow: {
    id: string
    projectId: string
    status: string
    kind: string
    createdAt: string
    updatedAt: string
  }
}

type StatusPayload = {
  kind: 'info' | 'error'
  message: string
}

export default function WorkflowLaunchModal(props: WorkflowLaunchModalProps) {
  const [prompt, setPrompt] = createSignal('')
  const [status, setStatus] = createSignal<StatusPayload | null>(null)
  const [submitting, setSubmitting] = createSignal(false)

  const handleSubmit = async (event: SubmitEvent) => {
    event.preventDefault()
    const trimmedPrompt = prompt().trim()
    if (!trimmedPrompt.length) {
      setStatus({ kind: 'error', message: 'Tell Hyperagent what to build or fix.' })
      return
    }
    if (!props.projectId) {
      setStatus({ kind: 'error', message: 'Select a workspace to launch workflows.' })
      return
    }
    setSubmitting(true)
    setStatus(null)
    try {
      const payload = buildWorkflowPayload(props.projectId, trimmedPrompt, props.workspaceName)
      const response = await fetchJson<WorkflowCreationResponse>('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      setPrompt('')
      setStatus({ kind: 'info', message: 'Queued — dockerized multi-agent flow is spinning up.' })
      const workflowId = response?.workflow?.id ?? null
      props.onQueued?.(workflowId)
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Failed to queue workflow'
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      class="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4"
      onSubmit={handleSubmit}
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p class="text-xs uppercase tracking-[0.25em] text-[var(--text-muted)]">Launch workflow</p>
          <p class="text-base font-semibold text-[var(--text)]">
            {props.workspaceName ? `For ${props.workspaceName}` : 'Scoped to this workspace'}
          </p>
          <p class="text-xs text-[var(--text-muted)]">Single prompt → planned tasks → dockerized multi-agent runs.</p>
        </div>
        {props.onClose && (
          <button
            class="rounded-xl border border-[var(--border)] px-3 py-1.5 text-xs"
            type="button"
            onClick={props.onClose}
          >
            Close
          </button>
        )}
      </div>
      <textarea
        rows={4}
        class="rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-3 text-sm"
        value={prompt()}
        onInput={(event) => setPrompt(event.currentTarget.value)}
        placeholder="Ship docs for the new API, add tests, and prep a release checklist."
      />
      <Show when={status()} keyed>
        {(entry) => (
          <p class={entry.kind === 'error' ? 'text-xs text-red-500' : 'text-xs text-[var(--text-muted)]'}>
            {entry.message}
          </p>
        )}
      </Show>
      <div class="flex flex-wrap items-center gap-3">
        <button
          class="rounded-2xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          type="submit"
          disabled={submitting()}
        >
          {submitting() ? 'Queuing…' : 'Launch workflow'}
        </button>
        <p class="text-xs text-[var(--text-muted)]">Auto-started with dockerized runners per task.</p>
      </div>
    </form>
  )
}

function buildWorkflowPayload(projectId: string, prompt: string, workspaceName?: string) {
  const taskId = `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const title = prompt.length > 80 ? `${prompt.slice(0, 77)}…` : prompt || 'Workflow prompt'
  return {
    projectId,
    kind: 'prompt',
    tasks: [
      {
        id: taskId,
        title,
        instructions: prompt,
        metadata: {
          source: 'prompt_form',
          workspaceName: workspaceName ?? null
        }
      }
    ],
    data: {
      prompt,
      workspaceName: workspaceName ?? null,
      source: 'prompt_form'
    },
    autoStart: true
  }
}
