import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from 'solid-js'

export type CanvasVector = {
  x: number
  y: number
}

export type CanvasSize = {
  width: number
  height: number
}

export type CanvasWidgetConfig = {
  id: string
  title: string
  description?: string
  initialPosition: CanvasVector
  initialSize?: CanvasSize
  minWidth?: number
  minHeight?: number
  startOpen?: boolean
  icon?: string
  headerActions?: () => JSX.Element
  content: () => JSX.Element
}

export type CanvasWorkspaceProps = {
  storageKey: string
  widgets: CanvasWidgetConfig[]
  class?: string
}

type CanvasWidgetState = {
  position: CanvasVector
  size: CanvasSize
  visible: boolean
}

type CanvasTransform = {
  x: number
  y: number
  scale: number
}

type CanvasWorkspaceSnapshot = {
  widgets?: Record<string, CanvasWidgetState>
  transform?: CanvasTransform
}

const DEFAULT_WIDGET_SIZE: CanvasSize = { width: 640, height: 420 }
const DEFAULT_TRANSFORM: CanvasTransform = { x: 0, y: 0, scale: 1 }
const MIN_SCALE = 0.5
const MAX_SCALE = 1.75

export default function CanvasWorkspace(props: CanvasWorkspaceProps) {
  const widgetList = createMemo(() => props.widgets ?? [])
  const storageKey = () => `canvas-workspace:${props.storageKey || 'default'}`
  const [hydrated, setHydrated] = createSignal(false)
  const [widgetState, setWidgetState] = createSignal<Record<string, CanvasWidgetState>>({})
  const [zIndices, setZIndices] = createSignal<Record<string, number>>({})
  const [zCursor, setZCursor] = createSignal(25)
  const [transform, setTransform] = createSignal<CanvasTransform>({ ...DEFAULT_TRANSFORM })
  let pendingSnapshot: CanvasWorkspaceSnapshot | null = null
  let panPointerId: number | null = null
  let panAnchorPoint: CanvasVector | null = null
  let panAnchorTransform: CanvasTransform | null = null

  const persistableState = createMemo<CanvasWorkspaceSnapshot>(() => {
    const snapshot: CanvasWorkspaceSnapshot = {
      widgets: {},
      transform: transform()
    }
    const entries = widgetState()
    Object.keys(entries).forEach((widgetId) => {
      snapshot.widgets![widgetId] = {
        position: { ...entries[widgetId].position },
        size: { ...entries[widgetId].size },
        visible: entries[widgetId].visible
      }
    })
    return snapshot
  })

  const applySnapshot = (snapshot: CanvasWorkspaceSnapshot) => {
    if (snapshot.transform) {
      setTransform(normalizeTransform(snapshot.transform))
    }
    if (snapshot.widgets) {
      setWidgetState((prev) => {
        const next = { ...prev }
        widgetList().forEach((widget) => {
          const stored = snapshot.widgets?.[widget.id]
          if (!stored) return
          next[widget.id] = {
            position: sanitizeVector(stored.position, widget.initialPosition),
            size: sanitizeSize(stored.size, widget),
            visible: typeof stored.visible === 'boolean' ? stored.visible : widget.startOpen !== false
          }
        })
        return next
      })
    }
  }

  const loadFromStorage = (key?: string) => {
    if (typeof window === 'undefined') return
    try {
      const resolvedKey = key ?? storageKey()
      const raw = window.localStorage.getItem(resolvedKey)
      if (!raw) return
      const parsed = JSON.parse(raw) as CanvasWorkspaceSnapshot
      if (!parsed || typeof parsed !== 'object') return
      if (!hydrated()) {
        pendingSnapshot = parsed
      } else {
        applySnapshot(parsed)
      }
    } catch (error) {
      console.warn('Failed to load canvas workspace', error)
    }
  }

  const saveToStorage = () => {
    if (!hydrated()) return
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(storageKey(), JSON.stringify(persistableState()))
    } catch (error) {
      console.warn('Failed to persist canvas workspace', error)
    }
  }

  createEffect(() => {
    const widgets = widgetList()
    if (!widgets.length) return
    setWidgetState((prev) => {
      let changed = false
      const next = { ...prev }
      widgets.forEach((widget) => {
        if (!next[widget.id]) {
          next[widget.id] = {
            position: { ...widget.initialPosition },
            size: { ...(widget.initialSize ?? DEFAULT_WIDGET_SIZE) },
            visible: widget.startOpen !== false
          }
          changed = true
        }
      })
      return changed ? next : prev
    })
    setZIndices((prev) => {
      let changed = false
      const next = { ...prev }
      widgets.forEach((widget, index) => {
        if (next[widget.id]) return
        next[widget.id] = index + 1
        changed = true
      })
      return changed ? next : prev
    })
    if (pendingSnapshot) {
      applySnapshot(pendingSnapshot)
      pendingSnapshot = null
    }
  })

  onMount(() => {
    setHydrated(true)
    loadFromStorage()
  })

  createEffect(() => {
    if (!hydrated()) return
    const key = storageKey()
    loadFromStorage(key)
  })

  createEffect(saveToStorage)

  const bringToFront = (widgetId: string) => {
    setZIndices((prev) => ({ ...prev, [widgetId]: zCursor() + 1 }))
    setZCursor((value) => value + 1)
  }

  const getWidgetState = (id: string) => {
    const current = widgetState()[id]
    if (current) return current
    const fallback = widgetList().find((entry) => entry.id === id)
    if (!fallback) {
      return {
        position: { x: 0, y: 0 },
        size: { ...DEFAULT_WIDGET_SIZE },
        visible: true
      }
    }
    return {
      position: { ...fallback.initialPosition },
      size: { ...(fallback.initialSize ?? DEFAULT_WIDGET_SIZE) },
      visible: fallback.startOpen !== false
    }
  }

  const setWidgetVisibility = (id: string, visible: boolean) => {
    setWidgetState((prev) => {
      const current = getWidgetState(id)
      return {
        ...prev,
        [id]: {
          ...current,
          visible
        }
      }
    })
  }

  const closeWidget = (id: string) => setWidgetVisibility(id, false)

  const openWidget = (id: string) => {
    setWidgetVisibility(id, true)
    bringToFront(id)
  }

  const toggleWidgetVisibility = (id: string) => {
    const current = getWidgetState(id)
    if (current.visible) {
      closeWidget(id)
    } else {
      openWidget(id)
    }
  }

  const setWidgetPosition = (id: string, position: CanvasVector) => {
    setWidgetState((prev) => {
      const current = getWidgetState(id)
      return {
        ...prev,
        [id]: {
          ...current,
          position: {
            x: position.x,
            y: position.y
          }
        }
      }
    })
  }

  const setWidgetSize = (id: string, size: CanvasSize, widget: CanvasWidgetConfig) => {
    const minWidth = widget.minWidth ?? 360
    const minHeight = widget.minHeight ?? 260
    setWidgetState((prev) => {
      const current = getWidgetState(id)
      return {
        ...prev,
        [id]: {
          ...current,
          size: {
            width: Math.max(size.width, minWidth),
            height: Math.max(size.height, minHeight)
          }
        }
      }
    })
  }

  const startWidgetDrag = (widget: CanvasWidgetConfig, event: PointerEvent) => {
    event.preventDefault()
    bringToFront(widget.id)
    const pointerId = event.pointerId
    const startPosition = { ...getWidgetState(widget.id).position }
    const startX = event.clientX
    const startY = event.clientY
    const initialScale = transform().scale

    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      const deltaX = (moveEvent.clientX - startX) / initialScale
      const deltaY = (moveEvent.clientY - startY) / initialScale
      setWidgetPosition(widget.id, {
        x: startPosition.x + deltaX,
        y: startPosition.y + deltaY
      })
    }

    const stop = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', stop)
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', stop)
  }

  const startWidgetResize = (widget: CanvasWidgetConfig, event: PointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    bringToFront(widget.id)
    const pointerId = event.pointerId
    const startSize = { ...getWidgetState(widget.id).size }
    const startX = event.clientX
    const startY = event.clientY
    const initialScale = transform().scale

    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      const deltaX = (moveEvent.clientX - startX) / initialScale
      const deltaY = (moveEvent.clientY - startY) / initialScale
      setWidgetSize(
        widget.id,
        {
          width: startSize.width + deltaX,
          height: startSize.height + deltaY
        },
        widget
      )
    }

    const stop = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', stop)
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', stop)
  }

  const handleCanvasPointerDown = (event: PointerEvent) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-widget-id]')) return
    if (event.button !== 0) return
    panPointerId = event.pointerId
    panAnchorPoint = { x: event.clientX, y: event.clientY }
    panAnchorTransform = { ...transform() }
    window.addEventListener('pointermove', handlePanMove)
    window.addEventListener('pointerup', stopPan)
  }

  const handlePanMove = (event: PointerEvent) => {
    if (event.pointerId !== panPointerId) return
    if (!panAnchorPoint || !panAnchorTransform) return
    const deltaX = event.clientX - panAnchorPoint.x
    const deltaY = event.clientY - panAnchorPoint.y
    setTransform((prev) => ({
      ...prev,
      x: panAnchorTransform!.x + deltaX,
      y: panAnchorTransform!.y + deltaY
    }))
  }

  const stopPan = (event: PointerEvent) => {
    if (event.pointerId !== panPointerId) return
    window.removeEventListener('pointermove', handlePanMove)
    window.removeEventListener('pointerup', stopPan)
    panPointerId = null
    panAnchorPoint = null
    panAnchorTransform = null
  }

  const handleWheel = (event: WheelEvent) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-widget-id]')) return
    event.preventDefault()
    const delta = event.deltaY > 0 ? -0.08 : 0.08
    setTransform((prev) => ({
      ...prev,
      scale: clamp(prev.scale + delta, MIN_SCALE, MAX_SCALE)
    }))
  }

  onCleanup(() => {
    window.removeEventListener('pointermove', handlePanMove)
    window.removeEventListener('pointerup', stopPan)
  })

  return (
    <div
      class={`relative h-full w-full overflow-hidden bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-900 ${props.class ?? ''}`}
      onPointerDown={handleCanvasPointerDown}
      onWheel={handleWheel}
    >
      <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.12)_1px,transparent_0)] bg-[length:80px_80px] opacity-60" />
      <div
        class="absolute inset-0"
        style={{
          transform: `translate(${transform().x}px, ${transform().y}px) scale(${transform().scale})`,
          'transform-origin': '0 0'
        }}
      >
        <For each={widgetList()}>
          {(widget) => {
            const state = () => getWidgetState(widget.id)
            const zIndex = () => zIndices()[widget.id] ?? 1
            return (
              <Show when={state().visible}>
                <div
                  data-widget-id={widget.id}
                  class="absolute flex flex-col rounded-[1.25rem] border border-[var(--border)] bg-[var(--bg-card)]/95 p-5 text-[var(--text)] shadow-[0_18px_30px_rgba(15,23,42,0.45)] backdrop-blur"
                  style={{
                    left: `${state().position.x}px`,
                    top: `${state().position.y}px`,
                    width: `${state().size.width}px`,
                    height: `${state().size.height}px`,
                    'z-index': zIndex()
                  }}
                  onPointerDown={() => bringToFront(widget.id)}
                >
                  <header
                    class="mb-4 flex cursor-move flex-wrap items-start justify-between gap-3"
                    onPointerDown={(event) => startWidgetDrag(widget, event)}
                  >
                    <div class="space-y-1">
                      <p class="text-xs uppercase tracking-[0.25em] text-[var(--text-muted)]">{widget.title}</p>
                      <Show when={widget.description}>
                        {(desc) => <p class="text-sm text-[var(--text-muted)]">{desc()}</p>}
                      </Show>
                    </div>
                    <div class="flex flex-wrap items-center gap-2" onPointerDown={(event) => event.stopPropagation()}>
                      {widget.headerActions && widget.headerActions()}
                      <button
                        type="button"
                        class="rounded-full border border-[var(--border)] px-2 py-1 text-xs font-semibold"
                        onClick={() => closeWidget(widget.id)}
                      >
                        Close
                      </button>
                    </div>
                  </header>
                  <div class="flex-1 overflow-auto">{widget.content()}</div>
                  <button
                    type="button"
                    class="absolute bottom-3 right-3 flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-muted)] text-xs text-[var(--text-muted)]"
                    onPointerDown={(event) => startWidgetResize(widget, event)}
                    aria-label="Resize widget"
                  >
                    ⇲
                  </button>
                </div>
              </Show>
            )
          }}
        </For>
      </div>
      <div class="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
        <div class="pointer-events-auto flex flex-wrap items-center gap-3 rounded-full border border-[var(--border)] bg-[var(--bg-card)]/90 px-5 py-3 text-sm text-[var(--text)] shadow-[0_18px_30px_rgba(15,23,42,0.2)] backdrop-blur">
          <For each={widgetList()}>
            {(widget) => {
              const state = () => getWidgetState(widget.id)
              return (
                <button
                  type="button"
                  class="flex items-center gap-2 rounded-full border border-[var(--border)] px-3 py-1"
                  classList={{ 'bg-blue-600 text-white': state().visible }}
                  onClick={() => toggleWidgetVisibility(widget.id)}
                >
                  <span class="text-base">{widget.icon ?? '◎'}</span>
                  <span class="text-xs font-semibold uppercase tracking-[0.2em]">{widget.title}</span>
                </button>
              )
            }}
          </For>
        </div>
      </div>
    </div>
  )
}

