import { useSearchParams } from '@solidjs/router'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  type JSX
} from 'solid-js'
import WorkflowDetailView from '../components/WorkflowDetailView'
import WorkflowLaunchModal from '../components/WorkflowLaunchModal'
import CanvasWorkspace, { type CanvasWidgetConfig } from '../components/layout/CanvasWorkspace'
import OpencodeConsole from '../components/OpencodeConsole'
import { useCanvasNavigator } from '../contexts/CanvasNavigatorContext'
import { useWorkspaceSelection, type WorkspaceRecord } from '../contexts/WorkspaceSelectionContext'
import { fetchJson } from '../lib/http'
import {
  closeTerminalSession,
  createTerminalSession,
  createTerminalWebSocket,
  listTerminalSessions,
  type TerminalSession
} from '../lib/terminal'

export type WorkflowRecord = {
  id: string
  projectId: string
  kind: string
  status: string
  createdAt: string
  updatedAt: string
}

export type WorkflowStep = {
  id: string
  workflowId: string
  status: string
  sequence: number
  data: Record<string, unknown>
  result: Record<string, unknown> | null
  runnerInstanceId: string | null
}

export type WorkflowSummary = {
  workflow: WorkflowRecord
  steps: WorkflowStep[]
}

const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed'
}

export default function WorkspacePage() {
  const selection = useWorkspaceSelection()
  const navigator = useCanvasNavigator()
  const activeWorkspace = selection.currentWorkspace

  const widgets = createMemo<CanvasWidgetConfig[]>(() => {
    const workspace = activeWorkspace()
    if (!workspace) return []
    return [
      {
        id: 'workspace-summary',
        title: 'Workspace overview',
        description: 'Repository details and quick actions',
        icon: '🧭',
        initialPosition: { x: -300, y: -140 },
        initialSize: { width: 480, height: 400 },
        startOpen: true,
        content: () => <WorkspaceSummary workspace={workspace} onOpenNavigator={navigator.open} />
      },
      {
        id: 'workspace-workflows',
        title: 'Workflows',
        description: 'Run history and queue',
        icon: '🧩',
        initialPosition: { x: 280, y: -100 },
        initialSize: { width: 920, height: 760 },
        startOpen: true,
        content: () => <WorkflowsWidget workspaceId={workspace.id} workspaceName={workspace.name} />
      },
      {
        id: 'workspace-terminal',
        title: 'Terminal',
        description: 'Shell access scoped to this workspace',
        icon: '🖥️',
        initialPosition: { x: -320, y: 420 },
        initialSize: { width: 720, height: 520 },
        startOpen: true,
        content: () => <WorkspaceTerminalWidget workspacePath={workspace.repositoryPath} />
      },
      {
        id: 'workspace-sessions',
        title: 'Opencode sessions',
        description: 'Background activity feed',
        icon: '🕘',
        initialPosition: { x: 460, y: 520 },
        initialSize: { width: 720, height: 520 },
        startOpen: true,
        content: () => <SessionsWidget workspacePath={workspace.repositoryPath} />
      }
    ]
  })

  return (
    <div class="relative h-full min-h-screen w-full">
      <Show when={!selection.isLoading()} fallback={<WorkspaceLoadingState />}>
        <Show when={activeWorkspace()} fallback={<WorkspaceEmptyState onOpenNavigator={navigator.open} />}>
          {(workspace) => (
            <CanvasWorkspace storageKey={`workspace:${workspace().id}`} widgets={widgets()} />
          )}
        </Show>
      </Show>
    </div>
  )
}

function WorkspaceLoadingState() {
  return (
    <div class="flex h-full items-center justify-center text-[var(--text-muted)]">
      <p>Loading workspaces…</p>
    </div>
  )
}

