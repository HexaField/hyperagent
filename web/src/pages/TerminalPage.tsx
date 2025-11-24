import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import {
  closeTerminalSession,
  createTerminalSession,
  createTerminalWebSocket,
  listTerminalSessions,
  type TerminalSession
} from '../lib/terminal'

const TerminalPage = () => {
  const [sessions, setSessions] = createSignal<TerminalSession[]>([])
  const [activeSessionId, setActiveSessionId] = createSignal<string | null>(null)
  const [statusMessage, setStatusMessage] = createSignal('Select or start a session to begin.')
  const [cwdInput, setCwdInput] = createSignal('')
  const [shellInput, setShellInput] = createSignal('')
  const [isCreatingSession, setIsCreatingSession] = createSignal(false)
  const [connectionState, setConnectionState] = createSignal<'idle' | 'connecting' | 'open' | 'closed' | 'error'>(
    'idle'
  )

  let terminalContainer: HTMLDivElement | undefined
  let term: Terminal | null = null
  let fitAddon: FitAddon | null = null
  let socket: WebSocket | null = null
  let detachResizeListener: (() => void) | null = null
  let inputSubscription: { dispose: () => void } | null = null

  const activeSession = createMemo(() => sessions().find((session) => session.id === activeSessionId()) ?? null)

  const refreshSessions = async () => {
    try {
      const list = await listTerminalSessions()
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      setSessions(list)
      const currentSelection = activeSessionId()
      if (!currentSelection) {
        const preferred = list.find((session) => session.status === 'active') ?? list[0]
        if (preferred) {
          connectToSession(preferred.id)
          return
        }
      } else if (!list.some((session) => session.id === currentSelection)) {
        setActiveSessionId(null)
        term?.reset()
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Unable to load terminal sessions')
    }
  }

  const sendResizeUpdate = () => {
    if (!term || socket?.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
  }

  const scheduleFit = () => {
    if (!fitAddon || !term) return
    requestAnimationFrame(() => {
      if (!fitAddon || !term) return
      fitAddon.fit()
      sendResizeUpdate()
    })
  }

  const ensureTerminal = () => {
    if (term || !terminalContainer) return
    term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
      fontSize: 14,
      theme: {
        background: '#020617',
        foreground: '#e2e8f0',
        cursor: '#38bdf8'
      }
    })
    fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(terminalContainer)
    fitAddon.fit()
    inputSubscription = term.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', data }))
      }
    })
    if (typeof window !== 'undefined') {
      const handleResize = () => scheduleFit()
      window.addEventListener('resize', handleResize)
      detachResizeListener = () => {
        window.removeEventListener('resize', handleResize)
        detachResizeListener = null
      }
    }
    scheduleFit()
  }

  const attachSocketHandlers = (sessionId: string) => {
    socket?.close()
    socket = createTerminalWebSocket(sessionId)
    setConnectionState('connecting')
    setStatusMessage('Connecting to terminal…')

    socket.addEventListener('open', () => {
      setConnectionState('open')
      setStatusMessage('Connected.')
      sendResizeUpdate()
    })

    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(typeof event.data === 'string' ? event.data : '')
        if (payload.type === 'output' && typeof payload.data === 'string') {
          term?.write(payload.data)
        } else if (payload.type === 'error' && typeof payload.message === 'string') {
          setStatusMessage(payload.message)
          setConnectionState('error')
        } else if (payload.type === 'exit') {
          const exitMessage = `Session exited (code ${payload.exitCode ?? '0'})`
          setStatusMessage(exitMessage)
          setConnectionState('closed')
        }
      } catch {
        // ignore malformed frames
      }
    })

    socket.addEventListener('close', () => {
      if (connectionState() !== 'error') {
        setConnectionState('closed')
        setStatusMessage('Terminal disconnected.')
      }
    })

    socket.addEventListener('error', () => {
      setConnectionState('error')
      setStatusMessage('Terminal connection error')
    })
  }

  const connectToSession = (sessionId: string) => {
    ensureTerminal()
    if (!sessionId) return
    if (activeSessionId() !== sessionId) {
      term?.reset()
    }
    setActiveSessionId(sessionId)
    attachSocketHandlers(sessionId)
  }

  const handleStartSession = async (event: Event) => {
    event.preventDefault()
    setIsCreatingSession(true)
    try {
      const session = await createTerminalSession({
        cwd: sanitizeInput(cwdInput()),
        shell: sanitizeInput(shellInput())
      })
      setSessions((current) => [session, ...current.filter((entry) => entry.id !== session.id)])
      connectToSession(session.id)
      setStatusMessage('Launching terminal session…')
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Failed to start terminal session')
    } finally {
      setIsCreatingSession(false)
    }
  }

  const handleCloseSession = async () => {
    const sessionId = activeSessionId()
    if (!sessionId) return
    try {
      await closeTerminalSession(sessionId)
      setSessions((current) =>
        current.map((session) =>
          session.id === sessionId ? { ...session, status: 'closed', closedAt: new Date().toISOString() } : session
        )
      )
      socket?.close()
      setStatusMessage('Session closed.')
      void refreshSessions()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Failed to close session')
    }
  }

  onMount(() => {
    ensureTerminal()
    void refreshSessions()
  })

  onCleanup(() => {
    socket?.close()
    detachResizeListener?.()
    inputSubscription?.dispose()
    term?.dispose()
  })

  const sessionLabel = (session: TerminalSession) => {
    const created = new Date(session.createdAt)
    return `${session.shellCommand} • ${created.toLocaleTimeString()}`
  }

  return (
    <section class="flex flex-col gap-6">
      <header class="space-y-2">
        <p class="text-xs uppercase tracking-[0.3em] text-[var(--text-muted)]">Terminal</p>
        <h2 class="text-2xl font-semibold text-[var(--text)]">Remote shell</h2>
        <p class="text-[var(--text-muted)]">
          Start a secure terminal session on this host and stream it through your browser.
        </p>
      </header>

      <form
        class="flex flex-wrap items-end gap-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] px-4 py-4"
        onSubmit={handleStartSession}
      >
        <label class="flex flex-1 min-w-[200px] flex-col text-sm">
          <span class="text-[var(--text-muted)]">Working directory</span>
          <input
            class="mt-1 rounded-xl border border-[var(--border)] bg-transparent px-3 py-2"
            type="text"
            value={cwdInput()}
            onInput={(event) => setCwdInput(event.currentTarget.value)}
          />
        </label>
        <label class="flex flex-1 min-w-[180px] flex-col text-sm">
          <span class="text-[var(--text-muted)]">Shell</span>
          <input
            class="mt-1 rounded-xl border border-[var(--border)] bg-transparent px-3 py-2"
            type="text"
            placeholder="/bin/zsh"
            value={shellInput()}
            onInput={(event) => setShellInput(event.currentTarget.value)}
          />
        </label>
        <button
          class="rounded-xl bg-blue-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
          type="submit"
          disabled={isCreatingSession()}
        >
          {isCreatingSession() ? 'Starting…' : 'Start session'}
        </button>
      </form>

      <div class="grid gap-4 lg:grid-cols-[260px_1fr]">
        <aside class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
          <div class="flex items-center justify-between text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">
            <span>Sessions</span>
            <button
              class="text-[0.7rem] text-blue-500 disabled:opacity-40"
              type="button"
              onClick={() => void refreshSessions()}
            >
              Refresh
            </button>
          </div>
          <div class="mt-3 flex max-h-[400px] flex-col gap-2 overflow-y-auto">
            <Show when={sessions().length} fallback={<p class="text-sm text-[var(--text-muted)]">No sessions yet.</p>}>
              <For each={sessions()}>
                {(session) => (
                  <button
                    type="button"
                    onClick={() => connectToSession(session.id)}
                    classList={{
                      'w-full rounded-xl border px-3 py-2 text-left text-sm transition': true,
                      'border-blue-500 bg-blue-500/10 text-blue-200': session.id === activeSessionId(),
                      'border-[var(--border)] text-[var(--text-muted)]': session.id !== activeSessionId()
                    }}
                  >
                    <p class="font-semibold text-[var(--text)]">{sessionLabel(session)}</p>
                    <p class="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">{session.status}</p>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </aside>

        <div class="flex flex-col gap-3">
          <div class="flex flex-wrap items-center justify-between gap-3 text-sm">
            <p class="text-[var(--text-muted)]">{statusMessage()}</p>
            <div class="flex items-center gap-2">
              <span class="rounded-full px-3 py-1 text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">
                {connectionState()}
              </span>
              <button
                class="rounded-xl border border-[var(--border)] px-3 py-1 text-sm text-[var(--text)] disabled:opacity-50"
                type="button"
                disabled={!activeSession() || activeSession()?.status !== 'active'}
                onClick={() => void handleCloseSession()}
              >
                Close session
              </button>
            </div>
          </div>
          <div
            ref={(node) => {
              terminalContainer = node ?? undefined
              ensureTerminal()
            }}
            class="min-h-[420px] rounded-2xl border border-[var(--border)] bg-[#020617] p-3"
          />
        </div>
      </div>
    </section>
  )
}

function sanitizeInput(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed.length ? trimmed : undefined
}

export default TerminalPage
