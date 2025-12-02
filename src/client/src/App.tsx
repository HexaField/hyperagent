import type { RouteSectionProps } from '@solidjs/router'
import { Route, Router } from '@solidjs/router'
import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type JSX
} from 'solid-js'
import ThemeToggle from './components/ThemeToggle'
import { WIDGET_TEMPLATES, type WidgetAddEventDetail } from './constants/widgetTemplates'
import { WORKSPACE_NAVIGATOR_CLOSE_EVENT, WORKSPACE_NAVIGATOR_OPEN_EVENT } from './core/events/workspaceNavigator'
import SingleWidgetView from './core/layout/SingleWidgetView'
import RepositoryNavigator from './core/layout/navigation/RepositoryNavigator'
import { CanvasNavigatorContext, useCanvasNavigator } from './core/state/CanvasNavigatorContext'
import { WorkspaceSelectionProvider } from './core/state/WorkspaceSelectionContext'
import { type SingleWidgetViewDetail } from './core/state/singleWidgetView'
import WorkspacePage from './pages/WorkspacePage'
import { fetchJson } from './shared/api/httpClient'

type RadicleStatus = {
  reachable: boolean
  loggedIn: boolean
  identity?: string | null
  alias?: string | null
  message?: string | null
}

const NAVIGATOR_MOBILE_QUERY = '(max-width: 768px)'

const AppShell = (props: RouteSectionProps) => {
  const [navigatorOpen, setNavigatorOpen] = createSignal(false)
  const [navigatorMobileViewport, setNavigatorMobileViewport] = createSignal(false)
  const openNavigator = () => setNavigatorOpen(true)
  const closeNavigator = () => setNavigatorOpen(false)
  const navigatorController = {
    isOpen: navigatorOpen,
    open: openNavigator,
    close: closeNavigator,
    toggle: () => setNavigatorOpen((value) => !value)
  }

  onMount(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia(NAVIGATOR_MOBILE_QUERY)
    const updateViewport = () => setNavigatorMobileViewport(mq.matches)
    updateViewport()
    const handleOpen = () => openNavigator()
    const handleClose = () => closeNavigator()
    const handleMediaChange = (event: MediaQueryListEvent) => setNavigatorMobileViewport(event.matches)
    window.addEventListener(WORKSPACE_NAVIGATOR_OPEN_EVENT, handleOpen)
    window.addEventListener(WORKSPACE_NAVIGATOR_CLOSE_EVENT, handleClose)
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', handleMediaChange)
    else mq.addListener(handleMediaChange)
    onCleanup(() => {
      window.removeEventListener(WORKSPACE_NAVIGATOR_OPEN_EVENT, handleOpen)
      window.removeEventListener(WORKSPACE_NAVIGATOR_CLOSE_EVENT, handleClose)
      if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', handleMediaChange)
      else mq.removeListener(handleMediaChange)
    })
  })

  return (
    <CanvasNavigatorContext.Provider value={navigatorController}>
      <main class="relative flex min-h-screen w-full flex-col bg-[var(--bg-app)]">
        <section class="relative flex-1 overflow-auto">{props.children}</section>
        <CanvasChrome mobileNavigator={navigatorMobileViewport} />
      </main>
      <MobileWorkspaceNavigator
        isOpen={navigatorOpen}
        isMobileViewport={navigatorMobileViewport}
        onClose={closeNavigator}
      />
    </CanvasNavigatorContext.Provider>
  )
}

