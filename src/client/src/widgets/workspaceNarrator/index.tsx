import { Show, createEffect, createMemo, createResource, createSignal, onCleanup } from 'solid-js'
import MessageScroller from '../../components/MessageScroller'
import type { CodingAgentMessage, CodingAgentMessagePart } from '../../lib/codingAgent'
import { fetchNarratorFeed, fetchNarratorRawLog, postNarratorMessage } from '../../lib/narratorFeed'
import type { WorkspaceNarratorEvent } from '../../../../interfaces/widgets/workspaceNarrator'

const POLL_INTERVAL_MS = 5000
const FAST_POLL_INTERVAL_MS = 1000
const DEFAULT_LIMIT = 50
const SOURCE_LABELS: Record<WorkspaceNarratorEvent['source'], string> = {
  narrator: 'Narrator',
  agent: 'Agent',
  system: 'System',
  user: 'You'
}
const TYPE_LABELS: Record<WorkspaceNarratorEvent['type'], string> = {
  narration: 'Narration',
  'agent-update': 'Agent update',
  'agent-result': 'Agent result',
  suppressed: 'Suppressed output',
  summary: 'Summary refresh',
  error: 'Error'
}
const SEVERITY_ICONS: Record<WorkspaceNarratorEvent['severity'], string> = {
  info: 'ℹ️',
  warning: '⚠️',
  error: '❗'
}

export type WorkspaceNarratorWidgetProps = {
  workspaceId: string
  workspaceName: string
  repositoryPath: string
}

