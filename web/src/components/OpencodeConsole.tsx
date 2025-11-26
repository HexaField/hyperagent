import type { JSX } from 'solid-js'
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from 'solid-js'
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
const STORAGE_PREFIX = 'opencode-console:v1'
const STATE_EVENT = 'opencode-console:state'
const SEARCH_PARAM_SESSION = 'opencodeSession'
const SEARCH_PARAM_PAGE = 'opencodePage'
const DEFAULT_WORKSPACE_KEY = '__default__'
const MAX_PAGE_INDEX = 1
const DEFAULT_SESSION_PROMPT = 'Initialize the workspace and wait for user instructions.'
type PersistedState = {
  selectedSessionId?: string | null
  page?: number
}
type SessionState = 'running' | 'waiting' | 'completed' | 'failed' | 'terminated'

type SessionRow = OpencodeSessionSummary & {
  run: OpencodeRunRecord | null
  state: SessionState
}

function normalizeWorkspaceKey(value: string | null | undefined): string {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_WORKSPACE_KEY
}

function storageKeyFor(workspaceKey: string): string {
  return `${STORAGE_PREFIX}:${workspaceKey}`
}

function readStoredState(workspaceKey: string): PersistedState {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(storageKeyFor(workspaceKey))
    return raw ? ((JSON.parse(raw) as PersistedState) ?? {}) : {}
  } catch {
    return {}
  }
}

function readPersistedState(workspaceKey: string): PersistedState {
  const state: PersistedState = { ...readStoredState(workspaceKey) }
  if (typeof window === 'undefined') return state
  try {
    const params = new URLSearchParams(window.location.search)
    const sessionParam = params.get(SEARCH_PARAM_SESSION)
    if (sessionParam) state.selectedSessionId = sessionParam
    const pageParam = params.get(SEARCH_PARAM_PAGE)
    if (pageParam !== null) {
      const parsed = Number(pageParam)
      if (!Number.isNaN(parsed)) state.page = parsed
    }
  } catch {}
  return state
}

function persistState(workspaceKey: string, patch: Partial<PersistedState>) {
  if (typeof window === 'undefined') return
  const key = storageKeyFor(workspaceKey)
  const prevRaw = window.localStorage.getItem(key)
  let prev: PersistedState = {}
  if (prevRaw) {
    try {
      prev = JSON.parse(prevRaw) ?? {}
    } catch {}
  }
  const next: PersistedState = { ...prev, ...patch }
  const nextRaw = JSON.stringify(next)
  if (nextRaw === prevRaw) return
  try {
    window.localStorage.setItem(key, nextRaw)
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: { workspaceKey, state: next } }))
  } catch {}
}

function updateSearchParam(name: string, value: string | null | undefined) {
  if (typeof window === 'undefined') return
  try {
    const url = new URL(window.location.href)
    if (value === undefined || value === null || value === '') {
      url.searchParams.delete(name)
    } else {
      url.searchParams.set(name, value)
    }
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
  } catch {}
}

function clampPage(value: number | undefined | null): number {
  if (value === undefined || value === null || Number.isNaN(value)) return 0
  return Math.max(0, Math.min(MAX_PAGE_INDEX, Math.floor(value)))
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
  mobilePage?: number
}

export function opencodePages(props: OpencodeConsoleProps) {
  return [
    { title: 'List', content: () => <OpencodeConsole {...props} mobilePage={0} /> },
    { title: 'Details', content: () => <OpencodeConsole {...props} mobilePage={1} /> }
  ]
}