export default function App() {
  const [radicleStatus, { refetch: refetchRadicleStatus }] = createResource(fetchRadicleStatus)
  const [singleState, setSingleState] = createSignal<SingleWidgetViewDetail | null>(null)

  const isReady = () => {
    const status = radicleStatus()
    return Boolean(status && status.reachable && status.loggedIn)
  }

  onMount(() => {
    if (typeof window === 'undefined') return
    const applyDetail = (detail: SingleWidgetViewDetail) => {
      setSingleState(detail)
      window.__singleWidgetViewActive = true
      window.__pendingSingleWidgetView = null
    }
    const clearDetail = () => {
      setSingleState(null)
      window.__singleWidgetViewActive = false
      window.__pendingSingleWidgetView = null
    }
    window.__singleWidgetViewActive = Boolean(singleState())
    const openHandler = (ev: Event) => {
      const detail = (ev as CustomEvent<SingleWidgetViewDetail>).detail
      if (!detail) return
      applyDetail(detail)
    }
    const closeHandler = () => {
      clearDetail()
    }
    window.addEventListener('workspace:open-single-view', openHandler)
    window.addEventListener('workspace:close-single-view', closeHandler)
    onCleanup(() => {
      window.removeEventListener('workspace:open-single-view', openHandler)
      window.removeEventListener('workspace:close-single-view', closeHandler)
    })
    const pending = window.__pendingSingleWidgetView
    if (pending) {
      applyDetail(pending)
    }
  })

  return (
    <Show when={isReady()} fallback={<RadicleGate status={radicleStatus()} onRetry={() => refetchRadicleStatus()} />}>
      <Router
        root={(routeProps) => (
          <WorkspaceSelectionProvider>
            <AppShell {...routeProps} />
            <Show when={singleState()}>
              {(s) => (
                <SingleWidgetView
                  storageKey={s().storageKey}
                  widgets={s().widgets}
                  onRemoveWidget={s().onRemoveWidget}
                />
              )}
            </Show>
          </WorkspaceSelectionProvider>
        )}
      >
        <Route path="/" component={WorkspacePage} />
      </Router>
    </Show>
  )
}

function CanvasChrome(props: { mobileNavigator: Accessor<boolean> }) {
  const navigator = useCanvasNavigator()
  const [widgetMenuOpen, setWidgetMenuOpen] = createSignal(false)
  const [singleViewActive, setSingleViewActive] = createSignal(
    typeof window !== 'undefined' ? Boolean(window.__singleWidgetViewActive) : false
  )

  onMount(() => {
    if (typeof window === 'undefined') return
    const handleOpen = () => setSingleViewActive(true)
    const handleClose = () => setSingleViewActive(false)
    window.addEventListener('workspace:open-single-view', handleOpen)
    window.addEventListener('workspace:close-single-view', handleClose)
    onCleanup(() => {
      window.removeEventListener('workspace:open-single-view', handleOpen)
      window.removeEventListener('workspace:close-single-view', handleClose)
    })
  })

  createEffect(() => {
    if (singleViewActive()) setWidgetMenuOpen(false)
  })

  const widgetActions = WIDGET_TEMPLATES.map((template) => ({
    label: template.label,
    description: template.description,
    onSelect: () => {
      if (typeof window === 'undefined') return
      try {
        const isMobile =
          typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 640px)').matches
        if (isMobile) {
          window.dispatchEvent(new CustomEvent('workspace:open-single-widget', { detail: { templateId: template.id } }))
        } else {
          window.dispatchEvent(
            new CustomEvent<WidgetAddEventDetail>('workspace:add-widget', {
              detail: { templateId: template.id }
            })
          )
        }
      } catch {}
    }
  }))

  const stopCanvasPropagation = (event: PointerEvent) => event.stopPropagation()
  const toggleWorkspaceMenu = () => (navigator.isOpen() ? navigator.close() : navigator.open())

  return (
    <Show when={!singleViewActive()}>
      <div
        class="pointer-events-none absolute inset-x-0 top-0 flex justify-between px-6 py-6"
        onPointerDown={stopCanvasPropagation}
      >
        <div class="pointer-events-auto flex flex-col gap-3">
          <button
            type="button"
            class="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-card)]/90 px-4 py-2 text-sm font-semibold text-[var(--text)] shadow-[0_18px_30px_rgba(15,23,42,0.12)]"
            onClick={toggleWorkspaceMenu}
          >
            <span class="text-lg">☰</span>
            Workspace
          </button>
          <Show when={navigator.isOpen() && !props.mobileNavigator()}>
            <ChromePanel title="Workspace" onNavigate={() => navigator.close()} widthClass="w-[36rem]">
              <WorkspaceNavigatorContent variant="desktop" onClose={navigator.close} />
            </ChromePanel>
          </Show>
        </div>
        <div class="pointer-events-auto flex flex-col items-end gap-3">
          <div class="flex items-center gap-3">
            <ThemeToggle />
            <button
              type="button"
              class="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-card)]/90 px-4 py-2 text-sm font-semibold text-[var(--text)] shadow-[0_18px_30px_rgba(15,23,42,0.12)]"
              onClick={() => setWidgetMenuOpen((value) => !value)}
            >
              Widgets
              <span class="text-lg">☰</span>
            </button>
          </div>
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
    </Show>
  )
}

