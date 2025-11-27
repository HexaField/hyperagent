import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import type { CanvasWidgetConfig } from './CanvasWorkspace'

const PAGE_STORAGE_PREFIX = 'single-widget:page'
const PAGE_QUERY_PARAM = 'widgetPage'

function getWidgetPageStorageKey(id: string) {
  return `${PAGE_STORAGE_PREFIX}:${id}`
}

function readWidgetPage(id: string | null | undefined): number | null {
  if (!id || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(getWidgetPageStorageKey(id))
    if (raw === null) return null
    const value = Number(JSON.parse(raw))
    return Number.isNaN(value) ? null : value
  } catch {
    return null
  }
}

function persistWidgetPage(id: string | null | undefined, value: number) {
  if (!id || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(getWidgetPageStorageKey(id), JSON.stringify(value))
  } catch {}
}

function readPageFromQuery(): { widgetId: string | null; page: number } | null {
  if (typeof window === 'undefined') return null
  try {
    const params = new URLSearchParams(window.location.search)
    const raw = params.get(PAGE_QUERY_PARAM)
    if (raw === null) return null
    if (raw.includes(':')) {
      const [idPart, pagePart] = raw.split(':')
      const parsed = Number(pagePart)
      if (Number.isNaN(parsed)) return null
      return { widgetId: idPart || null, page: parsed }
    }
    const fallback = Number(raw)
    return Number.isNaN(fallback) ? null : { widgetId: null, page: fallback }
  } catch {
    return null
  }
}

