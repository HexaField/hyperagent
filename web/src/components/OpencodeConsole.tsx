import { For, Show, createEffect, createMemo, createResource, createSignal } from 'solid-js'
import type { JSX } from 'solid-js'
import {
  fetchOpencodeRuns,
  fetchOpencodeSessionDetail,
  fetchOpencodeSessions,
  killOpencodeSession,
  startOpencodeRun,
  type OpencodeMessage,
  type OpencodeSessionDetail
} from '../lib/opencode'

export type OpencodeConsoleProps = {
  workspaceFilter?: string
  onWorkspaceFilterChange?: (value: string) => void
  lockWorkspace?: boolean
  defaultPrompt?: string
  heading?: string
  description?: string
  class?: string
  onRunStarted?: (sessionId: string) => void
  headerActions?: JSX.Element
}

export default function OpencodeConsole(props: OpencodeConsoleProps) {
  const [workspaceValue, setWorkspaceValue] = createSignal(props.workspaceFilter ?? '')
  createEffect(() => {
    if (props.workspaceFilter !== undefined) {
      setWorkspaceValue(props.workspaceFilter)
    }
  })
  const workspaceForFetch = () => {
    const explicit = props.workspaceFilter
    if (props.lockWorkspace && typeof explicit === 'string') {
      return explicit
    }
    return workspaceValue()
  }

  const [sessions, { refetch: refetchSessions }] = createResource(workspaceForFetch, async (value) => {
    const trimmed = value?.trim()
    return await fetchOpencodeSessions(trimmed ? { workspacePath: trimmed } : undefined)
  })
  const [activeRuns, { refetch: refetchRuns }] = createResource(fetchOpencodeRuns)
  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null)
  const [sessionDetail] = createResource(selectedSessionId, async (sessionId) => {
    if (!sessionId) return null
    return await fetchOpencodeSessionDetail(sessionId)
  })

  createEffect(() => {
    const entries = sessions()
    if (!entries || entries.length === 0) {
      setSelectedSessionId(null)
      return
    }
    const current = selectedSessionId()
    if (!current || !entries.some((entry) => entry.id === current)) {
      setSelectedSessionId(entries[0].id)
    }
  })

  const [prompt, setPrompt] = createSignal(props.defaultPrompt ?? '')
  const [title, setTitle] = createSignal('')
  const [error, setError] = createSignal<string | null>(null)
  const [submitting, setSubmitting] = createSignal(false)
  const [killing, setKilling] = createSignal(false)

  const selectedDetail = createMemo<OpencodeSessionDetail | null>(() => sessionDetail() ?? null)
  const messages = createMemo<OpencodeMessage[]>(() => selectedDetail()?.messages ?? [])

  const handleWorkspaceChange = (value: string) => {
    if (props.lockWorkspace) return
    if (props.workspaceFilter === undefined) {
      setWorkspaceValue(value)
    }
    props.onWorkspaceFilterChange?.(value)
  }

  const handleStartRun: JSX.EventHandlerUnion<HTMLFormElement, SubmitEvent> = async (event) => {
    event.preventDefault()
    const workspacePath = (props.lockWorkspace ? props.workspaceFilter ?? '' : workspaceValue()).trim()
    const runPrompt = prompt().trim()
    if (!workspacePath) {
      setError('Workspace path is required')
      return
    }
    if (!runPrompt) {
      setError('Prompt is required')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const run = await startOpencodeRun({ workspacePath, prompt: runPrompt, title: title().trim() || undefined })
      setPrompt('')
      setTitle('')
      await Promise.all([refetchSessions(), refetchRuns()])
      setSelectedSessionId(run.sessionId)
      props.onRunStarted?.(run.sessionId)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start session'
      setError(message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleKill = async () => {
    const sessionId = selectedSessionId()
    if (!sessionId) return
    setKilling(true)
    setError(null)
    try {
      await killOpencodeSession(sessionId)
      await Promise.all([refetchRuns(), refetchSessions()])
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to kill session'
      setError(message)
    } finally {
      setKilling(false)
    }
  }

  const wrapperClass = () =>
    props.class ??
    'flex flex-col gap-6 rounded-[1.25rem] border border-[var(--border)] bg-[var(--bg-card)] p-6 shadow-[0_18px_30px_rgba(15,23,42,0.08)]'

  return (
    <section class={wrapperClass()}>
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div class="flex-1 space-y-2">
          <p class="text-sm uppercase tracking-[0.2em] text-[var(--text-muted)]">Opencode sessions</p>
          <h2 class="text-2xl font-semibold text-[var(--text)]">{props.heading ?? 'Opencode workspace console'}</h2>
          <p class="text-[var(--text-muted)]">
            {props.description ??
              'Launch opencode runs as detached background jobs and inspect their session timelines even after server restarts.'}
          </p>
        </div>
        <Show when={props.headerActions} keyed>
          {(actions) => <div class="flex items-center gap-2">{actions}</div>}
        </Show>
      </header>

      <div class="grid gap-6 lg:grid-cols-[320px,1fr]">
        <section class="flex flex-col gap-5">
          <form class="flex flex-col gap-3 rounded-2xl border border-[var(--border)] p-4" onSubmit={handleStartRun}>
            <h3 class="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">Start new session</h3>
            <Show when={props.lockWorkspace && props.workspaceFilter} keyed>
              {(path) => (
                <p class="rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-2 text-xs text-[var(--text-muted)]">
                  Using workspace
                  <span class="ml-1 font-semibold text-[var(--text)]">{path}</span>
                </p>
              )}
            </Show>
            <Show when={!props.lockWorkspace}>
              <label class="flex flex-col gap-1 text-sm text-[var(--text)]">
                <span class="font-semibold text-[var(--text-muted)]">Workspace path</span>
                <input
                  type="text"
                  class="rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-2"
                  value={workspaceValue()}
                  onInput={(event) => handleWorkspaceChange(event.currentTarget.value)}
                  placeholder="/path/to/repo"
                />
              </label>
            </Show>
            <label class="flex flex-col gap-1 text-sm text-[var(--text)]">
              <span class="font-semibold text-[var(--text-muted)]">Session title (optional)</span>
              <input
                type="text"
                class="rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-2"
                value={title()}
                onInput={(event) => setTitle(event.currentTarget.value)}
                placeholder="Hotfix session"
              />
            </label>
            <label class="flex flex-col gap-1 text-sm text-[var(--text)]">
              <span class="font-semibold text-[var(--text-muted)]">Prompt</span>
              <textarea
                class="min-h-[120px] rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-3"
                value={prompt()}
                onInput={(event) => setPrompt(event.currentTarget.value)}
                placeholder="Describe the task for opencode"
              />
            </label>
            <Show when={error()} keyed>
              {(message) => <p class="text-xs text-red-500">{message}</p>}
            </Show>
            <button
              type="submit"
              class="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              disabled={submitting()}
            >
              {submitting() ? 'Starting…' : 'Start session'}
            </button>
          </form>

          <section class="rounded-2xl border border-[var(--border)] p-4">
            <header class="mb-3 flex items-center justify-between text-sm font-semibold text-[var(--text-muted)]">
              <span>Active runs</span>
              <button
                type="button"
                class="text-xs text-blue-500"
                onClick={() => refetchRuns()}
                disabled={activeRuns.loading}
              >
                Refresh
              </button>
            </header>
            <Show when={(activeRuns()?.length ?? 0) > 0} fallback={<p class="text-sm text-[var(--text-muted)]">No tracked runs.</p>}>
              <ul class="flex flex-col gap-2 text-sm">
                <For each={(activeRuns() ?? []).slice(0, 5)}>
                  {(run) => (
                    <li class="rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-3">
                      <p class="font-semibold text-[var(--text)]">{run.title || run.sessionId}</p>
                      <p class="text-xs text-[var(--text-muted)]">
                        {run.status} · {new Date(run.startedAt).toLocaleString()}
                      </p>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>

          <section class="rounded-2xl border border-[var(--border)] p-4">
            <header class="mb-3 flex items-center justify-between text-sm font-semibold text-[var(--text-muted)]">
              <span>Sessions</span>
              <button
                type="button"
                class="text-xs text-blue-500"
                onClick={() => refetchSessions()}
                disabled={sessions.loading}
              >
                Refresh
              </button>
            </header>
            <Show when={(sessions()?.length ?? 0) > 0} fallback={<p class="text-sm text-[var(--text-muted)]">No sessions yet.</p>}>
              <ul class="flex max-h-[320px] flex-col gap-2 overflow-y-auto text-sm">
                <For each={sessions() ?? []}>
                  {(session) => (
                    <li>
                      <button
                        type="button"
                        class="w-full rounded-xl border border-[var(--border)] px-3 py-2 text-left"
                        classList={{ 'border-blue-500 bg-blue-50 dark:bg-blue-950/30': selectedSessionId() === session.id }}
                        onClick={() => setSelectedSessionId(session.id)}
                      >
                        <p class="font-semibold text-[var(--text)]">{session.title || session.id}</p>
                        <p class="text-xs text-[var(--text-muted)]">
                          {session.workspacePath} · {new Date(session.updatedAt).toLocaleString()}
                        </p>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>
        </section>

        <section class="flex flex-col gap-4 rounded-2xl border border-[var(--border)] p-5">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="text-sm font-semibold text-[var(--text-muted)]">Session detail</p>
              <Show when={selectedDetail()} keyed fallback={<p class="text-xs text-[var(--text-muted)]">Select a session to inspect its transcript.</p>}>
                {(detail) => (
                  <h3 class="text-xl font-semibold text-[var(--text)]">{detail.session.title || detail.session.id}</h3>
                )}
              </Show>
            </div>
            <button
              type="button"
              class="rounded-xl border border-[var(--border)] px-3 py-2 text-sm"
              onClick={handleKill}
              disabled={!selectedSessionId() || killing()}
            >
              {killing() ? 'Stopping…' : 'Kill session'}
            </button>
          </div>

          <Show when={messages().length > 0} fallback={<p class="text-sm text-[var(--text-muted)]">No transcript yet.</p>}>
            <div class="flex flex-col gap-3">
              <For each={messages()}>
                {(message) => (
                  <article class="rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-4 text-sm">
                    <header class="mb-1 flex items-center justify-between text-xs text-[var(--text-muted)]">
                      <span class="uppercase tracking-wide">{message.role}</span>
                      <span>{new Date(message.createdAt).toLocaleString()}</span>
                    </header>
                    <p class="whitespace-pre-wrap text-[var(--text)]">{message.text}</p>
                  </article>
                )}
              </For>
            </div>
          </Show>
        </section>
      </div>
    </section>
  )
}