const sanitizeVector = (value: CanvasVector | undefined, fallback: CanvasVector): CanvasVector => {
  if (!value) return { ...fallback }
  const x = Number.isFinite(value.x) ? value.x : fallback.x
  const y = Number.isFinite(value.y) ? value.y : fallback.y
  return { x, y }
}

const sanitizeSize = (value: CanvasSize | undefined, widget: CanvasWidgetConfig): CanvasSize => {
  const fallback = widget.initialSize ?? DEFAULT_WIDGET_SIZE
  if (!value) return { ...fallback }
  const width = Number.isFinite(value.width) ? value.width : fallback.width
  const height = Number.isFinite(value.height) ? value.height : fallback.height
  return {
    width: Math.max(width, widget.minWidth ?? 360),
    height: Math.max(height, widget.minHeight ?? 260)
  }
}

const normalizeTransform = (value: CanvasTransform): CanvasTransform => ({
  x: Number.isFinite(value.x) ? value.x : DEFAULT_TRANSFORM.x,
  y: Number.isFinite(value.y) ? value.y : DEFAULT_TRANSFORM.y,
  scale: clamp(Number.isFinite(value.scale) ? value.scale : DEFAULT_TRANSFORM.scale, MIN_SCALE, MAX_SCALE)
})

const clamp = (value: number, min: number, max: number) => {
  if (Number.isNaN(value)) return min
  return Math.min(Math.max(value, min), max)
}