function WorkspaceEmptyState(props: { onOpenNavigator: () => void }) {
  return (
    <div class="flex h-full flex-col items-center justify-center gap-4 text-center text-[var(--text)]">
      <p class="text-sm uppercase tracking-[0.35em] text-[var(--text-muted)]">No workspaces yet</p>
      <h1 class="text-3xl font-semibold">Create your first workspace</h1>
      <p class="max-w-lg text-[var(--text-muted)]">
        Use the canvas navigator drawer to register a repository. Once a workspace exists, it becomes the center of every
        workflow, terminal session, and opencode transcript.
      </p>
      <button class="rounded-2xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white" type="button" onClick={props.onOpenNavigator}>
        Open navigator
      </button>
    </div>
  )
}

function WorkspaceSummary(props: { workspace: WorkspaceRecord; onOpenNavigator: () => void }) {
  const workspace = () => props.workspace
  return (
    <div class="flex h-full flex-col gap-4 p-6 text-[var(--text)]">
      <div>
        <p class="text-xs uppercase tracking-[0.35em] text-[var(--text-muted)]">Workspace</p>
        <h2 class="mt-2 text-3xl font-semibold">{workspace().name}</h2>
        <p class="text-sm text-[var(--text-muted)]">{workspace().description ?? 'No description yet.'}</p>
      </div>
      <div class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 text-sm">
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">Repository path</p>
        <code class="mt-2 block overflow-hidden text-ellipsis whitespace-nowrap rounded-xl bg-[var(--bg-muted)] px-3 py-2">
          {workspace().repositoryPath}
        </code>
        <div class="mt-3 grid gap-3 text-xs text-[var(--text-muted)]">
          <span>Default branch: {workspace().defaultBranch}</span>
          <span>Created: {new Date(workspace().createdAt).toLocaleString()}</span>
        </div>
      </div>
      <div class="mt-auto flex flex-wrap gap-3">
        <button class="rounded-2xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white" type="button" onClick={props.onOpenNavigator}>
          Manage workspaces
        </button>
      </div>
    </div>
  )
}

