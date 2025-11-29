import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import {
  closeTerminalSession,
  createTerminalSession,
  createTerminalWebSocket,
  listTerminalSessions,
  type TerminalSession
} from '../../shared/api/terminal'
import { formatTimestamp } from '../../shared/utils/datetime'

export type WorkspaceTerminalWidgetProps = {
  workspaceId: string
  workspacePath: string
}

export function WorkspaceTerminalWidget(props: WorkspaceTerminalWidgetProps) {
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

  createEffect(() => {
    if (!cwdInput() && props.workspacePath) {
      setCwdInput(props.workspacePath)
    }
  })

  const activeSession = createMemo(() => sessions().find((session) => session.id === activeSessionId()) ?? null)

  const refreshSessions = async () => {
    try {
      const list = await listTerminalSessions(props.workspaceId)
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
      if (!list.length) {
        setActiveSessionId(null)
        term?.reset()
        setStatusMessage('Start a session to connect.')
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
        /* ignore malformed frames */
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
        shell: sanitizeInput(shellInput()),
        projectId: props.workspaceId
      })
      setShellInput('')
      if (session) {
        await refreshSessions()
        connectToSession(session.id)
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Failed to start terminal session')
    } finally {
      setIsCreatingSession(false)
    }
  }

  const handleCloseSession = async () => {
    const id = activeSessionId()
    if (!id) return
    try {
      await closeTerminalSession(id)
      setStatusMessage('Session closed')
      await refreshSessions()
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Failed to close session')
    }
  }

  createEffect(() => {
    props.workspaceId
    void refreshSessions()
  })

  onCleanup(() => {
    socket?.close()
    socket = null
    detachResizeListener?.()
    inputSubscription?.dispose()
    term?.dispose()
    term = null
    fitAddon?.dispose()
    fitAddon = null
  })

  return (
    <div class="flex h-full flex-col gap-4 p-6 text-[var(--text)]">
      <section class="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div class="flex h-full flex-col gap-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 text-sm">
          <div class="flex items-center justify-between gap-3">
            <p class="text-sm font-semibold text-[var(--text)]">Sessions for {props.workspacePath}</p>
            <button
              class="rounded-xl border border-[var(--border)] px-3 py-1 text-xs"
              type="button"
              onClick={() => void refreshSessions()}
            >
              Refresh
            </button>
          </div>
          <p class="text-xs text-[var(--text-muted)]">Select a session to attach the terminal.</p>
          <div class="flex-1 space-y-2 overflow-auto pr-1">
            <For each={sessions()}>
              {(session) => (
                <button
                  class="w-full rounded-2xl border px-3 py-2 text-left"
                  classList={{
                    'border-blue-500 bg-blue-950/30': activeSessionId() === session.id,
                    'border-[var(--border)] bg-[var(--bg-muted)]': activeSessionId() !== session.id
                  }}
                  type="button"
                  onClick={() => connectToSession(session.id)}
                >
                  <div class="flex items-center justify-between text-sm">
                    <span class="font-semibold">{session.id.slice(0, 8)}</span>
                    <span class="text-xs text-[var(--text-muted)]">{session.status}</span>
                  </div>
                  <p class="text-xs text-[var(--text-muted)]">{session.shellCommand || 'Default shell'}</p>
                  <p class="text-xs text-[var(--text-muted)]">{session.initialCwd || 'Inherited directory'}</p>
                  <p class="text-xs text-[var(--text-muted)]">Started {formatTimestamp(session.createdAt)}</p>
                </button>
              )}
            </For>
            <Show when={!sessions().length}>
              <p class="text-sm text-[var(--text-muted)]">No sessions yet.</p>
            </Show>
          </div>
          <form
            class="space-y-3 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--bg-muted)] p-3"
            onSubmit={handleStartSession}
          >
            <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">New session</p>
            <label class="text-xs font-semibold text-[var(--text-muted)]" for="workspace-terminal-cwd">
              Working directory
            </label>
            <input
              id="workspace-terminal-cwd"
              class="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-2"
              type="text"
              value={cwdInput()}
              onInput={(event) => setCwdInput(event.currentTarget.value)}
            />
            <label class="text-xs font-semibold text-[var(--text-muted)]" for="workspace-terminal-shell">
              Shell (optional)
            </label>
            <input
              id="workspace-terminal-shell"
              class="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-2"
              type="text"
              value={shellInput()}
              onInput={(event) => setShellInput(event.currentTarget.value)}
              placeholder="/bin/zsh"
            />
            <button
              class="w-full rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              type="submit"
              disabled={isCreatingSession()}
            >
              {isCreatingSession() ? 'Starting…' : 'Start session'}
            </button>
          </form>
        </div>
        <div class="flex h-full flex-col rounded-2xl border border-[var(--border)] bg-[var(--bg-card)]">
          <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-muted)] px-4 py-3">
            <div>
              <p class="text-sm font-semibold">
                {activeSession() ? `Attached to ${activeSession()!.id.slice(0, 8)}` : 'Select a session to attach'}
              </p>
              <p class="text-xs text-[var(--text-muted)]">{statusMessage()}</p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <button
                class="rounded-xl border border-[var(--border)] px-3 py-1 text-xs"
                type="button"
                onClick={() => void refreshSessions()}
              >
                Refresh
              </button>
              <button
                class="rounded-xl border border-[var(--border)] px-3 py-1 text-xs disabled:opacity-60"
                type="button"
                disabled={!activeSession()}
                onClick={() => void handleCloseSession()}
              >
                Close session
              </button>
            </div>
          </div>
          <div class="flex-1">
            <div
              ref={(node) => {
                terminalContainer = node ?? undefined
                ensureTerminal()
              }}
              class="h-full min-h-[360px] rounded-b-2xl bg-[#020617]"
            />
          </div>
          <div class="border-t border-[var(--border)] px-4 py-2 text-xs text-[var(--text-muted)]">
            Connection: {connectionState()}
          </div>
        </div>
      </section>
    </div>
  )
}

function sanitizeInput(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed.length ? trimmed : undefined
}

export default WorkspaceTerminalWidget
