import { For, Show, createEffect, createResource, createSignal } from 'solid-js'
import Agent from './Agent'
import { fetchJson } from '../lib/http'
import { buildTasksFromInput } from '../lib/workflows'

type Project = {
  id: string
  name: string
  repositoryPath: string
}

type WorkflowLaunchModalProps = {
  onClose: () => void
}

export default function WorkflowLaunchModal(props: WorkflowLaunchModalProps) {
  const [status, setStatus] = createSignal<string | null>(null)
  const [submitting, setSubmitting] = createSignal(false)
  const [form, setForm] = createSignal({
    projectId: '',
    kind: 'custom',
    tasksInput: '',
    autoStart: true
  })

  const [projects, { refetch }] = createResource(async () => {
    const payload = await fetchJson<{ projects: Project[] }>('/api/projects')
    return payload.projects
  })

  createEffect(() => {
    const list = projects()
    if (list && list.length && !form().projectId) {
      setForm((prev) => ({ ...prev, projectId: list[0].id }))
    }
  })

  const handleSubmit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!form().projectId) {
      setStatus('Select a project first')
      return
    }
    const tasks = buildTasksFromInput(form().tasksInput)
    if (!tasks.length) {
      setStatus('Enter at least one task (one per line)')
      return
    }
    setSubmitting(true)
    try {
      await fetchJson('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: form().projectId,
          kind: form().kind,
          tasks,
          autoStart: form().autoStart
        })
      })
      setForm((prev) => ({ ...prev, tasksInput: '' }))
      setStatus('Workflow queued')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to queue workflow')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div class="flex flex-col gap-6">
      <header class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p class="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)]">Launchpad</p>
          <h2 class="text-2xl font-semibold text-[var(--text)]">Queue workflows</h2>
          <p class="text-sm text-[var(--text-muted)]">Craft a plan and hand it off to the workflow engine.</p>
        </div>
        <div class="flex gap-2">
          <button
            class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm text-[var(--text)]"
            type="button"
            onClick={() => refetch()}
          >
            Refresh projects
          </button>
          <button
            class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm text-[var(--text)]"
            type="button"
            onClick={props.onClose}
          >
            Close
          </button>
        </div>
      </header>

      <div class="grid gap-6 lg:grid-cols-2">
        <form
          class="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4"
          onSubmit={handleSubmit}
        >
          <h3 class="text-lg font-semibold text-[var(--text)]">Workflow blueprint</h3>
          <label class="text-xs font-semibold text-[var(--text-muted)]" for="workflow-project">
            Project
          </label>
          <select
            id="workflow-project"
            class="rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-2 text-sm text-[var(--text)]"
            value={form().projectId}
            onChange={(event) => setForm((prev) => ({ ...prev, projectId: event.currentTarget.value }))}
          >
            <Show when={projects()} fallback={<option value="">Loading projects…</option>}>
              {(list) => (
                <>
                  <For each={list()}>{(project) => <option value={project.id}>{project.name}</option>}</For>
                </>
              )}
            </Show>
          </select>
          <label class="text-xs font-semibold text-[var(--text-muted)]" for="workflow-kind">
            Kind
          </label>
          <input
            id="workflow-kind"
            type="text"
            class="rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-2 text-sm text-[var(--text)]"
            value={form().kind}
            onInput={(event) => setForm((prev) => ({ ...prev, kind: event.currentTarget.value }))}
          />
          <label class="text-xs font-semibold text-[var(--text-muted)]" for="workflow-tasks">
            Tasks (one per line)
          </label>
          <textarea
            id="workflow-tasks"
            rows={6}
            class="rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-2 text-sm text-[var(--text)]"
            value={form().tasksInput}
            onInput={(event) => setForm((prev) => ({ ...prev, tasksInput: event.currentTarget.value }))}
            placeholder="Design landing page\nWire up API"
          />
          <label class="flex items-center gap-2 text-sm text-[var(--text)]">
            <input
              type="checkbox"
              checked={form().autoStart}
              onChange={(event) => setForm((prev) => ({ ...prev, autoStart: event.currentTarget.checked }))}
            />
            Auto start once queued
          </label>
          <button
            class="rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white disabled:opacity-60"
            type="submit"
            disabled={submitting()}
          >
            {submitting() ? 'Queuing…' : 'Queue workflow'}
          </button>
          <Show when={status()}>{(message) => <p class="text-xs text-[var(--text-muted)]">{message()}</p>}</Show>
        </form>

        <Agent />
      </div>
    </div>
  )
}
