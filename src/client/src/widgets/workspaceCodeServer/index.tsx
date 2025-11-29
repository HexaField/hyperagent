import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal } from 'solid-js'
import { listCodeServerSessions } from '../../lib/codeServer'
import { ensureWorkspaceDevspace, type DevspaceSession } from '../../lib/devspace'

export type WorkspaceCodeServerWidgetProps = {
  workspaceId: string
  workspaceName: string
  workspacePath: string
}

export function WorkspaceCodeServerWidget(props: WorkspaceCodeServerWidgetProps) {
  const [sessions, { refetch: refetchSessions }] = createResource(listCodeServerSessions)
  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null)
  const [launching, setLaunching] = createSignal(false)
  const [launchError, setLaunchError] = createSignal<string | null>(null)
  const [ephemeralSession, setEphemeralSession] = createSignal<DevspaceSession | null>(null)

  const workspaceSessions = createMemo(() => {
    const list = sessions() ?? []
    return list.filter((session) => session.projectId === props.workspaceId)
  })

  createEffect(() => {
    const available = workspaceSessions()
    if (!available.length) {
      if (selectedSessionId()) {
        setSelectedSessionId(null)
      }
      return
    }
    if (!selectedSessionId() || !available.some((entry) => entry.id === selectedSessionId())) {
      setSelectedSessionId(available[0].id)
    }
  })

  const selectedSession = createMemo(
    () => workspaceSessions().find((session) => session.id === selectedSessionId()) ?? null
  )
  const sessionError = () => {
    const error = sessions.error
    if (!error) return null
    return error instanceof Error ? error.message : String(error)
  }
  const isLoadingSessions = () => sessions.state === 'pending'
  const activeSessionUrl = createMemo(() => selectedSession()?.url ?? ephemeralSession()?.codeServerUrl ?? null)
  const activeSessionId = createMemo(() => selectedSession()?.id ?? ephemeralSession()?.sessionId ?? null)
  const activeSessionBranch = createMemo(() => selectedSession()?.branch ?? ephemeralSession()?.branch ?? null)
  const activeSessionPath = createMemo(
    () => selectedSession()?.workspacePath ?? ephemeralSession()?.workspacePath ?? props.workspacePath
  )

  const handleRefreshSessions = () => {
    setLaunchError(null)
    setEphemeralSession(null)
    void refetchSessions()
  }

  const handleLaunchSession = async () => {
    setLaunchError(null)
    setLaunching(true)
    try {
      const session = await ensureWorkspaceDevspace(props.workspaceId)
      setEphemeralSession(session)
      setSelectedSessionId(session.sessionId)
      await refetchSessions()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to launch VS Code session'
      setLaunchError(message)
    } finally {
      setLaunching(false)
    }
  }

  const handleOpenExternal = () => {
    const url = activeSessionUrl()
    if (!url || typeof window === 'undefined') return
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div class="flex h-full flex-col gap-4 p-6 text-[var(--text)]">
      <section class="h-full grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div class="flex h-full flex-col gap-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4 text-sm">
          <div>
            <p class="text-sm font-semibold">Workspace location</p>
            <p class="break-all text-xs text-[var(--text-muted)]">{props.workspacePath}</p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              class="rounded-xl border border-[var(--border)] px-3 py-1 text-xs"
              type="button"
              onClick={handleRefreshSessions}
            >
              Refresh list
            </button>
            <button
              class="rounded-xl bg-blue-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
              type="button"
              disabled={launching()}
              onClick={() => void handleLaunchSession()}
            >
              {launching() ? 'Launching…' : 'Launch VS Code here'}
            </button>
          </div>
          <Show when={sessionError()}>{(message) => <p class="text-xs text-red-400">{message()}</p>}</Show>
          <Show when={launchError()}>{(message) => <p class="text-xs text-red-400">{message()}</p>}</Show>
          <div class="flex-1 space-y-2 overflow-auto pr-1">
            <Show
              when={!isLoadingSessions()}
              fallback={<p class="text-xs text-[var(--text-muted)]">Loading sessions…</p>}
            >
              <For each={workspaceSessions()}>
                {(session) => (
                  <button
                    class="w-full rounded-2xl border px-3 py-2 text-left"
                    classList={{
                      'border-blue-500 bg-blue-950/30': selectedSessionId() === session.id,
                      'border-[var(--border)] bg-[var(--bg-muted)]': selectedSessionId() !== session.id
                    }}
                    type="button"
                    onClick={() => {
                      setSelectedSessionId(session.id)
                      setEphemeralSession(null)
                    }}
                  >
                    <div class="flex items-center justify-between text-sm">
                      <span class="font-semibold">Session {session.id.slice(0, 8)}</span>
                      <span class="text-xs text-[var(--text-muted)]">
                        {new Date(session.startedAt).toLocaleString()}
                      </span>
                    </div>
                    <p class="text-xs text-[var(--text-muted)]">{session.workspacePath}</p>
                    <p class="text-xs text-[var(--text-muted)]">Branch {session.branch}</p>
                  </button>
                )}
              </For>
              <Show when={!workspaceSessions().length}>
                <p class="text-xs text-[var(--text-muted)]">No active VS Code sessions for this workspace.</p>
              </Show>
            </Show>
          </div>
        </div>
        <div class="flex h-full flex-col rounded-2xl border border-[var(--border)] bg-[var(--bg-card)]">
          <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-muted)] px-4 py-3">
            <div>
              <p class="text-sm font-semibold">
                {activeSessionId()
                  ? `Attached to ${activeSessionId()!.slice(0, 8)}`
                  : 'Select or launch a VS Code session'}
              </p>
              <p class="text-xs text-[var(--text-muted)]">
                {activeSessionId()
                  ? `Branch ${activeSessionBranch() ?? 'unknown'} · ${activeSessionPath()}`
                  : 'Launch a session to embed VS Code via code-server.'}
              </p>
            </div>
            <button
              class="rounded-xl border border-[var(--border)] px-3 py-1 text-xs disabled:opacity-60"
              type="button"
              onClick={handleOpenExternal}
              disabled={!activeSessionUrl()}
            >
              Open in new tab
            </button>
          </div>
          <div class="flex-1 overflow-hidden">
            <Switch>
              <Match when={launching()}>
                <div class="flex h-full flex-col items-center justify-center gap-2 text-center">
                  <p class="text-sm text-[var(--text-muted)]">Launching VS Code…</p>
                  <p class="text-xs text-[var(--text-muted)]">This connects to code-server for this repository.</p>
                </div>
              </Match>
              <Match when={Boolean(activeSessionUrl())}>
                <iframe
                  src={activeSessionUrl() ?? ''}
                  title={`code-server-${props.workspaceId}`}
                  class="h-full w-full border-0"
                  allow="clipboard-write; clipboard-read; fullscreen"
                />
              </Match>
              <Match when={true}>
                <div class="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-[var(--text-muted)]">
                  <p>No VS Code session selected.</p>
                  <p>Launch a session or pick one from the list.</p>
                </div>
              </Match>
            </Switch>
          </div>
        </div>
      </section>
    </div>
  )
}

export default WorkspaceCodeServerWidget