function WorkflowsWidget(props: { workspaceId: string; workspaceName: string }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [focusedWorkflowId, setFocusedWorkflowId] = createSignal<string | null>(
    typeof searchParams.sessionId === 'string' && searchParams.sessionId.length ? searchParams.sessionId : null
  )
  const [launchOpen, setLaunchOpen] = createSignal(false)
  onMount(() => {
    const handleLaunchRequest = () => setLaunchOpen(true)
    window.addEventListener('workspace:launch-workflow', handleLaunchRequest)
    onCleanup(() => window.removeEventListener('workspace:launch-workflow', handleLaunchRequest))
  })

  const [workflows, { refetch }] = createResource(
    () => props.workspaceId,
    async (workspaceId) => {
      if (!workspaceId) return [] as WorkflowSummary[]
      const payload = await fetchJson<{ workflows: WorkflowSummary[] }>('/api/workflows')
      return payload.workflows.filter((summary) => summary.workflow.projectId === workspaceId)
    }
  )

  createEffect(() => {
    const linkParam = typeof searchParams.sessionId === 'string' && searchParams.sessionId.length ? searchParams.sessionId : null
    if (linkParam) {
      setFocusedWorkflowId(linkParam)
    }
  })

  const statusCounts = createMemo(() => {
    const list = workflows() ?? []
    return list.reduce<Record<string, number>>((counts, summary) => {
      const status = summary.workflow.status
      counts[status] = (counts[status] ?? 0) + 1
      return counts
    }, {})
  })

  const sortedWorkflows = createMemo(() => {
    const list = workflows() ?? []
    return [...list].sort((a, b) => b.workflow.updatedAt.localeCompare(a.workflow.updatedAt))
  })

  const focusWorkflow = (id: string) => {
    setFocusedWorkflowId(id)
    setSearchParams({ sessionId: id })
  }

  const closeDetail = () => {
    setFocusedWorkflowId(null)
    setSearchParams({ sessionId: undefined })
  }

  return (
    <div class="flex h-full flex-col gap-4 p-6 text-[var(--text)]">
      <header class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p class="text-xs uppercase tracking-[0.35em] text-[var(--text-muted)]">Workflows</p>
          <h2 class="text-3xl font-semibold">Runs for {props.workspaceName}</h2>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button class="rounded-2xl border border-[var(--border)] px-4 py-2 text-sm" type="button" onClick={() => refetch()}>
            Refresh
          </button>
          <button class="rounded-2xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white" type="button" onClick={() => setLaunchOpen(true)}>
            Launch workflow
          </button>
        </div>
      </header>
      <section class="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 text-sm">
          <p class="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">Status breakdown</p>
          <ul class="space-y-2">
            <For each={Object.entries(statusCounts())}>
              {([status, count]) => (
                <li class="flex items-center justify-between">
                  <span>{STATUS_LABELS[status] ?? status}</span>
                  <span class="text-[var(--text-muted)]">{count}</span>
                </li>
              )}
            </For>
            <Show when={!Object.keys(statusCounts()).length}>
              <li class="text-[var(--text-muted)]">No runs yet.</li>
            </Show>
          </ul>
        </div>
        <div class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
          <p class="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">Recent runs</p>
          <div class="space-y-2">
            <For each={sortedWorkflows()}>
              {(summary) => (
                <button
                  class="flex w-full flex-col rounded-2xl border border-transparent px-3 py-2 text-left hover:border-[var(--border)]"
                  type="button"
                  onClick={() => focusWorkflow(summary.workflow.id)}
                >
                  <div class="flex items-center justify-between text-sm">
                    <span class="font-semibold">{summary.workflow.kind}</span>
                    <span class="text-xs text-[var(--text-muted)]">{new Date(summary.workflow.updatedAt).toLocaleString()}</span>
                  </div>
                  <p class="text-xs text-[var(--text-muted)]">{STATUS_LABELS[summary.workflow.status] ?? summary.workflow.status}</p>
                </button>
              )}
            </For>
            <Show when={!sortedWorkflows().length}>
              <p class="text-sm text-[var(--text-muted)]">No workflows have run for this workspace yet.</p>
            </Show>
          </div>
        </div>
      </section>
      <Show when={focusedWorkflowId()}>
        {(workflowId) => (
          <div class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
            <div class="mb-3 flex items-center justify-between">
              <h3 class="text-lg font-semibold">Workflow detail</h3>
              <button class="text-sm text-blue-500" type="button" onClick={closeDetail}>
                Close
              </button>
            </div>
            <WorkflowDetailView workflowId={workflowId()} />
          </div>
        )}
      </Show>
      <Show when={launchOpen()}>
        <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onClick={() => setLaunchOpen(false)}>
          <div class="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-3xl border border-[var(--border)] bg-[var(--bg-card)] p-6" onClick={(event) => event.stopPropagation()}>
            <WorkflowLaunchModal defaultProjectId={props.workspaceId} onClose={() => setLaunchOpen(false)} />
          </div>
        </div>
      </Show>
    </div>
  )
}

