import type { JSX } from 'solid-js'
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from 'solid-js'
import {
  fetchOpencodeRuns,
  fetchOpencodeSessionDetail,
  fetchOpencodeSessions,
  killOpencodeSession,
  startOpencodeRun,
  type OpencodeMessage,
  type OpencodeRunRecord,
  type OpencodeSessionDetail,
  type OpencodeSessionSummary
} from '../lib/opencode'

const REFRESH_INTERVAL_MS = 4000
const OPENCODE_MODEL = 'github-copilot/gpt-5-mini'
type SessionState = 'running' | 'waiting' | 'completed' | 'failed' | 'terminated'

type SessionRow = OpencodeSessionSummary & {
  run: OpencodeRunRecord | null
  state: SessionState
}

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
  hideHeader?: boolean
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
  const [runs, { refetch: refetchRuns }] = createResource(fetchOpencodeRuns)
  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null)
  const [sessionDetail, { refetch: refetchSessionDetail }] = createResource(selectedSessionId, async (sessionId) => {
    if (!sessionId) return null
    return await fetchOpencodeSessionDetail(sessionId)
  })

  createEffect(() => {
    const handle = setInterval(() => {
      void refetchSessions()
      void refetchRuns()
    }, REFRESH_INTERVAL_MS)
    onCleanup(() => clearInterval(handle))
  })

  createEffect(() => {
    const current = selectedSessionId()
    if (!current) return
    const handle = setInterval(() => {
      void refetchSessionDetail()
    }, REFRESH_INTERVAL_MS)
    onCleanup(() => clearInterval(handle))
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
  const [replyText, setReplyText] = createSignal('')
  const [error, setError] = createSignal<string | null>(null)
  const [submitting, setSubmitting] = createSignal(false)
  const [replying, setReplying] = createSignal(false)
  const [killing, setKilling] = createSignal(false)

  const selectedDetail = createMemo<OpencodeSessionDetail | null>(() => sessionDetail() ?? null)
  const messages = createMemo<OpencodeMessage[]>(() => selectedDetail()?.messages ?? [])
  const sessionRows = createMemo<SessionRow[]>(() => {
    const currentSessions = sessions() ?? []
    const runIndex = new Map((runs() ?? []).map((run) => [run.sessionId, run]))
    return currentSessions.map((session) => {
      const run = runIndex.get(session.id) ?? null
      return {
        ...session,
        run,
        state: deriveSessionState(run)
      }
    })
  })
  const selectedSessionMeta = createMemo<SessionRow | null>(() => {
    const sessionId = selectedSessionId()
    if (!sessionId) return null
    return sessionRows().find((row) => row.id === sessionId) ?? null
  })

  const handleWorkspaceChange = (value: string) => {
    if (props.lockWorkspace) return
    if (props.workspaceFilter === undefined) {
      setWorkspaceValue(value)
    }
    props.onWorkspaceFilterChange?.(value)
  }

  const handleStartRun: JSX.EventHandlerUnion<HTMLFormElement, SubmitEvent> = async (event) => {
    event.preventDefault()
    const workspacePath = (props.lockWorkspace ? (props.workspaceFilter ?? '') : workspaceValue()).trim()
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
      const run = await startOpencodeRun({
        workspacePath,
        prompt: runPrompt,
        title: title().trim() || undefined,
        model: OPENCODE_MODEL
      })
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

  const handleReply: JSX.EventHandlerUnion<HTMLFormElement, SubmitEvent> = async (event) => {
    event.preventDefault()
    const sessionId = selectedSessionId()
    if (!sessionId) return
    const text = replyText().trim()
    if (!text) return
    setReplying(true)
    setError(null)
    try {
      // lazy import to avoid circular deps in tests
      const mod = await import('../lib/opencode')
      await mod.postOpencodeMessage(sessionId, { text })
      setReplyText('')
      await Promise.all([refetchSessionDetail(), refetchSessions()])
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to post message'
      setError(message)
    } finally {
      setReplying(false)
    }
  }

  return (
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
            <span>Sessions</span>
            <span class="text-xs font-normal text-[var(--text-muted)]">Updates continuously</span>
          </header>
          <Show
            when={sessionRows().length > 0}
            fallback={<p class="text-sm text-[var(--text-muted)]">No sessions yet.</p>}
          >
            <ul class="flex max-h-[420px] flex-col gap-2 overflow-y-auto text-sm">
              <For each={sessionRows()}>
                {(session) => (
                  <li>
                    <button
                      type="button"
                      class="w-full rounded-xl border border-[var(--border)] px-3 py-2 text-left transition hover:border-blue-400"
                      classList={{
                        'border-blue-500 bg-blue-50 dark:bg-blue-950/30': selectedSessionId() === session.id,
                        'border-emerald-500 ring-2 ring-emerald-200 dark:ring-emerald-900': session.state === 'running'
                      }}
                      onClick={() => setSelectedSessionId(session.id)}
                    >
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                          <p class="truncate font-semibold text-[var(--text)]">{session.title || session.id}</p>
                          <p class="text-xs text-[var(--text-muted)]">{session.workspacePath}</p>
                        </div>
                        <span
                          class={`rounded-full px-2 py-0.5 text-xs font-semibold ${sessionStateBadgeClass(session.state)}`}
                        >
                          {sessionStateLabel(session.state)}
                        </span>
                      </div>
                      <p class="mt-1 text-xs text-[var(--text-muted)]">
                        Updated {new Date(session.updatedAt).toLocaleString()}
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
            <Show
              when={selectedDetail()}
              keyed
              fallback={<p class="text-xs text-[var(--text-muted)]">Select a session to inspect its transcript.</p>}
            >
              {(detail) => (
                <div class="flex items-center gap-3">
                  <h3 class="text-xl font-semibold text-[var(--text)]">{detail.session.title || detail.session.id}</h3>
                  <Show when={selectedSessionMeta()?.state} keyed>
                    {(state) => (
                      <span class={`rounded-full px-2 py-0.5 text-xs font-semibold ${sessionStateBadgeClass(state)}`}>
                        {sessionStateLabel(state)}
                      </span>
                    )}
                  </Show>
                </div>
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

        <Show
          when={messages().length > 0}
          fallback={<p class="text-sm text-[var(--text-muted)]">No transcript yet.</p>}
        >
          <div class="flex max-h-[520px] flex-col gap-3 overflow-y-auto pr-1">
            <For each={messages()}>
              {(message) => (
                <article class="rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-4 text-sm">
                  <header class="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
                    <span class="uppercase tracking-wide">{message.role}</span>
                    <span>{new Date(message.createdAt).toLocaleString()}</span>
                  </header>
                  <div class="whitespace-pre-wrap text-[var(--text)]">
                    {message.text.split('\n').map((line) => {
                      if (line.startsWith('🔧 Tool:')) {
                        return (
                          <div class="flex items-center gap-2 text-blue-600 dark:text-blue-400">
                            <span>🔧</span>
                            <span class="font-medium">Tool:</span>
                            <span>{line.slice('🔧 Tool:'.length).trim()}</span>
                          </div>
                        )
                      }
                      if (line.startsWith('▶️ Step:')) {
                        return (
                          <div class="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                            <span>▶️</span>
                            <span class="font-medium">Step:</span>
                            <span>{line.slice('▶️ Step:'.length).trim()}</span>
                          </div>
                        )
                      }
                      if (line.startsWith('✅ Step:')) {
                        return (
                          <div class="flex items-center gap-2 text-green-600 dark:text-green-400">
                            <span>✅</span>
                            <span class="font-medium">Step:</span>
                            <span>{line.slice('✅ Step:'.length).trim()}</span>
                          </div>
                        )
                      }
                      return <p class="mb-1 last:mb-0">{line}</p>
                    })}
                  </div>
                </article>
              )}
            </For>
          </div>
        </Show>

        <form class="mt-3 flex gap-2" onSubmit={handleReply}>
          <input
            type="text"
            class="flex-1 rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-2 text-sm"
            placeholder="Reply to session"
            value={replyText()}
            onInput={(e) => setReplyText(e.currentTarget.value)}
            disabled={!selectedSessionId() || replying()}
          />
          <button
            type="submit"
            class="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={!selectedSessionId() || replying()}
          >
            {replying() ? 'Sending…' : 'Reply'}
          </button>
        </form>
      </section>
    </div>
  )
}

const SESSION_STATE_META: Record<SessionState, { label: string; badgeClass: string }> = {
  running: {
    label: 'Running',
    badgeClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-400/20 dark:text-emerald-200'
  },
  waiting: {
    label: 'Waiting',
    badgeClass: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200'
  },
  completed: {
    label: 'Completed',
    badgeClass: 'bg-blue-100 text-blue-700 dark:bg-blue-400/20 dark:text-blue-200'
  },
  failed: {
    label: 'Failed',
    badgeClass: 'bg-red-100 text-red-700 dark:bg-red-400/20 dark:text-red-200'
  },
  terminated: {
    label: 'Stopped',
    badgeClass: 'bg-amber-100 text-amber-700 dark:bg-amber-400/20 dark:text-amber-100'
  }
}

function deriveSessionState(run: OpencodeRunRecord | null | undefined): SessionState {
  if (!run) return 'waiting'
  switch (run.status) {
    case 'starting':
    case 'running':
      return 'running'
    case 'failed':
      return 'failed'
    case 'terminated':
      return 'terminated'
    case 'exited':
      return 'completed'
    default:
      return 'waiting'
  }
}

function sessionStateLabel(state: SessionState): string {
  return SESSION_STATE_META[state].label
}

function sessionStateBadgeClass(state: SessionState): string {
  return SESSION_STATE_META[state].badgeClass
}
