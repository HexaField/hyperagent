import type { RouteSectionProps } from '@solidjs/router'
import { Route, Router } from '@solidjs/router'
import { For, Show, createResource, createSignal, type JSX } from 'solid-js'
import { fetchJson } from './lib/http'
import WorkspacePage from './pages/WorkspacePage'
import { CanvasNavigatorContext, useCanvasNavigator } from './contexts/CanvasNavigatorContext'
import { WorkspaceSelectionProvider } from './contexts/WorkspaceSelectionContext'
import RepositoryNavigator from './components/navigation/RepositoryNavigator'
import { WIDGET_TEMPLATES, type WidgetAddEventDetail } from './constants/widgetTemplates'

type RadicleStatus = {
  reachable: boolean
  loggedIn: boolean
  identity?: string | null
  alias?: string | null
  message?: string | null
}

const AppShell = (props: RouteSectionProps) => {
  const [navigatorOpen, setNavigatorOpen] = createSignal(false)
  const navigatorController = {
    isOpen: navigatorOpen,
    open: () => setNavigatorOpen(true),
    close: () => setNavigatorOpen(false),
    toggle: () => setNavigatorOpen((value) => !value)
  }
  return (
    <WorkspaceSelectionProvider>
      <CanvasNavigatorContext.Provider value={navigatorController}>
        <main class="relative flex min-h-screen w-full flex-col bg-[var(--bg-app)]">
          <section class="relative flex-1 overflow-auto">{props.children}</section>
          <CanvasChrome />
        </main>
      </CanvasNavigatorContext.Provider>
    </WorkspaceSelectionProvider>
  )
}

export default function App() {
  const [radicleStatus, { refetch: refetchRadicleStatus }] = createResource(fetchRadicleStatus)

  const isReady = () => {
    const status = radicleStatus()
    return Boolean(status && status.reachable && status.loggedIn)
  }

  return (
    <Show when={isReady()} fallback={<RadicleGate status={radicleStatus()} onRetry={() => refetchRadicleStatus()} />}>
      <Router root={AppShell}>
        <Route path="/" component={WorkspacePage} />
      </Router>
    </Show>
  )
}

function CanvasChrome() {
  const navigator = useCanvasNavigator()
  const [widgetMenuOpen, setWidgetMenuOpen] = createSignal(false)

  const widgetActions = WIDGET_TEMPLATES.map((template) => ({
    label: template.label,
    description: template.description,
    onSelect: () => {
      if (typeof window === 'undefined') return
      window.dispatchEvent(
        new CustomEvent<WidgetAddEventDetail>('workspace:add-widget', {
          detail: { templateId: template.id }
        })
      )
    }
  }))

  const stopCanvasPropagation = (event: PointerEvent) => event.stopPropagation()
  const toggleWorkspaceMenu = () => (navigator.isOpen() ? navigator.close() : navigator.open())

  return (
    <div class="absolute inset-x-0 top-0 flex justify-between px-6 py-6" onPointerDown={stopCanvasPropagation}>
      <div class="pointer-events-auto flex flex-col gap-3">
        <button
          type="button"
          class="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-card)]/90 px-4 py-2 text-sm font-semibold text-[var(--text)] shadow-[0_18px_30px_rgba(15,23,42,0.12)]"
          onClick={toggleWorkspaceMenu}
        >
          <span class="text-lg">☰</span>
          Workspace
        </button>
        <Show when={navigator.isOpen()}>
          <ChromePanel title="Workspace" onNavigate={() => navigator.close()} widthClass="w-[36rem]">
            <div class="max-h-[70vh] overflow-y-auto pr-1">
              <RepositoryNavigator />
            </div>
          </ChromePanel>
        </Show>
      </div>
      <div class="pointer-events-auto flex flex-col items-end gap-3">
        <button
          type="button"
          class="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-card)]/90 px-4 py-2 text-sm font-semibold text-[var(--text)] shadow-[0_18px_30px_rgba(15,23,42,0.12)]"
          onClick={() => setWidgetMenuOpen((value) => !value)}
        >
          Widgets
          <span class="text-lg">☰</span>
        </button>
        <Show when={widgetMenuOpen()}>
          <ChromePanel
            title="Widget library"
            actions={widgetActions}
            alignment="end"
            onNavigate={() => setWidgetMenuOpen(false)}
          />
        </Show>
      </div>
    </div>
  )
}

type ChromePanelProps = {
  title: string
  actions?: { label: string; description?: string; onSelect: () => void }[]
  alignment?: 'start' | 'end'
  onNavigate?: () => void
  children?: JSX.Element
  widthClass?: string
}

function ChromePanel(props: ChromePanelProps) {
  const panelWidth = props.widthClass ?? 'w-72'
  return (
    <div
      class={`flex ${panelWidth} flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)]/95 p-4 text-[var(--text)] shadow-[0_18px_30px_rgba(15,23,42,0.15)] backdrop-blur`}
      classList={{ 'self-end text-right': props.alignment === 'end' }}
    >
      <p class="text-xs uppercase tracking-[0.35em] text-[var(--text-muted)]">{props.title}</p>
      <Show
        when={props.actions?.length}
        fallback={<div class="rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-2 text-left text-[var(--text)]">{props.children}</div>}
      >
        <For each={props.actions}>
          {(action) => (
            <button
              type="button"
              class="rounded-xl border border-transparent px-3 py-2 text-left text-[var(--text)] transition hover:border-[var(--border)]"
              onClick={() => {
                action.onSelect()
                props.onNavigate?.()
              }}
            >
              <p class="text-sm font-semibold">{action.label}</p>
              <Show when={action.description}>
                {(desc) => <p class="text-xs text-[var(--text-muted)]">{desc()}</p>}
              </Show>
            </button>
          )}
        </For>
      </Show>
    </div>
  )
}

type RadicleGateProps = {
  status: RadicleStatus | undefined
  onRetry: () => void
}

function RadicleGate(props: RadicleGateProps) {
  const message = () => {
    if (!props.status) return 'Checking Radicle node status…'
    if (!props.status.reachable) {
      return props.status.message ?? 'Radicle node is unreachable. Ensure your local node is running.'
    }
    if (!props.status.loggedIn) {
      return props.status.message ?? 'You must be logged into Radicle before using Hyperagent.'
    }
    return 'Radicle is ready.'
  }
  return (
    <main class="mx-auto flex min-h-screen w-full max-w-[760px] flex-col items-center justify-center gap-6 px-4 text-center">
      <section class="w-full rounded-[1.5rem] border border-[var(--border)] bg-[var(--bg-card)] px-6 py-10 shadow-[0_30px_40px_rgba(15,23,42,0.12)]">
        <p class="text-sm uppercase tracking-[0.35em] text-[var(--text-muted)]">Radicle required</p>
        <h1 class="mt-3 text-3xl font-semibold text-[var(--text)]">Connect to your Radicle node</h1>
        <p class="mt-4 text-[var(--text-muted)]">{message()}</p>
        <button
          class="mt-6 rounded-xl bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white"
          type="button"
          onClick={props.onRetry}
        >
          Retry
        </button>
      </section>
    </main>
  )
}

async function fetchRadicleStatus(): Promise<RadicleStatus> {
  try {
    const payload = await fetchJson<{ status: RadicleStatus }>('/api/radicle/status')
    return payload.status
  } catch (error) {
    return {
      reachable: false,
      loggedIn: false,
      message: error instanceof Error ? error.message : 'Unable to reach Radicle status endpoint'
    }
  }
}