function updatePageQueryParam(widgetId: string, value: number) {
  if (typeof window === 'undefined') return
  try {
    const url = new URL(window.location.href)
    if (value > 0) url.searchParams.set(PAGE_QUERY_PARAM, `${widgetId}:${value}`)
    else url.searchParams.delete(PAGE_QUERY_PARAM)
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
  } catch {}
}

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

      const titleHandler = (e: Event) => {
        const ce = e as CustomEvent
        try {
          const title = typeof ce.detail?.title === 'string' ? ce.detail.title : null
          if (title !== null) {
            ;(window as any).__singleWidgetPageTitle = title
          }
        } catch {}
      }
      window.addEventListener('single-widget:page-title', titleHandler)
      onCleanup(() => {
        window.removeEventListener('single-widget:page-title', titleHandler)
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

  // mobile paging state and refs
  const [page, setPage] = createSignal(0)
  const [pageTitles, setPageTitles] = createSignal<string[]>([])
  const [singleRoot, setSingleRoot] = createSignal<HTMLDivElement | undefined>(undefined)
  let lastWidgetForPageRestore: string | null = null

  createEffect(() => {
    const widget = selectedWidget()
    if (!widget || !widget.id) return
    if (widget.id === lastWidgetForPageRestore) return
    lastWidgetForPageRestore = widget.id
    const queryValue = readPageFromQuery()
    if (queryValue && (queryValue.widgetId === null || queryValue.widgetId === widget.id)) {
      setPage(Math.max(0, Math.floor(queryValue.page)))
      return
    }
    const storedValue = readWidgetPage(widget.id)
    if (storedValue !== null) {
      setPage(Math.max(0, Math.floor(storedValue)))
    } else {
      setPage(0)
    }
  })

  // update pages info whenever selected widget changes or widget declares pages()
  createEffect(() => {
    const widget = selectedWidget()
    const root = singleRoot()
    if (!root) return

    // If widget provides a pages API, prefer that (strongly-typed)
    try {
      const pagesApi = (widget as any)?.pages as
        | (() => { title: string; content: () => HTMLElement | any }[])
        | undefined
      if (typeof pagesApi === 'function') {
        const entries = pagesApi() ?? []
        const titles = entries.map((e, idx) => (e && typeof e.title === 'string' ? e.title : `Page ${idx + 1}`))
        setPageTitles(titles)
        setPage((p) => Math.min(p, Math.max(0, entries.length - 1)))
        // ensure transform will be applied by the page effect (clamped to available pages)
        requestAnimationFrame(() => {
          const container = root.querySelector<HTMLElement>('.single-widget-pages')
          const maxIndex = Math.max(0, (entries?.length ?? 0) - 1)
          const cur = Math.min(page(), maxIndex)
          if (container) container.style.transform = `translateX(-${cur * 100}%)`
        })
        return
      }
    } catch {
      // fallthrough to DOM detection
    }

    // collect page elements in DOM (fallback) — use :scope to avoid nested widget carousels
    const pages = Array.from(root.querySelectorAll<HTMLElement>(':scope > .single-widget-pages > .single-widget-page'))
    if (!pages.length) {
      setPageTitles([])
      setPage(0)
      return
    }
    const titles = pages.map((el, idx) => el.getAttribute('data-single-widget-title') ?? `Page ${idx + 1}`)
    setPageTitles(titles)
    // clamp page
    setPage((p) => Math.min(p, Math.max(0, pages.length - 1)))
    // ensure transform
    requestAnimationFrame(() => {
      const container = root.querySelector<HTMLElement>('.single-widget-pages')
      if (container) container.style.transform = `translateX(-${page() * 100}%)`
    })
  })

  // helper: authoritative max page index (prefer widget.pages())
  const getMaxIndex = () => {
    const widget = selectedWidget()
    try {
      const pagesApi = (widget as any)?.pages as (() => any[]) | undefined
      if (typeof pagesApi === 'function') {
        const entries = pagesApi() ?? []
        if (entries.length > 0) return Math.max(0, entries.length - 1)
      }
    } catch {
      // ignore
    }
    const titlesLen = pageTitles().length
    return Math.max(0, titlesLen - 1)
  }

  // listen for prev/next/set events to update local page state
  onMount(() => {
    const prevHandler = () => setPage((p) => Math.max(0, p - 1))
    const nextHandler = () => {
      const max = getMaxIndex()
      setPage((p) => Math.min(max, p + 1))
    }
    const setHandler = (e: Event) => {
      const ce = e as CustomEvent
      const pg = Number(ce?.detail?.page)
      const max = getMaxIndex()
      if (!Number.isNaN(pg)) setPage(() => Math.max(0, Math.min(pg, max)))
      if (typeof ce?.detail?.title === 'string')
        setPageTitles((titles) => {
          const next = [...titles]
          if (pg >= 0 && pg < next.length) next[pg] = ce.detail.title
          return next
        })
    }
    try {
      window.addEventListener('single-widget:page-prev', prevHandler)
      window.addEventListener('single-widget:page-next', nextHandler)
      window.addEventListener('single-widget:page-set', setHandler as EventListener)
    } catch {}
    onCleanup(() => {
      try {
        window.removeEventListener('single-widget:page-prev', prevHandler)
        window.removeEventListener('single-widget:page-next', nextHandler)
        window.removeEventListener('single-widget:page-set', setHandler as EventListener)
      } catch {}
    })
  })

  createEffect(() => {
    // apply transform when page changes
    const root = singleRoot()
    if (!root) return
    const container = root.querySelector<HTMLElement>('.single-widget-pages')
    if (container) {
      container.style.transition = 'transform 300ms'
      const maxIndex = getMaxIndex()
      const cur = Math.min(Math.max(0, page()), maxIndex)
      container.style.transform = `translateX(-${cur * 100}%)`
    }
  })

  createEffect(() => {
    const widget = selectedWidget()
    if (!widget || !widget.id) return
    const value = Math.max(0, Math.floor(page()))
    persistWidgetPage(widget.id, value)
    updatePageQueryParam(widget.id, value)
  })

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
/* paging container behaviour */
.single-widget-pages { display: flex; width: 100%; height: 100%; }
.single-widget-pages > .single-widget-page { flex: 0 0 100%; width: 100%; }
`}</style>
          <div class="flex flex-col h-full w-full">
            {/* Mobile header with centered minimal swipe zone (middle 50%) */}
            <Show when={!hideSingleHeader()}>
              <div class="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] bg-[var(--bg-muted)]">
              <div class="w-1/4 text-sm font-semibold text-[var(--text-muted)]">
                {selectedWidget() ? selectedWidget()!.title : ''}
              </div>
              <div class="flex items-center justify-center w-1/2 gap-2">
                {page() > 0 ? (
                  <button
                    type="button"
                    class="text-sm rounded p-1"
                    aria-label="Previous page"
                    onTouchStart={(e) => e.stopPropagation()}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    ‹
                  </button>
                ) : (
                  <div class="w-6" />
                )}

                <div
                  class="flex-1 h-8"
                  onTouchStart={(e) => {
                    e.stopPropagation()
                    const te = e as TouchEvent
                    ;(window as any).__singleWidgetTouchStartX = te.touches[0].clientX
                  }}
                  onTouchMove={(e) => {
                    const te = e as TouchEvent
                    ;(window as any).__singleWidgetTouchLastX = te.touches[0].clientX
                  }}
                  onTouchEnd={() => {
                    const start = (window as any).__singleWidgetTouchStartX ?? 0
                    const last = (window as any).__singleWidgetTouchLastX ?? start
                    const delta = last - start
                    const threshold = 50
                    if (delta > threshold) {
                      setPage((p) => Math.max(0, p - 1))
                    } else if (delta < -threshold) {
                      const max = getMaxIndex()
                      setPage((p) => Math.min(max, p + 1))
                    }
                    ;(window as any).__singleWidgetTouchStartX = undefined
                    ;(window as any).__singleWidgetTouchLastX = undefined
                  }}
                  role="group"
                  aria-label="Swipe pages"
                >
                  <div class="h-full flex items-center justify-center text-xs text-[var(--text-muted)]">
                    {(() => {
                      const w = selectedWidget()
                      if (w && typeof (w as any).pages === 'function') {
                        const entries = (w as any).pages() ?? []
                        return entries[page()]?.title ?? `Page ${page() + 1}`
                      }
                      return pageTitles()[page()] ?? 'Pages'
                    })()}
                  </div>
                </div>

                {page() < getMaxIndex() ? (
                  <button
                    type="button"
                    class="text-sm rounded p-1"
                    aria-label="Next page"
                    onTouchStart={(e) => e.stopPropagation()}
                    onClick={() => {
                      const max = getMaxIndex()
                      setPage((p) => Math.min(max, p + 1))
                    }}
                  >
                    ›
                  </button>
                ) : (
                  <div class="w-6" />
                )}
              </div>
              <div class="w-1/4" />
              </div>
            </Show>

            <div class="flex-1 overflow-y-auto overflow-x-hidden">
              <div
                class="single-widget-root w-full max-w-full box-border m-0 p-0"
                ref={(el) => setSingleRoot(el ?? undefined)}
              >
                {selectedWidget() ? (
                  typeof (selectedWidget() as any).pages === 'function' ? (
                    <div
                      class="single-widget-pages flex h-full transition-transform duration-300"
                      style={{ transform: `translateX(-${page() * 100}%)` }}
                    >
                      <For each={(selectedWidget() as any).pages() ?? []}>
                        {(entry) => (
                          <div
                            class="single-widget-page w-full p-4 overflow-auto"
                            data-single-widget-title={entry.title ?? 'Page'}
                          >
                            {entry.content()}
                          </div>
                        )}
                      </For>
                    </div>
                  ) : (
                    <div class="w-full max-w-full box-border">{selectedWidget()!.content?.()}</div>
                  )
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