function WorkspaceTerminalWidget(props: { workspacePath: string }) {
  const [sessions, setSessions] = createSignal<TerminalSession[]>([])
  const [activeSessionId, setActiveSessionId] = createSignal<string | null>(null)
  const [statusMessage, setStatusMessage] = createSignal('Select or start a session to begin.')
  const [cwdInput, setCwdInput] = createSignal('')
  const [shellInput, setShellInput] = createSignal('')
  const [isCreatingSession, setIsCreatingSession] = createSignal(false)
  const [connectionState, setConnectionState] = createSignal<'idle' | 'connecting' | 'open' | 'closed' | 'error'>('idle')

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
        shell: sanitizeInput(shellInput())
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

  onMount(() => {
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
      <header>
        <p class="text-xs uppercase tracking-[0.35em] text-[var(--text-muted)]">Terminal</p>
        <h2 class="text-2xl font-semibold">Sessions</h2>
      </header>
      <section class="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <form class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 text-sm" onSubmit={handleStartSession}>
          <label class="text-xs font-semibold text-[var(--text-muted)]" for="workspace-terminal-cwd">
            Working directory
          </label>
          <input
            id="workspace-terminal-cwd"
            class="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-2"
            type="text"
            value={cwdInput()}
            onInput={(event) => setCwdInput(event.currentTarget.value)}
          />
          <label class="mt-3 text-xs font-semibold text-[var(--text-muted)]" for="workspace-terminal-shell">
            Shell (optional)
          </label>
          <input
            id="workspace-terminal-shell"
            class="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-2"
            type="text"
            value={shellInput()}
            onInput={(event) => setShellInput(event.currentTarget.value)}
            placeholder="/bin/zsh"
          />
          <button class="mt-4 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60" type="submit" disabled={isCreatingSession()}>
            {isCreatingSession() ? 'Starting…' : 'Start session'}
          </button>
          <p class="mt-2 text-xs text-[var(--text-muted)]">{statusMessage()}</p>
        </form>
        <div class="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">Active sessions</p>
              <p class="text-xs text-[var(--text-muted)]">Select a session to attach the terminal.</p>
            </div>
            <button class="rounded-xl border border-[var(--border)] px-3 py-1 text-xs" type="button" onClick={() => void refreshSessions()}>
              Refresh
            </button>
          </div>
          <div class="grid gap-2">
            <For each={sessions()}>
              {(session) => (
                <button
                  class="flex flex-col rounded-2xl border px-3 py-2 text-left text-sm"
                  classList={{
                    'border-blue-500 bg-blue-950/30': activeSessionId() === session.id,
                    'border-[var(--border)] bg-[var(--bg-muted)]': activeSessionId() !== session.id
                  }}
                  type="button"
                  onClick={() => connectToSession(session.id)}
                >
                  <span class="font-semibold">{session.id.slice(0, 8)}</span>
                  <span class="text-xs text-[var(--text-muted)]">{session.status}</span>
                </button>
              )}
            </For>
            <Show when={!sessions().length}>
              <p class="text-sm text-[var(--text-muted)]">No sessions yet.</p>
            </Show>
          </div>
          <div class="mt-3 flex items-center gap-2">
            <button class="rounded-xl border border-[var(--border)] px-3 py-1 text-xs" type="button" disabled={!activeSession()} onClick={() => void handleCloseSession()}>
              Close session
            </button>
            <span class="text-xs text-[var(--text-muted)]">State: {connectionState()}</span>
          </div>
          <div
            ref={(node) => {
              terminalContainer = node ?? undefined
              ensureTerminal()
            }}
            class="mt-4 min-h-[360px] rounded-2xl border border-[var(--border)] bg-[#020617] p-3"
          />
        </div>
      </section>
    </div>
  )
}

function SessionsWidget(props: { workspacePath: string }) {
  const [filter, setFilter] = createSignal(props.workspacePath ?? '')
  createEffect(() => {
    if (props.workspacePath) {
      setFilter(props.workspacePath)
    }
  })
  return (
    <div class="flex h-full flex-col gap-4 p-6 text-[var(--text)]">
      <header>
        <p class="text-xs uppercase tracking-[0.35em] text-[var(--text-muted)]">Opencode sessions</p>
        <h2 class="text-2xl font-semibold">Background activity</h2>
      </header>
      <div class="flex-1 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <OpencodeConsole
          workspaceFilter={filter()}
          onWorkspaceFilterChange={setFilter}
          heading="Workspace activity"
          description="Scope transcripts to this workspace or clear the filter to see everything."
        />
      </div>
    </div>
  )
}

function sanitizeInput(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed.length ? trimmed : undefined
}
