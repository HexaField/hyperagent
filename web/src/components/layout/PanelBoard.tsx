import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from 'solid-js'

export type PanelRect = {
  x: number
  y: number
  width: number
  height: number
}

export type PanelConfig = {
  id: string
  title: string
  description?: string
  defaultRect: PanelRect
  minWidth?: number
  minHeight?: number
  headerActions?: () => JSX.Element
  content: () => JSX.Element
}

export type PanelBoardProps = {
  storageKey: string
  panels: PanelConfig[]
  class?: string
}

type PanelState = {
  rect: PanelRect
  collapsed: boolean
}

const MIN_WIDTH_PX = 320
const MIN_HEIGHT_PX = 260
const FALLBACK_RECT: PanelRect = { x: 5, y: 5, width: 40, height: 40 }

export default function PanelBoard(props: PanelBoardProps) {
  const resolvedStorageKey = () => `panel-board:${props.storageKey || 'default'}`
  const panelList = createMemo(() => props.panels ?? [])
  const [state, setState] = createSignal<Record<string, PanelState>>({})
  const [maximizedId, setMaximizedId] = createSignal<string | null>(null)
  const [zIndices, setZIndices] = createSignal<Record<string, number>>({})
  const [zCursor, setZCursor] = createSignal(20)
  const [hydrated, setHydrated] = createSignal(false)
  const [activeStorageKey, setActiveStorageKey] = createSignal(resolvedStorageKey())
  const [boardSize, setBoardSize] = createSignal({ width: 1200, height: 900 })
  const [viewportHeight, setViewportHeight] = createSignal(900)
  let resizeObserver: ResizeObserver | undefined
  let cachedLayouts: Record<string, PanelState> | null = null

  const applyCachedLayouts = () => {
    if (!cachedLayouts) return
    const entries = panelList()
    if (!entries.length) return
    const snapshot = cachedLayouts
    cachedLayouts = null
    setState((prev) => {
      const next: Record<string, PanelState> = { ...prev }
      entries.forEach((panel) => {
        const saved = snapshot[panel.id]
        if (!saved) return
        next[panel.id] = {
          rect: sanitizeRect(saved.rect ?? panel.defaultRect, panel),
          collapsed: Boolean(saved.collapsed)
        }
      })
      return next
    })
  }

  createEffect(() => {
    const entries = panelList()
    if (!entries.length) return
    setState((prev) => {
      let changed = false
      const next: Record<string, PanelState> = { ...prev }
      entries.forEach((panel) => {
        if (!next[panel.id]) {
          next[panel.id] = {
            rect: { ...panel.defaultRect },
            collapsed: false
          }
          changed = true
        }
      })
      return changed ? next : prev
    })
    applyCachedLayouts()
    setZIndices((prev) => {
      let changed = false
      const next: Record<string, number> = { ...prev }
      entries.forEach((panel, index) => {
        if (next[panel.id]) return
        next[panel.id] = index + 1
        changed = true
      })
      return changed ? next : prev
    })
  })

  const persistableState = createMemo(() => {
    const output: Record<string, PanelState> = {}
    const entries = panelList()
    const current = state()
    entries.forEach((panel) => {
      if (!current[panel.id]) return
      output[panel.id] = {
        rect: { ...current[panel.id].rect },
        collapsed: current[panel.id].collapsed
      }
    })
    return output
  })

  const loadFromStorage = (key: string) => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(key)
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<string, PanelState>
      if (!parsed || typeof parsed !== 'object') return
      cachedLayouts = parsed
      applyCachedLayouts()
    } catch (error) {
      console.warn('Failed to load panel layout', error)
    }
  }

  const saveToStorage = () => {
    if (!hydrated()) return
    if (typeof window === 'undefined') return
    const snapshot = persistableState()
    try {
      window.localStorage.setItem(activeStorageKey(), JSON.stringify(snapshot))
    } catch (error) {
      console.warn('Failed to persist panel layout', error)
    }
  }

  onMount(() => {
    setHydrated(true)
    const key = resolvedStorageKey()
    setActiveStorageKey(key)
    loadFromStorage(key)
    const handleResize = () => {
      if (typeof window === 'undefined') return
      setViewportHeight(window.innerHeight || 900)
    }
    handleResize()
    window.addEventListener('resize', handleResize)
    onCleanup(() => window.removeEventListener('resize', handleResize))
  })

  createEffect(() => {
    if (!hydrated()) return
    const key = resolvedStorageKey()
    if (key === activeStorageKey()) return
    setActiveStorageKey(key)
    loadFromStorage(key)
  })

  createEffect(saveToStorage)

  createEffect(() => {
    if (typeof document === 'undefined') return
    const target = document.body
    if (maximizedId()) {
      const previous = target.style.overflow
      target.style.overflow = 'hidden'
      onCleanup(() => {
        target.style.overflow = previous
      })
    }
  })

  const assignBoardRef = (element?: HTMLDivElement) => {
    resizeObserver?.disconnect()
    if (!element) return
    resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      setBoardSize({ width: width || 1, height: height || 1 })
    })
    resizeObserver.observe(element)
  }

  onCleanup(() => resizeObserver?.disconnect())

  const boardHeight = createMemo(() => Math.max(viewportHeight() - 240, 760))

  const bringToFront = (panelId: string) => {
    setZIndices((prev) => ({ ...prev, [panelId]: zCursor() + 1 }))
    setZCursor((value) => value + 1)
  }

  const toggleCollapse = (panelId: string) => {
    updatePanelState(panelId, (current, panel) => ({
      ...current,
      collapsed: !current.collapsed,
      rect: clampRect(current.rect, panel)
    }))
  }

  const toggleMaximize = (panelId: string) => {
    setMaximizedId((current) => (current === panelId ? null : panelId))
    bringToFront(panelId)
  }

  const startDrag = (panel: PanelConfig, event: PointerEvent) => {
    if (maximizedId() && maximizedId() !== panel.id) return
    event.preventDefault()
    bringToFront(panel.id)
    const pointerId = event.pointerId
    const startX = event.clientX
    const startY = event.clientY
    const initialRect = getPanelRect(panel.id)
    const size = boardSize()

    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      const deltaX = moveEvent.clientX - startX
      const deltaY = moveEvent.clientY - startY
      const deltaPercentX = size.width ? (deltaX / size.width) * 100 : 0
      const deltaPercentY = size.height ? (deltaY / size.height) * 100 : 0
      const nextRect: PanelRect = {
        ...initialRect,
        x: initialRect.x + deltaPercentX,
        y: initialRect.y + deltaPercentY
      }
      setPanelRect(panel, nextRect)
    }

    const stop = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', stop)
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', stop)
  }

  const startResize = (panel: PanelConfig, event: PointerEvent) => {
    if (maximizedId() && maximizedId() !== panel.id) return
    event.preventDefault()
    event.stopPropagation()
    bringToFront(panel.id)
    const pointerId = event.pointerId
    const startX = event.clientX
    const startY = event.clientY
    const initialRect = getPanelRect(panel.id)
    const size = boardSize()

    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      const deltaX = moveEvent.clientX - startX
      const deltaY = moveEvent.clientY - startY
      const nextRect: PanelRect = {
        ...initialRect,
        width: initialRect.width + (size.width ? (deltaX / size.width) * 100 : 0),
        height: initialRect.height + (size.height ? (deltaY / size.height) * 100 : 0)
      }
      setPanelRect(panel, nextRect)
    }

    const stop = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', stop)
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', stop)
  }

  const setPanelRect = (panel: PanelConfig, rect: PanelRect) => {
    updatePanelState(panel.id, (current) => ({
      ...current,
      rect: clampRect(rect, panel)
    }))
  }

  const getPanelRect = (panelId: string): PanelRect => state()[panelId]?.rect ?? getPanelDefaults(panelId, (panel) => panel.defaultRect)

  const updatePanelState = (
    panelId: string,
    mutation: (current: PanelState, panel: PanelConfig) => PanelState
  ) => {
    const panel = panelList().find((entry) => entry.id === panelId)
    if (!panel) return
    setState((prev) => {
      const current = prev[panelId] ?? {
        rect: { ...panel.defaultRect },
        collapsed: false
      }
      const next = mutation(current, panel)
      return { ...prev, [panelId]: next }
    })
  }

  const getPanelDefaults = (panelId: string, selector: (panel: PanelConfig) => PanelRect): PanelRect => {
    const panel = panelList().find((entry) => entry.id === panelId)
    return panel ? { ...selector(panel) } : { ...FALLBACK_RECT }
  }

  const clampRect = (rect: PanelRect, panel: PanelConfig): PanelRect => {
    const size = boardSize()
    const widthPercent = Math.max(size.width || 1, 1)
    const heightPercent = Math.max(size.height || 1, 1)
    const minWidthPercent = Math.min(100, Math.max(((panel.minWidth ?? MIN_WIDTH_PX) / widthPercent) * 100, 12))
    const minHeightPercent = Math.min(100, Math.max(((panel.minHeight ?? MIN_HEIGHT_PX) / heightPercent) * 100, 15))
    const width = clamp(rect.width, minWidthPercent, 100)
    const height = clamp(rect.height, minHeightPercent, 100)
    const maxX = Math.max(0, 100 - width)
    const maxY = Math.max(0, 100 - height)
    return {
      x: clamp(rect.x, 0, maxX),
      y: clamp(rect.y, 0, maxY),
      width,
      height
    }
  }

  const clamp = (value: number, min: number, max: number) => {
    if (Number.isNaN(value)) return min
    return Math.min(Math.max(value, min), max)
  }

  const sanitizeRect = (input: PanelRect | undefined, panel: PanelConfig): PanelRect => {
    if (!input) return { ...panel.defaultRect }
    return clampRect(
      {
        x: typeof input.x === 'number' ? input.x : panel.defaultRect.x,
        y: typeof input.y === 'number' ? input.y : panel.defaultRect.y,
        width: typeof input.width === 'number' ? input.width : panel.defaultRect.width,
        height: typeof input.height === 'number' ? input.height : panel.defaultRect.height
      },
      panel
    )
  }

  if (!panelList().length) {
    return <div class={props.class ?? ''} />
  }

  return (
    <div class={`relative w-full ${props.class ?? ''}`} style={{ height: `${boardHeight()}px`, 'min-height': '760px' }} ref={assignBoardRef}>
      <Show when={maximizedId()}>
        <div class="pointer-events-none fixed inset-0 z-40 bg-slate-950/50 backdrop-blur-sm" />
      </Show>
      <For each={panelList()}>
        {(panel) => {
          const panelState = () => state()[panel.id] ?? { rect: { ...panel.defaultRect }, collapsed: false }
          const isMaximized = () => maximizedId() === panel.id
          const panelStyle = createMemo(() => {
            if (isMaximized()) {
              return {
                left: '2%',
                top: '2%',
                width: '96%',
                height: '96%'
              }
            }
            const rect = panelState().rect
            return {
              left: `${rect.x}%`,
              top: `${rect.y}%`,
              width: `${rect.width}%`,
              height: `${rect.height}%`
            }
          })
          const hidden = () => maximizedId() !== null && maximizedId() !== panel.id
          const zIndex = () => (isMaximized() ? 100 : zIndices()[panel.id] ?? 1)
          return (
            <div
              class="absolute flex flex-col gap-4 rounded-[1.25rem] border border-[var(--border)] bg-[var(--bg-card)] p-5 shadow-[0_18px_30px_rgba(15,23,42,0.12)]"
              style={{ ...panelStyle(), 'z-index': zIndex() }}
              classList={{ hidden: hidden() }}
              onPointerDown={() => bringToFront(panel.id)}
            >
              <header
                class="flex cursor-move flex-wrap items-start justify-between gap-4"
                onPointerDown={(event) => startDrag(panel, event)}
              >
                <div class="flex-1 space-y-1">
                  <h2 class="text-lg font-semibold text-[var(--text)]">{panel.title}</h2>
                  <Show when={panel.description}>
                    {(desc) => <p class="text-sm text-[var(--text-muted)]">{desc()}</p>}
                  </Show>
                </div>
                <div class="flex flex-wrap items-center gap-2" onPointerDown={(event) => event.stopPropagation()}>
                  {panel.headerActions && <div class="flex items-center gap-2">{panel.headerActions()}</div>}
                  <button
                    type="button"
                    class="rounded-xl border border-[var(--border)] px-3 py-1 text-xs font-semibold"
                    onClick={() => toggleMaximize(panel.id)}
                  >
                    {isMaximized() ? 'Exit full view' : 'Maximize'}
                  </button>
                  <button
                    type="button"
                    class="rounded-xl border border-[var(--border)] px-3 py-1 text-xs font-semibold"
                    onClick={() => toggleCollapse(panel.id)}
                  >
                    {panelState().collapsed ? 'Expand' : 'Collapse'}
                  </button>
                </div>
              </header>
              <Show
                when={!panelState().collapsed}
                fallback={
                  <div class="rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-muted)] p-4 text-sm text-[var(--text-muted)]">
                    {panel.description ?? `${panel.title} panel is collapsed. Expand it to continue.`}
                  </div>
                }
              >
                <div class="flex-1 overflow-auto">{panel.content()}</div>
              </Show>
              <button
                type="button"
                class="absolute bottom-3 right-3 flex h-6 w-6 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-muted)] text-xs text-[var(--text-muted)]"
                onPointerDown={(event) => startResize(panel, event)}
                aria-label="Resize panel"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 12 12"
                  class="h-3 w-3 text-[var(--text-muted)]"
                  aria-hidden="true"
                >
                  <path
                    d="M1 11l4-4m0 4l6-6m0 6V5H7"
                    stroke="currentColor"
                    stroke-width="1.4"
                    fill="none"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
            </div>
          )
        }}
      </For>
    </div>
  )
}