export function WorkspaceNarratorWidget(props: WorkspaceNarratorWidgetProps) {
  const normalizedWorkspaceId = () => (props.workspaceId ?? '').trim()
  const [messageInput, setMessageInput] = createSignal('')
  const [sending, setSending] = createSignal(false)
  const [composerError, setComposerError] = createSignal<string | null>(null)
  const [relayState, setRelayState] = createSignal<'idle' | 'pending' | 'success' | 'error'>('idle')
  const [relayError, setRelayError] = createSignal<string | null>(null)
  const [relayTrackingEventId, setRelayTrackingEventId] = createSignal<string | null>(null)
  const [pollInterval, setPollInterval] = createSignal(POLL_INTERVAL_MS)
  const [rawStreamOpen, setRawStreamOpen] = createSignal(false)
  const [rawStream, setRawStream] = createSignal<string | null>(null)
  const [rawStreamLoading, setRawStreamLoading] = createSignal(false)
  const [rawStreamError, setRawStreamError] = createSignal<string | null>(null)
  const [autoScroll, setAutoScroll] = createSignal(true)
  const [scrollTrigger, setScrollTrigger] = createSignal(0)

  const [feed, { refetch }] = createResource(normalizedWorkspaceId, async (workspaceId) => {
    const target = workspaceId?.trim() || normalizedWorkspaceId()
    if (!target) {
      return { workspaceId: '', conversationId: '', events: [] }
    }
    return await fetchNarratorFeed({ workspaceId: target, limit: DEFAULT_LIMIT })
  })

  createEffect(() => {
    const interval = pollInterval()
    if (!Number.isFinite(interval) || interval <= 0) return
    const timer = setInterval(() => {
      void refetch()
    }, interval)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(() => {
    const tracked = relayTrackingEventId()
    const events = feed()?.events ?? []
    if (!tracked || events.length === 0) return
    if (events.some((event) => event.id === tracked)) {
      setRelayTrackingEventId(null)
      setRelayState('success')
      setSending(false)
      setPollInterval(POLL_INTERVAL_MS)
    }
  })

  createEffect(() => {
    if (relayState() !== 'success') return
    const timer = setTimeout(() => {
      setRelayState('idle')
    }, 4000)
    onCleanup(() => clearTimeout(timer))
  })

  const timelineMessages = createMemo<CodingAgentMessage[]>(() => {
    const events = feed()?.events ?? []
    const ordered = [...events].reverse()
    return ordered.map((event) => ({
      id: event.id,
      role: formatRole(event),
      createdAt: event.timestamp,
      completedAt: event.timestamp,
      modelId: null,
      providerId: null,
      text: formatEventBody(event),
      parts: buildMessageParts(event)
    }))
  })

  const conversationLabel = createMemo(() => {
    const conversationId = feed()?.conversationId
    if (conversationId) return `Conversation ${conversationId}`
    const workspace = normalizedWorkspaceId()
    return workspace ? `Workspace ${workspace}` : 'No workspace detected'
  })

  const rawLogsUrl = createMemo(() => {
    const id = normalizedWorkspaceId()
    return id ? `/api/workspaces/${encodeURIComponent(id)}/narrator/raw` : '#'
  })

  const summaryRef = createMemo(() => feed()?.summaryRef ?? null)
  const messageCount = createMemo(() => timelineMessages().length)
  const hasMessages = createMemo(() => messageCount() > 0)

  const formatErrorMessage = () => {
    const error = feed.error
    if (!error) return null
    return error instanceof Error ? error.message : String(error)
  }

  const handleSend = async (event?: Event) => {
    event?.preventDefault()
    if (sending()) return
    const workspaceId = normalizedWorkspaceId()
    const message = messageInput().trim()
    if (!workspaceId || !message) {
      setComposerError('Message text is required')
      return
    }
    setSending(true)
    setComposerError(null)
    setRelayError(null)
    setRelayState('pending')
    setRelayTrackingEventId(null)
    setPollInterval(FAST_POLL_INTERVAL_MS)
    try {
      const response = await postNarratorMessage({ workspaceId, message })
      setMessageInput('')
      const nextEventId = response.eventId ?? null
      setRelayTrackingEventId(nextEventId)
      try {
        await refetch()
        if (autoScroll()) {
          setScrollTrigger((value) => value + 1)
        }
      } catch {
        // feed errors surface elsewhere
      }
      if (!nextEventId) {
        setRelayState('success')
        setSending(false)
        setPollInterval(POLL_INTERVAL_MS)
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Failed to send message'
      setRelayState('error')
      setRelayError(detail)
      setSending(false)
      setPollInterval(POLL_INTERVAL_MS)
    }
  }

  const dismissRelayError = () => {
    setRelayError(null)
    if (relayState() === 'error') {
      setRelayState('idle')
    }
  }

  const refreshRawStream = async () => {
    const workspaceId = normalizedWorkspaceId()
    if (!workspaceId) {
      setRawStreamError('Workspace id is required')
      return
    }
    setRawStreamLoading(true)
    setRawStreamError(null)
    try {
      const payload = await fetchNarratorRawLog({ workspaceId })
      setRawStream(payload)
    } catch (error) {
      setRawStreamError(error instanceof Error ? error.message : 'Failed to load raw log')
    } finally {
      setRawStreamLoading(false)
    }
  }

  const toggleRawStream = async () => {
    const next = !rawStreamOpen()
    setRawStreamOpen(next)
    if (next && !rawStream() && !rawStreamLoading()) {
      await refreshRawStream()
    }
  }

  const resumeAutoScroll = () => {
    setScrollTrigger((value) => value + 1)
    setAutoScroll(true)
  }

  return (
    <div class="flex h-full flex-col gap-4">
      <header class="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <div>
          <Show
            when={!feed.loading}
            fallback={<p class="text-lg font-semibold text-[var(--text)]">Loading narrator feed…</p>}
          >
            <p class="text-lg font-semibold text-[var(--text)]">Narrator activity for {props.workspaceName}</p>
          </Show>
          <p class="text-sm text-[var(--text-muted)]">Observe Streaming LLM narration without exposing raw agent output.</p>
          <Show when={summaryRef()}>{(ref) => <p class="text-xs text-[var(--text-muted)]">Latest summary: {ref()}</p>}</Show>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="rounded-xl border border-[var(--border)] px-3 py-1 text-sm"
            onClick={() => void refetch()}
            disabled={feed.loading}
          >
            {feed.loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <a
            href={rawLogsUrl()}
            target="_blank"
            rel="noreferrer"
            class="rounded-xl bg-[var(--text)] px-3 py-1 text-sm font-semibold text-[var(--bg)]"
          >
            Download raw logs
          </a>
        </div>
      </header>

      <Show when={formatErrorMessage()}>{(message) => <p class="text-sm text-red-500">{message()}</p>}</Show>

      <section class="flex-1 min-h-0 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
          <span>Conversation thread</span>
          <span>{conversationLabel()}</span>
        </header>
        <div class="flex-1 min-h-[260px] overflow-hidden">
          <div class="relative flex h-full min-h-[260px] flex-col">
            <MessageScroller
              messages={timelineMessages()}
              class="flex-1 min-h-0 space-y-3 overflow-y-auto pr-1"
              sessionId={feed()?.conversationId ?? null}
              onAutoScrollChange={setAutoScroll}
              scrollToBottomTrigger={scrollTrigger()}
            />
            <Show when={!hasMessages()}>
              <div class="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-[var(--text-muted)]">
                No narrator messages yet.
              </div>
            </Show>
            <Show when={!autoScroll() && hasMessages()}>
              <button
                type="button"
                class="absolute right-3 bottom-3 flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg"
                onClick={resumeAutoScroll}
                title="Scroll to newest narrator event"
              >
                ↓
              </button>
            </Show>
          </div>
        </div>
        <Show when={hasMessages()}>
          <p class="mt-3 text-xs text-[var(--text-muted)]">{messageCount()} events captured for this workspace.</p>
        </Show>
      </section>

      <form class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4" onSubmit={handleSend}>
        <label class="text-sm font-semibold text-[var(--text)]" for="narrator-message-input">
          Send a message to this workspace
        </label>
        <p class="text-xs text-[var(--text-muted)]">Share quick updates or instructions; they will stream into the narrator log.</p>
        <textarea
          id="narrator-message-input"
          class="mt-3 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)]"
          rows={3}
          placeholder="Message narrator"
          value={messageInput()}
          onInput={(event) => setMessageInput(event.currentTarget.value)}
          disabled={sending()}
        ></textarea>
        <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
          <Show when={composerError()}>{(error) => <p class="text-xs text-red-500">{error()}</p>}</Show>
          <button
            type="submit"
            class="ml-auto rounded-xl bg-[var(--text)] px-4 py-2 text-sm font-semibold text-[var(--bg)] disabled:opacity-60"
            disabled={sending() || !messageInput().trim()}
          >
            {sending() ? 'Sending…' : 'Send message'}
          </button>
        </div>
        <Show when={relayState() === 'pending'}>
          <p class="mt-2 text-xs text-[var(--text-muted)]">Waiting for narrator relay to respond…</p>
        </Show>
        <Show when={relayState() === 'success'}>
          <p class="mt-2 text-xs text-green-600">Narrator reply received.</p>
        </Show>
        <Show when={relayError()}>
          {(message) => (
            <div class="mt-3 rounded-xl border border-red-500/60 bg-red-50/80 p-3 text-sm text-red-700">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <p class="font-semibold">Narrator relay failed</p>
                  <p class="text-xs text-red-600">{message()}</p>
                </div>
                <button
                  type="button"
                  class="text-xs font-semibold text-red-700 underline"
                  onClick={() => dismissRelayError()}
                >
                  Dismiss
                </button>
              </div>
              <a
                href={rawLogsUrl()}
                target="_blank"
                rel="noreferrer"
                class="mt-2 inline-flex text-xs font-semibold text-red-700 underline"
              >
                Download raw log
              </a>
            </div>
          )}
        </Show>
      </form>

      <section class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <button
          type="button"
          class="flex w-full items-center justify-between gap-3 text-left text-sm font-semibold text-[var(--text)]"
          onClick={() => void toggleRawStream()}
          aria-expanded={rawStreamOpen() ? 'true' : 'false'}
        >
          <span>Raw narrator stream</span>
          <span class="text-xs text-[var(--text-muted)]">{rawStreamOpen() ? 'Hide' : 'Show'}</span>
        </button>
        <Show when={rawStreamOpen()}>
          <div class="mt-3 space-y-3 text-sm text-[var(--text)]">
            <p class="text-xs text-[var(--text-muted)]">
              Direct JSONL output from the Streaming LLM sidecar. Use this when you need to audit every narrator event.
            </p>
            <div class="flex flex-wrap items-center gap-2">
              <button
                type="button"
                class="rounded-xl border border-[var(--border)] px-3 py-1 text-xs"
                onClick={() => void refreshRawStream()}
                disabled={rawStreamLoading()}
              >
                {rawStreamLoading() ? 'Refreshing…' : 'Refresh log'}
              </button>
              <a
                href={rawLogsUrl()}
                target="_blank"
                rel="noreferrer"
                class="rounded-xl border border-[var(--border)] px-3 py-1 text-xs"
              >
                Download JSONL
              </a>
            </div>
            <Show when={rawStreamError()}>
              {(error) => <p class="text-xs text-red-500">{error()}</p>}
            </Show>
            <div class="rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-3 text-xs text-[var(--text)]">
              <Show
                when={!rawStreamLoading() ? rawStream() : null}
                fallback={<p class="text-[var(--text-muted)]">{rawStreamLoading() ? 'Loading raw log…' : 'No log entries yet.'}</p>}
              >
                {(log) => (
                  <pre class="max-h-64 overflow-y-auto whitespace-pre-wrap text-[var(--text)]">{log()}</pre>
                )}
              </Show>
            </div>
          </div>
        </Show>
      </section>
    </div>
  )
}

function formatRole(event: WorkspaceNarratorEvent): string {
  const source = SOURCE_LABELS[event.source] ?? 'System'
  const type = TYPE_LABELS[event.type] ?? event.type
  return `${source} • ${type}`
}

function formatEventBody(event: WorkspaceNarratorEvent): string {
  const icon = SEVERITY_ICONS[event.severity] ?? '•'
  const detail = event.detail ? `\n${event.detail}` : ''
  return `${icon} ${event.headline}${detail}`
}

function buildMessageParts(event: WorkspaceNarratorEvent): CodingAgentMessagePart[] {
  const parts: CodingAgentMessagePart[] = [
    {
      id: `${event.id}-headline`,
      type: 'text',
      text: event.headline
    }
  ]
  if (event.detail) {
    parts.push({ id: `${event.id}-detail`, type: 'text', text: event.detail })
  }
  return parts
}

export default WorkspaceNarratorWidget
