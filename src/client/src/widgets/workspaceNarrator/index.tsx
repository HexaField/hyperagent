import { Show, createEffect, createMemo, createResource, createSignal, onCleanup } from 'solid-js'
import type { WorkspaceNarratorEvent } from '../../../../interfaces/widgets/workspaceNarrator'
import ConversationPane from '../../components/ConversationPane'
import { createConversationScrollController } from '../../components/conversationScrollController'
import type { CodingAgentMessage, CodingAgentMessagePart } from '../../lib/codingAgent'
import { fetchNarratorFeed, fetchNarratorRawLog, postNarratorMessage } from '../../lib/narratorFeed'

const POLL_INTERVAL_MS = 5000
const FAST_POLL_INTERVAL_MS = 1000
const DEFAULT_LIMIT = 50
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
  const [showRawLog, setShowRawLog] = createSignal(false)
  const [rawLog, setRawLog] = createSignal<string | null>(null)
  const [rawLogError, setRawLogError] = createSignal<string | null>(null)
  const [rawLogLoading, setRawLogLoading] = createSignal(false)
  const scrollController = createConversationScrollController()

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
    const events = (feed()?.events ?? []).filter((event) => event.source === 'narrator' || event.source === 'user')
    const ordered = [...events].reverse()
    return ordered.map((event) => ({
      id: event.id,
      role: event.source === 'user' ? 'You' : 'Narrator',
      createdAt: event.timestamp,
      completedAt: event.timestamp,
      modelId: null,
      providerId: null,
      text: formatEventBody(event),
      parts: buildMessageParts(event)
    }))
  })

  const rawLogsUrl = createMemo(() => {
    const id = normalizedWorkspaceId()
    return id ? `/api/workspaces/${encodeURIComponent(id)}/narrator/raw` : '#'
  })

  const conversationLabel = createMemo(() => {
    const id = (feed()?.conversationId ?? '').trim()
    return id.length ? `Conversation ${id}` : 'Conversation pending'
  })

  createEffect(() => {
    const workspaceKey = normalizedWorkspaceId()
    const contextKey = feed()?.conversationId ?? (workspaceKey || '__narrator__')
    scrollController.setContext(contextKey)
  })

  createEffect(() => {
    const messages = timelineMessages()
    const last = messages.length > 0 ? messages[messages.length - 1] : null
    const key = last ? (last.id ?? last.createdAt ?? messages.length) : null
    scrollController.notifyLatestKey(key)
  })

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
        scrollController.requestScrollIfAuto()
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

  const ensureRawLogLoaded = async () => {
    if (rawLog() || rawLogLoading()) return
    const workspaceId = normalizedWorkspaceId()
    if (!workspaceId) return
    setRawLogLoading(true)
    setRawLogError(null)
    try {
      const content = await fetchNarratorRawLog({ workspaceId })
      setRawLog(content)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load raw narrator stream'
      setRawLogError(message)
    } finally {
      setRawLogLoading(false)
    }
  }

  const toggleRawLog = () => {
    const next = !showRawLog()
    setShowRawLog(next)
    if (next) {
      void ensureRawLogLoaded()
    }
  }

  const composerForm = (
    <form class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4" onSubmit={handleSend}>
      <label class="text-sm font-semibold text-[var(--text)]" for="narrator-message-input">
        Send a message to this workspace
      </label>
      <p class="text-xs text-[var(--text-muted)]">
        Share quick updates or instructions; they will stream into the narrator log.
      </p>
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
              Download raw logs
            </a>
          </div>
        )}
      </Show>
    </form>
  )

  return (
    <div class="flex h-full flex-col gap-4">
      <header class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <p class="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Conversation thread</p>
        <div class="mt-1 flex flex-wrap items-baseline gap-3">
          <h2 class="text-lg font-semibold text-[var(--text)]">Narrator activity for {props.workspaceName}</h2>
          <span class="text-sm text-[var(--text-muted)]">{conversationLabel()}</span>
        </div>
        <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p class="text-xs text-[var(--text-muted)]">Events captured for this workspace</p>
          <button
            type="button"
            class="text-xs font-semibold text-[var(--text)] underline"
            aria-expanded={showRawLog() ? 'true' : 'false'}
            onClick={toggleRawLog}
          >
            Raw narrator stream
          </button>
        </div>
      </header>

      <Show when={formatErrorMessage()}>{(message) => <p class="text-sm text-red-500">{message()}</p>}</Show>

      <Show when={showRawLog()}>
        <section class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
          <h3 class="text-sm font-semibold text-[var(--text)]">Raw narrator stream</h3>
          <Show when={rawLogError()}>{(message) => <p class="mt-2 text-xs text-red-500">{message()}</p>}</Show>
          <Show when={rawLogLoading()}>
            <p class="mt-2 text-xs text-[var(--text-muted)]">Loading raw narrator stream…</p>
          </Show>
          <Show when={rawLog()}>
            {(content) => (
              <pre class="mt-3 max-h-52 overflow-y-auto rounded-xl bg-[var(--bg-muted)] p-3 text-xs text-[var(--text)]">
                {content()}
              </pre>
            )}
          </Show>
          <a
            href={rawLogsUrl()}
            target="_blank"
            rel="noreferrer"
            class="mt-3 inline-flex text-xs font-semibold text-[var(--text)] underline"
          >
            Download raw logs
          </a>
        </section>
      </Show>

      <section class="flex flex-1 min-h-0 flex-col rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <div class="flex-1 min-h-0">
          <ConversationPane
            messages={timelineMessages()}
            sessionId={feed()?.conversationId ?? null}
            emptyPlaceholder="No narrator messages yet."
            footer={composerForm}
            class="relative flex h-full min-h-0 flex-col"
            scrollerClass="space-y-3 overflow-y-auto pr-1"
            scrollButtonClass="right-3 bottom-3"
            scrollToLatestSignal={scrollController.scrollSignal()}
            onAutoScrollChange={scrollController.handleAutoScrollChange}
          />
        </div>
      </section>
    </div>
  )
}

function formatEventBody(event: WorkspaceNarratorEvent): string {
  const icon = SEVERITY_ICONS[event.severity] ?? '•'
  const typeLabel = TYPE_LABELS[event.type] ?? event.type
  const detail = event.detail ? `\n${event.detail}` : ''
  return `${icon} ${typeLabel}: ${event.headline}${detail}`
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