type MobileWorkspaceNavigatorProps = {
  isOpen: Accessor<boolean>
  isMobileViewport: Accessor<boolean>
  onClose: () => void
}

function MobileWorkspaceNavigator(props: MobileWorkspaceNavigatorProps) {
  const shouldShow = createMemo(() => props.isMobileViewport() && props.isOpen())
  let previousOverflow: string | null = null

  createEffect(() => {
    if (typeof document === 'undefined') return
    if (shouldShow()) {
      previousOverflow = document.documentElement.style.overflow
      document.documentElement.style.overflow = 'hidden'
    } else if (previousOverflow !== null) {
      document.documentElement.style.overflow = previousOverflow
      previousOverflow = null
    }
  })

  onCleanup(() => {
    if (typeof document === 'undefined') return
    if (previousOverflow !== null) {
      document.documentElement.style.overflow = previousOverflow
      previousOverflow = null
    }
  })

  return (
    <Show when={shouldShow()}>
      <div class="fixed inset-0 z-[60] flex flex-col bg-[var(--bg-app)] text-[var(--text)]">
        <div class="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div>
            <p class="text-xs uppercase tracking-[0.35em] text-[var(--text-muted)]">Workspace</p>
            <p class="text-sm text-[var(--text)]">Manage repositories</p>
          </div>
          <button
            type="button"
            class="rounded-full border border-[var(--border)] px-4 py-1 text-sm"
            onClick={props.onClose}
          >
            Close
          </button>
        </div>
        <div class="flex flex-1 flex-col gap-4 overflow-hidden px-3 py-4">
          <WorkspaceNavigatorContent variant="mobile" onClose={props.onClose} />
        </div>
      </div>
    </Show>
  )
}

type WorkspaceNavigatorContentProps = {
  variant?: 'desktop' | 'mobile'
  onClose: () => void
}

function WorkspaceNavigatorContent(props: WorkspaceNavigatorContentProps) {
  const navigator = useCanvasNavigator()
  const setPreferredViewMode = (mode: 'canvas' | 'single') => {
    if (typeof window === 'undefined') return
    try {
      const params = new URLSearchParams(window.location.search)
      const workspaceId = params.get('workspaceId')
      if (workspaceId) window.localStorage.setItem(`workspace:${workspaceId}:view`, mode)
    } catch {}
    window.dispatchEvent(new CustomEvent('workspace:view-change', { detail: { mode } }))
    navigator.close()
  }

  const scrollClass = () =>
    props.variant === 'mobile' ? 'flex-1 overflow-y-auto pr-1' : 'max-h-[70vh] overflow-y-auto pr-1'

  const containerClass = () =>
    props.variant === 'mobile' ? 'flex min-h-0 flex-1 flex-col gap-3' : 'flex flex-col gap-3'
  const showViewControls = () => props.variant !== 'mobile'

  return (
    <div class={containerClass()}>
      <Show when={showViewControls()}>
        <div class="flex items-center justify-between gap-3">
          <div class="text-sm">
            <p class="text-xs text-[var(--text-muted)]">View mode</p>
          </div>
          <div class="flex gap-2">
            <button
              type="button"
              class="rounded-xl border border-[var(--border)] px-3 py-1 text-sm"
              onClick={() => setPreferredViewMode('canvas')}
            >
              Canvas
            </button>
            <button
              type="button"
              class="rounded-xl border border-[var(--border)] bg-blue-600 px-3 py-1 text-sm font-semibold text-white"
              onClick={() => setPreferredViewMode('single')}
            >
              Single widget
            </button>
          </div>
        </div>
      </Show>
      <div class={scrollClass()}>
        <RepositoryNavigator close={props.onClose} />
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
        fallback={
          <div class="rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-2 text-left text-[var(--text)]">
            {props.children}
          </div>
        }
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
