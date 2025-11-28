import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { WIDGET_TEMPLATES } from '../../constants/widgetTemplates'
import ThemeToggle from '../ThemeToggle'
import type { CanvasWidgetConfig } from './CanvasWorkspace'

export type SingleWidgetViewProps = {
  storageKey: string
  widgets: CanvasWidgetConfig[]
  class?: string
  onRemoveWidget?: (id: string) => void
}

export default function SingleWidgetView(props: SingleWidgetViewProps) {
  const widgetList = createMemo(() => props.widgets ?? [])
  const [selectedId, setSelectedId] = createSignal<string | null>(null)
  const [mobile, setMobile] = createSignal(false)
  const [widgetMenuOpen, setWidgetMenuOpen] = createSignal(false)
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const storageKey = () => `single-view:${props.storageKey || 'default'}`

  const sharedSingleWidgetStyles = `
    .single-widget-root, .single-widget-root > * { box-sizing: border-box !important; max-width: 100% !important; overflow-wrap: anywhere !important; word-break: break-word !important; }
    .single-widget-root img, .single-widget-root iframe, .single-widget-root code, .single-widget-root pre { max-width: 100% !important; height: auto !important; }
    .single-widget-root pre { white-space: pre-wrap !important; }
    /* Ensure flex children can shrink to avoid overflow */
    .single-widget-root .flex, .single-widget-root .flex-1, .single-widget-root [class*="min-w-"] { min-width: 0 !important; }
  `

  const selectedWidget = createMemo(() => {
    const list = widgetList()
    if (!list.length) return null
    const id = selectedId()
    return (id ? list.find((w) => w.id === id) : null) ?? list[0] ?? null
  })
  const hideSingleHeader = createMemo(() => Boolean(selectedWidget()?.hideSingleHeader))

  let prevOverflowX: string | null = null
  let prevOverflowY: string | null = null

  onMount(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(storageKey())
      if (raw) {
        const parsed = JSON.parse(raw)
        if (typeof parsed === 'string') setSelectedId(parsed)
      }
    } catch {
      // ignore
    }

    if (!selectedId() && widgetList().length) setSelectedId(widgetList()[0].id)

    try {
      const mq = window.matchMedia('(max-width: 640px)')
      const handler = () => {
        setMobile(mq.matches)
        try {
          window.dispatchEvent(new CustomEvent('single-widget:mobile', { detail: { mobile: mq.matches } }))
        } catch {}
      }
      handler()
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', handler)
      else mq.addListener(handler)

      const keydownHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          if (widgetMenuOpen()) setWidgetMenuOpen(false)
          if (settingsOpen()) setSettingsOpen(false)
        }
      }
      window.addEventListener('keydown', keydownHandler)

      onCleanup(() => {
        window.removeEventListener('keydown', keydownHandler)
      })
    } catch {
      // ignore
    }
  })

  // Lock document scrolling when the mobile single-widget overlay is visible
  createEffect(() => {
    if (typeof window === 'undefined') return
    if (mobile()) {
      try {
        prevOverflowX = document.documentElement.style.overflowX || null
        prevOverflowY = document.documentElement.style.overflowY || null
        document.documentElement.style.overflowX = 'hidden'
        document.documentElement.style.overflowY = 'hidden'
      } catch {
        // ignore
      }
    } else {
      try {
        if (prevOverflowX !== null) document.documentElement.style.overflowX = prevOverflowX
        else document.documentElement.style.removeProperty('overflow-x')
        if (prevOverflowY !== null) document.documentElement.style.overflowY = prevOverflowY
        else document.documentElement.style.removeProperty('overflow-y')
      } catch {
        // ignore
      }
    }
  })

  onCleanup(() => {
    try {
      if (prevOverflowX !== null) document.documentElement.style.overflowX = prevOverflowX
      else document.documentElement.style.removeProperty('overflow-x')
      if (prevOverflowY !== null) document.documentElement.style.overflowY = prevOverflowY
      else document.documentElement.style.removeProperty('overflow-y')
    } catch {
      // ignore
    }
  })

  createEffect(() => {
    const id = selectedId()
    if (!id || typeof window === 'undefined') return
    try {
      window.localStorage.setItem(storageKey(), JSON.stringify(id))
    } catch {
      // ignore
    }
  })

  createEffect(() => {
    const list = widgetList()
    const id = selectedId()
    if (!list.length) {
      setSelectedId(null)
      return
    }
    if (!id || !list.some((w) => w.id === id)) setSelectedId(list[0].id)
  })

  // helper to open a single widget directly (used when selecting from widget menu)
  const openSingleWidgetByTemplate = (templateId: string) => {
    try {
      if (typeof window === 'undefined') return
      window.dispatchEvent(new CustomEvent('workspace:open-single-widget', { detail: { templateId } }))
    } catch {}
  }

  return (
    <div class={`relative h-full min-h-[100dvh] w-full bg-[var(--bg-app)] overflow-visible ${props.class ?? ''}`}>
      {mobile() ? (
        <div class="fixed inset-0 m-0 p-0 box-border bg-[var(--bg-app)]">
          <style>{`
/* Aggressive clamping to prevent horizontal overflow inside single widget view */
.single-widget-root, .single-widget-root > * { margin: 0 !important; padding: 0 !important; box-sizing: border-box !important; max-width: 100vw !important; min-width: 0 !important; overflow-wrap: anywhere !important; word-break: break-word !important; }
.single-widget-root * { max-width: 100% !important; min-width: 0 !important; box-sizing: border-box !important; }
.single-widget-root { -webkit-overflow-scrolling: touch; overflow-x: hidden !important; }
.single-widget-root img, .single-widget-root iframe { max-width: 100% !important; height: auto !important; }
.single-widget-root code, .single-widget-root pre { max-width: 100% !important; white-space: pre-wrap !important; overflow-wrap: anywhere !important; word-break: break-word !important; }
/* Ensure flex children can shrink to avoid overflow */
.single-widget-root .flex, .single-widget-root .flex-1, .single-widget-root [class*="min-w-"] { min-width: 0 !important; }
`}</style>
          <div class="flex flex-col h-full w-full">
            {/* Mobile standardized header: left widget menu, center title, right settings (theme) */}
            <Show when={!hideSingleHeader()}>
              <div class="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] bg-[var(--bg-muted)]">
                <div class="flex items-center gap-2 w-1/4">
                  <div class="relative">
                    <button
                      type="button"
                      class="inline-flex items-center gap-2 rounded-full border border-[var(--border)] px-3 py-1 text-sm font-semibold"
                      aria-label="Open widgets menu"
                      onClick={() => setWidgetMenuOpen((v) => !v)}
                    >
                      ☰
                    </button>
                    <Show when={widgetMenuOpen()}>
                      <>
                        <button
                          type="button"
                          class="fixed inset-0"
                          aria-label="Close widget menu"
                          onClick={() => setWidgetMenuOpen(false)}
                        />
                        <div class="fixed left-0 right-0 top-12 z-50 max-w-none border-t border-b border-[var(--border)] bg-[var(--bg-card)] p-3 shadow-lg">
                          <For each={WIDGET_TEMPLATES}>
                            {(template) => (
                              <button
                                type="button"
                                class="w-full text-left rounded-md px-3 py-2 text-sm hover:bg-[var(--bg-muted)]"
                                onClick={() => {
                                  openSingleWidgetByTemplate(template.id)
                                  setWidgetMenuOpen(false)
                                }}
                              >
                                {template.label}
                              </button>
                            )}
                          </For>
                        </div>
                      </>
                    </Show>
                  </div>
                </div>

                <div class="flex-1 text-center text-sm font-semibold">
                  {selectedWidget() ? selectedWidget()!.title : ''}
                </div>

                <div class="flex items-center justify-end gap-2 w-1/4">
                  <div class="relative">
                    <button
                      type="button"
                      class="inline-flex items-center gap-2 rounded-full border border-[var(--border)] px-3 py-1 text-sm"
                      aria-label="Open widget settings"
                      onClick={() => setSettingsOpen((v) => !v)}
                    >
                      ⚙️
                    </button>
                    <Show when={settingsOpen()}>
                      <>
                        <button
                          type="button"
                          class="fixed inset-0"
                          aria-label="Close settings"
                          onClick={() => setSettingsOpen(false)}
                        />
                        <div class="absolute right-0 mt-2 w-56 z-50 rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3 shadow-lg">
                          <p class="text-xs text-[var(--text-muted)] mb-2">Display</p>
                          <ThemeToggle />
                        </div>
                      </>
                    </Show>
                  </div>
                </div>
              </div>
            </Show>

            <div class="flex-1 overflow-y-auto overflow-x-hidden">
              <div class="single-widget-root w-full max-w-full box-border m-0 p-0">
                {selectedWidget() ? (
                  <div class="w-full max-w-full box-border">{selectedWidget()!.content?.()}</div>
                ) : (
                  <div class="p-2 text-[var(--text-muted)]">No widgets available</div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div class="flex h-full flex-col">
          <Show when={!hideSingleHeader()}>
            <header class="flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-muted)] px-4 py-3">
              <div>
                <p class="text-xs uppercase tracking-[0.35em] text-[var(--text-muted)]">Widget</p>
                <h2 class="text-lg font-semibold">{selectedWidget() ? selectedWidget()!.title : 'No widget'}</h2>
              </div>
              <div class="flex items-center gap-2">
                {selectedWidget()?.headerActions?.() ?? null}
                {selectedWidget()?.removable !== false ? (
                  <button
                    type="button"
                    class="rounded-xl border border-[var(--border)] px-3 py-1 text-sm text-red-500"
                    onClick={() => selectedWidget() && props.onRemoveWidget?.(selectedWidget()!.id)}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </header>
          </Show>

          <div class="flex-1 overflow-auto p-4 box-border">
            {selectedWidget() ? (
              <div class="h-full min-h-[60vh] max-w-full box-border">{selectedWidget()!.content?.()}</div>
            ) : (
              <div class="text-[var(--text-muted)]">No widgets available</div>
            )}
          </div>

          <nav class="border-t border-[var(--border)] bg-[var(--bg-card)] px-3 py-2">
            <div class="mx-auto flex max-w-[720px] items-center justify-center gap-3">
              <For each={widgetList()}>
                {(w) => (
                  <button
                    type="button"
                    class="flex items-center gap-2 rounded-2xl border px-3 py-2 text-sm"
                    classList={{ 'border-blue-500 bg-blue-950/30': selectedId() === w.id }}
                    onClick={() => setSelectedId(w.id)}
                    title={w.title}
                  >
                    {w.icon ? <span class="text-lg">{w.icon}</span> : null}
                    <span class="hidden sm:inline">{w.title}</span>
                  </button>
                )}
              </For>
            </div>
          </nav>
        </div>
      )}
    </div>
  )
}