export default function OpencodeConsole(props: OpencodeConsoleProps) {
  const workspaceForFetch = () => {
    const explicit = props.workspaceFilter
    if (props.lockWorkspace && typeof explicit === 'string') {
      return explicit
    }
    return props.workspaceFilter ?? ''
  }
  const workspaceKey = createMemo(() => normalizeWorkspaceKey(workspaceForFetch()))

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

  let lastPersistedSessionKey: string | null = null
  let lastPersistedSessionId: string | null = null
  createEffect(() => {
    const key = workspaceKey()
    if (!key) return
    const current = selectedSessionId()
    const normalized = current ?? null
    if (lastPersistedSessionKey === key && lastPersistedSessionId === normalized) return
    lastPersistedSessionKey = key
    lastPersistedSessionId = normalized
    persistState(key, { selectedSessionId: normalized })
    updateSearchParam(SEARCH_PARAM_SESSION, normalized ?? undefined)
  })

  const [replyText, setReplyText] = createSignal('')
  const [error, setError] = createSignal<string | null>(null)
  const [submitting, setSubmitting] = createSignal(false)
  const [replying, setReplying] = createSignal(false)
  const [killing, setKilling] = createSignal(false)

  // shared UI refs and helpers for replies/messages (used by desktop & mobile variants)
  const [messagesEl, setMessagesEl] = createSignal<HTMLElement | null>(null)
  const [replyEl, setReplyEl] = createSignal<HTMLTextAreaElement | null>(null)
  const [autoScroll, setAutoScroll] = createSignal(true)

  function resizeReply() {
    const ta = replyEl()
    if (!ta) return
    try {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
    } catch {}
  }

  async function submitReply() {
    const sessionId = selectedSessionId()
    if (!sessionId) return
    const text = replyText().trim()
    if (!text) return
    setReplying(true)
    setError(null)
    try {
      const mod = await import('../lib/opencode')
      await mod.postOpencodeMessage(sessionId, { text })
      setReplyText('')
      const ta = replyEl()
      if (ta) ta.style.height = 'auto'
      await Promise.all([refetchSessionDetail(), refetchSessions()])
      const el = messagesEl()
      if (el) {
        try {
          el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
        } catch {}
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to post message'
      setError(message)
    } finally {
      setReplying(false)
    }
  }

  // Mobile carousel state
  const [isMobile, setIsMobile] = createSignal(false)
  // pages: 0 = List, 1 = Details
  const [currentPage, setCurrentPage] = createSignal(0)
  let lastHydratedWorkspace: string | null = null

  createEffect(() => {
    const key = workspaceKey()
    if (!key || key === lastHydratedWorkspace) return
    lastHydratedWorkspace = key
    const state = readPersistedState(key)
    if (state.selectedSessionId) setSelectedSessionId(state.selectedSessionId)
    else setSelectedSessionId(null)
    if (props.mobilePage === undefined && state.page !== undefined) {
      setCurrentPage(clampPage(state.page))
    }
  })

  let touchStartX = 0
  let touchLastX = 0
  let isTouching = false

  function goToDetailsPage() {
    if (props.mobilePage === undefined) {
      if (isMobile()) setCurrentPage(1)
      return
    }
    try {
      window.dispatchEvent(new CustomEvent('single-widget:page-set', { detail: { page: 1 } }))
    } catch {}
  }

  let lastPersistedPageKey: string | null = null
  let lastPersistedPageValue: number | null = null
  createEffect(() => {
    if (props.mobilePage !== undefined) return
    if (!isMobile()) return
    const key = workspaceKey()
    const pageValue = currentPage()
    if (!key) return
    if (lastPersistedPageKey === key && lastPersistedPageValue === pageValue) return
    lastPersistedPageKey = key
    lastPersistedPageValue = pageValue
    persistState(key, { page: pageValue })
    updateSearchParam(SEARCH_PARAM_PAGE, pageValue ? String(pageValue) : null)
  })

  onMount(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(max-width: 640px)')
    const handler = () => setIsMobile(mq.matches)
    handler()
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', handler)
    else mq.addListener(handler)

    let prevHandler: (() => void) | undefined
    let nextHandler: (() => void) | undefined
    let setHandler: ((e: Event) => void) | undefined
    if (props.mobilePage === undefined) {
      prevHandler = () => setCurrentPage((p) => Math.max(0, p - 1))
      nextHandler = () => setCurrentPage((p) => Math.min(1, p + 1))
      setHandler = (e: Event) => {
        const ce = e as CustomEvent
        const page = Number(ce?.detail?.page)
        if (!Number.isNaN(page)) setCurrentPage(Math.max(0, Math.min(1, page)))
      }
      try {
        window.addEventListener('single-widget:page-prev', prevHandler)
        window.addEventListener('single-widget:page-next', nextHandler)
        window.addEventListener('single-widget:page-set', setHandler as EventListener)
      } catch {}
    }

    const stateHandler = (event: Event) => {
      const ce = event as CustomEvent<{ workspaceKey?: string; state?: PersistedState }>
      const detail = ce?.detail
      if (!detail || detail.workspaceKey !== workspaceKey()) return
      const nextSession = detail.state?.selectedSessionId ?? null
      if (nextSession !== selectedSessionId()) {
        setSelectedSessionId(nextSession)
        lastPersistedSessionKey = workspaceKey()
        lastPersistedSessionId = nextSession
      }
      if (props.mobilePage === undefined && detail.state?.page !== undefined) {
        const desired = clampPage(detail.state.page)
        if (desired !== currentPage()) {
          setCurrentPage(desired)
          lastPersistedPageKey = workspaceKey()
          lastPersistedPageValue = desired
        }
      }
    }
    try {
      window.addEventListener(STATE_EVENT, stateHandler as EventListener)
    } catch {}

    onCleanup(() => {
      if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', handler)
      else mq.removeListener(handler)
      if (prevHandler && nextHandler && setHandler) {
        try {
          window.removeEventListener('single-widget:page-prev', prevHandler)
          window.removeEventListener('single-widget:page-next', nextHandler)
          window.removeEventListener('single-widget:page-set', setHandler as EventListener)
        } catch {}
      }
      try {
        window.removeEventListener(STATE_EVENT, stateHandler as EventListener)
      } catch {}
    })
  })

  createEffect(() => {
    if (typeof window === 'undefined') return
    if (props.mobilePage !== undefined) return
    if (!isMobile()) return
    const cur = currentPage()
    const title = cur === 0 ? 'List' : 'Details'
    try {
      window.dispatchEvent(new CustomEvent('single-widget:page-set', { detail: { page: cur } }))
      window.dispatchEvent(new CustomEvent('single-widget:page-title', { detail: { title } }))
    } catch {}
  })

  const selectedDetail = createMemo<OpencodeSessionDetail | null>(() => sessionDetail() ?? null)
  const messages = createMemo<OpencodeMessage[]>(() => selectedDetail()?.messages ?? [])

  // auto-scroll transcript when new messages arrive (unless user scrolled away)
  createEffect(() => {
    messages()
    const el = messagesEl()
    if (!el) return
    if (autoScroll()) {
      requestAnimationFrame(() => {
        try {
          el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
        } catch {}
      })
    }
  })

  createEffect(() => {
    const el = messagesEl()
    if (!el) return
    const handler = () => {
      const atBottom = Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 20
      setAutoScroll(atBottom)
    }
    el.addEventListener('scroll', handler)
    onCleanup(() => el.removeEventListener('scroll', handler))
  })

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

  async function startNewSession() {
    const workspacePath = workspaceForFetch().trim()
    if (!workspacePath) {
      setError('Workspace path is required')
      return
    }
    const runPrompt = props.defaultPrompt?.trim() || DEFAULT_SESSION_PROMPT
    setSubmitting(true)
    setError(null)
    try {
      const run = await startOpencodeRun({
        workspacePath,
        prompt: runPrompt,
        model: OPENCODE_MODEL
      })
      await Promise.all([refetchSessions(), refetchRuns()])
      setSelectedSessionId(run.sessionId)
      goToDetailsPage()
      props.onRunStarted?.(run.sessionId)
      requestAnimationFrame(() => {
        const el = replyEl()
        if (!el) return
        try {
          el.focus()
          el.scrollIntoView({ block: 'nearest' })
        } catch {}
      })
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

  // swipe handling on the header swipe zone (internal fallback)
  function onTouchStart(e: TouchEvent) {
    if (!isMobile()) return
    const t = e.touches[0]
    touchStartX = t.clientX
    touchLastX = touchStartX
    isTouching = true
  }
  function onTouchMove(e: TouchEvent) {
    if (!isTouching) return
    touchLastX = e.touches[0].clientX
  }
  function onTouchEnd() {
    if (!isTouching) return
    const delta = touchLastX - touchStartX
    const threshold = 50
    if (delta > threshold) {
      // inverted: swipe right -> previous page
      setCurrentPage((p) => Math.max(0, p - 1))
    } else if (delta < -threshold) {
      // inverted: swipe left -> next page
      setCurrentPage((p) => Math.min(1, p + 1))
    }
    isTouching = false
    touchStartX = 0
    touchLastX = 0
  }

  function SessionsPanel(options?: { class?: string }) {
    return (
      <section class={`rounded-2xl border border-[var(--border)] p-4 ${options?.class ?? ''}`}>
        <header class="mb-3 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            class="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            onClick={() => void startNewSession()}
            disabled={submitting()}
          >
            {submitting() ? 'Starting…' : 'New session'}
          </button>
        </header>
        <Show when={error()} keyed>
          {(message) => <p class="mb-2 text-xs text-red-500">{message}</p>}
        </Show>
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
                    onClick={() => {
                      setSelectedSessionId(session.id)
                      goToDetailsPage()
                    }}
                  >
                    <div class="min-w-0">
                      <p class="truncate font-semibold text-[var(--text)]">{session.title || session.id}</p>
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
    )
  }

  // helper to render session detail
  function SessionDetail(options?: { class?: string; variant?: 'desktop' | 'mobile'; showKillAction?: boolean }) {
    const variant = options?.variant ?? 'desktop'
    const isMobileVariant = variant === 'mobile'
    const sectionClass =
      options?.class ??
      (isMobileVariant ? 'flex flex-col gap-4' : 'flex flex-col gap-4 rounded-2xl border border-[var(--border)] p-5')
    const transcriptWrapperClass = isMobileVariant
      ? 'relative flex-1 min-h-0'
      : 'flex max-h-[520px] flex-col gap-3 overflow-y-auto pr-1'
    const transcriptScrollerClass = isMobileVariant ? 'overflow-y-auto pr-1 space-y-3 max-h-[48vh]' : 'space-y-3'
    const articleClass = 'rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-4 text-sm'
    const showKillAction = options?.showKillAction ?? !isMobileVariant

    return (
      <section class={sectionClass}>
        <div class="flex items-start justify-between gap-3">
          <div class="flex-1 min-w-0">
            <p class="text-sm font-semibold text-[var(--text-muted)]">Session detail</p>
            <Show
              when={selectedDetail()}
              keyed
              fallback={<p class="text-xs text-[var(--text-muted)]">Select a session to inspect its transcript.</p>}
            >
              {(detail) => (
                <div class="flex items-center gap-3">
                  <h3 class={`text-base font-semibold text-[var(--text)] ${isMobileVariant ? 'truncate' : ''}`}>
                    {detail.session.title || detail.session.id}
                  </h3>

                  <Show when={!isMobileVariant}>
                    <Show when={selectedSessionMeta()?.state} keyed>
                      {(state) => (
                        <span class={`rounded-full px-2 py-0.5 text-xs font-semibold ${sessionStateBadgeClass(state)}`}>
                          {sessionStateLabel(state)}
                        </span>
                      )}
                    </Show>
                  </Show>

                  <Show when={isMobileVariant}>
                    <Show when={selectedSessionMeta()?.state} keyed>
                      {(state) => <span class={`${sessionStateDotClass(state)} ml-2`} />}
                    </Show>
                  </Show>
                </div>
              )}
            </Show>
          </div>

          <Show when={showKillAction}>
            <button
              type="button"
              class="rounded-xl border border-[var(--border)] px-3 py-2 text-sm"
              onClick={handleKill}
              disabled={!selectedSessionId() || killing()}
            >
              {killing() ? 'Stopping…' : 'Kill session'}
            </button>
          </Show>
        </div>

        <Show
          when={messages().length > 0}
          fallback={<p class="text-sm text-[var(--text-muted)]">No transcript yet.</p>}
        >
          <div class={transcriptWrapperClass}>
            <div ref={(el) => setMessagesEl(el ?? null)} class={transcriptScrollerClass}>
              <For each={messages()}>
                {(message) => (
                  <article class={articleClass}>
                    <header class="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
                      <span class="uppercase tracking-wide">{message.role}</span>
                      <span>{new Date(message.createdAt).toLocaleString()}</span>
                    </header>
                    <div class="whitespace-pre-wrap text-[var(--text)] break-words text-sm">
                      {renderMessageContent(message.text)}
                    </div>
                  </article>
                )}
              </For>
            </div>

            <Show when={isMobileVariant}>
              <button
                type="button"
                class="absolute right-3 bottom-3 w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center text-base shadow-lg z-50"
                classList={{ hidden: autoScroll() }}
                onClick={() => {
                  const el = messagesEl()
                  if (el) {
                    try {
                      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
                    } catch {}
                  }
                  setAutoScroll(true)
                }}
                title="Scroll to bottom"
              >
                ↓
              </button>
            </Show>
          </div>
        </Show>

        <form
          class="mt-3 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void submitReply()
          }}
        >
          <textarea
            ref={(el) => setReplyEl(el ?? null)}
            class="flex-1 rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-2 text-sm resize-none max-h-48"
            placeholder="Reply to session"
            value={replyText()}
            onInput={(e) => {
              setReplyText(e.currentTarget.value)
              resizeReply()
            }}
            onFocus={() => {
              const el = messagesEl()
              if (el) {
                try {
                  setTimeout(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }), 120)
                } catch {}
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submitReply()
              }
            }}
            disabled={!selectedSessionId() || replying()}
          />
          <button
            type="button"
            class="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            onClick={() => void submitReply()}
            disabled={!selectedSessionId() || replying()}
          >
            {replying() ? 'Sending…' : 'Reply'}
          </button>
        </form>
      </section>
    )
  }

  function renderMessageContent(text: string) {
    return text.split('\n').map((line) => {
      if (line.startsWith('🔧 Tool:')) {
        return (
          <div class="flex items-center gap-2 text-blue-600 dark:text-blue-400">
            <span>🔧</span>
            <span class="font-medium">Tool:</span>
            <span class="break-words">{line.slice('🔧 Tool:'.length).trim()}</span>
          </div>
        )
      }
      if (line.startsWith('▶️ Step:')) {
        return (
          <div class="flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <span>▶️</span>
            <span class="font-medium">Step:</span>
            <span class="break-words">{line.slice('▶️ Step:'.length).trim()}</span>
          </div>
        )
      }
      if (line.startsWith('✅ Step:')) {
        return (
          <div class="flex items-center gap-2 text-green-600 dark:text-green-400">
            <span>✅</span>
            <span class="font-medium">Step:</span>
            <span class="break-words">{line.slice('✅ Step:'.length).trim()}</span>
          </div>
        )
      }
      return <p class="mb-1 last:mb-0 break-words">{line}</p>
    })
  }

  // Desktop/large layout (original)
  const DesktopLayout = (
    <div class="grid gap-6 lg:grid-cols-[320px,1fr]">
      <section class="flex flex-col gap-5">{SessionsPanel()}</section>
      {SessionDetail()}
    </div>
  )

  // Mobile layout: header with centered swipe zone + two pages carousel
  const MobileLayout = (
    <div class="flex flex-col h-full">
      <div class="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] bg-[var(--bg-muted)]">
        <div class="w-1/4 text-sm font-semibold text-[var(--text-muted)]">Opencode</div>
        <div class="flex items-center justify-center w-1/2 gap-2">
          <Show when={currentPage() > 0} fallback={<div class="w-6" />}>
            <button
              type="button"
              class="text-sm rounded p-1"
              aria-label="Previous page"
              onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
            >
              ‹
            </button>
          </Show>

          <div
            class="flex-1 h-8"
            onTouchStart={(e) => onTouchStart(e as unknown as TouchEvent)}
            onTouchMove={(e) => onTouchMove(e as unknown as TouchEvent)}
            onTouchEnd={() => onTouchEnd()}
            role="group"
            aria-label="Swipe pages"
          >
            <div class="h-full flex items-center justify-center text-xs text-[var(--text-muted)]">
              {currentPage() === 0 ? 'List' : 'Details'}
            </div>
          </div>

          <Show when={currentPage() < 1} fallback={<div class="w-6" />}>
            <button
              type="button"
              class="text-sm rounded p-1"
              aria-label="Next page"
              onClick={() => setCurrentPage((p) => Math.min(1, p + 1))}
            >
              ›
            </button>
          </Show>
        </div>
        <div class="w-1/4" />
      </div>

      <div class="flex-1 overflow-hidden">
        <div
          class="single-widget-pages flex h-full transition-transform duration-300"
          style={{ transform: `translateX(-${currentPage() * 100}%)` }}
        >
          <div class="single-widget-page w-full p-4 overflow-auto" data-single-widget-title="List">
            <div class="flex flex-col gap-4">{SessionsPanel()}</div>
          </div>
          <div class="single-widget-page w-full p-4 overflow-auto" data-single-widget-title="Details">
            {SessionDetail({ variant: 'mobile' })}
          </div>
        </div>
      </div>
    </div>
  )

  if (typeof props.mobilePage === 'number') {
    const pageIndex = Math.max(0, Math.min(MAX_PAGE_INDEX, props.mobilePage))
    if (pageIndex === 0) {
      return <div class={`flex flex-col gap-4 ${props.class ?? ''}`}>{SessionsPanel()}</div>
    }
    return (
      <div class={`flex h-full flex-col gap-4 ${props.class ?? ''}`}>
        {SessionDetail({ variant: 'mobile', showKillAction: true })}
      </div>
    )
  }

  if (isMobile()) {
    return MobileLayout
  }

  return DesktopLayout
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

function sessionStateDotClass(state: SessionState): string {
  switch (state) {
    case 'running':
      return 'inline-block shrink-0 w-3 h-3 aspect-square rounded-full bg-emerald-500 ring-1 ring-[var(--border)]'
    case 'waiting':
      return 'inline-block shrink-0 w-3 h-3 aspect-square rounded-full bg-slate-400 ring-1 ring-[var(--border)]'
    case 'completed':
      return 'inline-block shrink-0 w-3 h-3 aspect-square rounded-full bg-blue-500 ring-1 ring-[var(--border)]'
    case 'failed':
      return 'inline-block shrink-0 w-3 h-3 aspect-square rounded-full bg-red-500 ring-1 ring-[var(--border)]'
    case 'terminated':
      return 'inline-block shrink-0 w-3 h-3 aspect-square rounded-full bg-amber-500 ring-1 ring-[var(--border)]'
    default:
      return 'inline-block shrink-0 w-3 h-3 aspect-square rounded-full bg-slate-400 ring-1 ring-[var(--border)]'
  }
}
