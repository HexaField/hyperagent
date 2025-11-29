import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import type { WorkspaceRecord } from '../../../interfaces/core/projects'
import { WIDGET_TEMPLATES, type WidgetAddEventDetail, type WidgetTemplateId } from '../constants/widgetTemplates'
import CanvasWorkspace, { type CanvasWidgetConfig } from '../core/layout/CanvasWorkspace'
import { useCanvasNavigator, type CanvasNavigatorController } from '../core/state/CanvasNavigatorContext'
import { useWorkspaceSelection } from '../core/state/WorkspaceSelectionContext'
import type { SingleWidgetViewDetail } from '../core/state/singleWidgetView'
import { getWidgetDefinition } from '../widgets/registry'

const TEMPLATE_ID_SET = new Set<WidgetTemplateId>(WIDGET_TEMPLATES.map((template) => template.id))
const MOBILE_VIEWPORT_QUERY = '(max-width: 640px)'
const DEFAULT_SINGLE_TEMPLATE_ID = (WIDGET_TEMPLATES[0]?.id ?? 'workspace-summary') as WidgetTemplateId

const singleViewTemplateStorageKey = (workspaceId: string) => `workspace:${workspaceId}:single-template`

function readStoredSingleViewTemplate(workspaceId: string): WidgetTemplateId | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(singleViewTemplateStorageKey(workspaceId))
    if (!raw || !TEMPLATE_ID_SET.has(raw as WidgetTemplateId)) return null
    return raw as WidgetTemplateId
  } catch {
    return null
  }
}

function writeStoredSingleViewTemplate(workspaceId: string, templateId: WidgetTemplateId) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(singleViewTemplateStorageKey(workspaceId), templateId)
  } catch {
    /* ignore */
  }
}

type WidgetInstance = {
  templateId: WidgetTemplateId
  instanceId: string
}

export default function WorkspacePage() {
  const selection = useWorkspaceSelection()
  const navigator = useCanvasNavigator()
  const activeWorkspace = selection.currentWorkspace
  const [widgetInstances, setWidgetInstances] = createSignal<WidgetInstance[]>([])

  const [workspaceViewMode, setWorkspaceViewMode] = createSignal<'canvas' | 'single'>('canvas')
  const [preferredViewMode, setPreferredViewMode] = createSignal<'canvas' | 'single'>('canvas')
  const [isMobileViewport, setIsMobileViewport] = createSignal(
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(MOBILE_VIEWPORT_QUERY).matches
      : false
  )

  const openSingleViewForTemplate = (workspace: WorkspaceRecord, templateId: WidgetTemplateId) => {
    if (typeof window === 'undefined') return
    try {
      const widget = createWidgetConfig({
        templateId,
        workspace,
        instanceId: `single-${templateId}`,
        offsetIndex: 0,
        navigator,
        removable: false
      })
      const detail: SingleWidgetViewDetail = {
        storageKey: `workspace:${workspace.id}`,
        widgets: [widget],
        onRemoveWidget: (id: string) => setWidgetInstances((prev) => prev.filter((entry) => entry.instanceId !== id)),
        workspaceId: workspace.id
      }
      window.__pendingSingleWidgetView = detail
      window.dispatchEvent(new CustomEvent('workspace:open-single-view', { detail }))
    } catch {
      /* ignore */
    }
  }

  // initialize view mode from workspace preference or small screen heuristics
  createEffect(() => {
    const ws = activeWorkspace()
    if (!ws || typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(`workspace:${ws.id}:view`)
      if (raw) {
        try {
          const parsed = JSON.parse(raw)
          if (parsed === 'single') {
            setPreferredViewMode('single')
            return
          }
        } catch {
          if (raw === 'single') {
            setPreferredViewMode('single')
            return
          }
        }
      }
      // no stored preference -> prefer single on small viewports
      if (window.matchMedia && window.matchMedia(MOBILE_VIEWPORT_QUERY).matches) setPreferredViewMode('single')
      else setPreferredViewMode('canvas')
    } catch {
      setPreferredViewMode('canvas')
    }
  })

  createEffect(() => {
    setWorkspaceViewMode(isMobileViewport() ? 'single' : preferredViewMode())
  })

  // when view mode changes, notify the app root to render the single overlay
  createEffect(() => {
    if (typeof window === 'undefined') return
    const ws = activeWorkspace()
    if (!ws) return
    if (workspaceViewMode() === 'single') {
      const storedTemplate = readStoredSingleViewTemplate(ws.id)
      const fallbackTemplate = widgetInstances()[0]?.templateId ?? DEFAULT_SINGLE_TEMPLATE_ID
      const templateId = storedTemplate ?? fallbackTemplate
      if (!storedTemplate) writeStoredSingleViewTemplate(ws.id, templateId)
      openSingleViewForTemplate(ws, templateId)
    } else {
      try {
        window.dispatchEvent(new CustomEvent('workspace:close-single-view'))
      } catch {}
    }
  })

  const widgets = createMemo<CanvasWidgetConfig[]>(() => {
    const workspace = activeWorkspace()
    if (!workspace) return []
    const offsetTracker = new Map<WidgetTemplateId, number>()
    return widgetInstances().map((instance) => {
      const currentOffset = offsetTracker.get(instance.templateId) ?? 0
      offsetTracker.set(instance.templateId, currentOffset + 1)
      return createWidgetConfig({
        templateId: instance.templateId,
        workspace,
        instanceId: instance.instanceId,
        offsetIndex: currentOffset,
        navigator,
        removable: true
      })
    })
  })

  createEffect(() => {
    const workspace = activeWorkspace()
    if (!workspace) return
    if (typeof window === 'undefined') {
      setWidgetInstances(createDefaultWidgetInstances())
      return
    }
    setWidgetInstances(loadWorkspaceWidgetInstances(workspace.id))
  })

  createEffect(() => {
    const workspace = activeWorkspace()
    if (!workspace) return
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(widgetInstanceStorageKey(workspace.id), JSON.stringify(widgetInstances()))
    } catch {
      // ignore storage errors
    }
  })

  onMount(() => {
    if (typeof window === 'undefined') return
    const handleAddWidget = (event: Event) => {
      const custom = event as CustomEvent<WidgetAddEventDetail>
      const detail = custom.detail
      if (!detail || !TEMPLATE_ID_SET.has(detail.templateId)) return
      const workspace = activeWorkspace()
      if (!workspace) return
      const instanceId = generateWidgetInstanceId(detail.templateId)
      setWidgetInstances((prev) => [...prev, { templateId: detail.templateId, instanceId }])
    }
    const handleViewChange = (event: Event) => {
      const custom = event as CustomEvent<{ mode?: string }>
      const detail = custom.detail
      if (!detail || typeof detail.mode !== 'string') return
      const nextMode = detail.mode === 'single' ? 'single' : 'canvas'
      setPreferredViewMode(nextMode)
      const ws = activeWorkspace()
      if (!ws || typeof window === 'undefined') return
      try {
        window.localStorage.setItem(`workspace:${ws.id}:view`, nextMode)
      } catch {
        // ignore storage errors
      }
    }
    const handleOpenSingleWidget = (event: Event) => {
      const custom = event as CustomEvent<{ templateId?: WidgetTemplateId }>
      const detail = custom.detail
      if (!detail || !detail.templateId || !TEMPLATE_ID_SET.has(detail.templateId)) return
      const ws = activeWorkspace()
      if (!ws) return
      writeStoredSingleViewTemplate(ws.id, detail.templateId)
      openSingleViewForTemplate(ws, detail.templateId)
    }
    const mq = window.matchMedia(MOBILE_VIEWPORT_QUERY)
    const updateViewportFlag = () => setIsMobileViewport(mq.matches)
    updateViewportFlag()
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', updateViewportFlag)
    else if (typeof mq.addListener === 'function') mq.addListener(updateViewportFlag)

    window.addEventListener('workspace:add-widget', handleAddWidget)
    window.addEventListener('workspace:view-change', handleViewChange)
    window.addEventListener('workspace:open-single-widget', handleOpenSingleWidget)
    onCleanup(() => {
      if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', updateViewportFlag)
      else if (typeof mq.removeListener === 'function') mq.removeListener(updateViewportFlag)
      window.removeEventListener('workspace:add-widget', handleAddWidget)
      window.removeEventListener('workspace:view-change', handleViewChange)
      window.removeEventListener('workspace:open-single-widget', handleOpenSingleWidget)
    })
  })

  return (
    <div class="relative h-full min-h-screen w-full">
      <Show when={!selection.isLoading()} fallback={<WorkspaceLoadingState />}>
        <Show when={activeWorkspace()} fallback={<WorkspaceEmptyState onOpenNavigator={navigator.open} />}>
          {(workspace) => (
            <Show when={workspaceViewMode() === 'canvas'}>
              <CanvasWorkspace
                storageKey={`workspace:${workspace().id}`}
                widgets={widgets()}
                onRemoveWidget={(id) => {
                  setWidgetInstances((prev) => prev.filter((entry) => entry.instanceId !== id))
                }}
              />
            </Show>
          )}
        </Show>
      </Show>
    </div>
  )
}

const widgetInstanceStorageKey = (workspaceId: string) => `workspace:${workspaceId}:widgets`

function offsetPosition(base: { x: number; y: number }, offsetIndex: number) {
  const step = 40
  return {
    x: base.x + step * offsetIndex,
    y: base.y + step * offsetIndex
  }
}

function createDefaultWidgetInstances(): WidgetInstance[] {
  return WIDGET_TEMPLATES.map((template) => ({ templateId: template.id, instanceId: template.id }))
}

function parseWidgetInstanceList(value: unknown): WidgetInstance[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      if (
        entry &&
        typeof entry === 'object' &&
        'instanceId' in entry &&
        'templateId' in entry &&
        typeof entry.instanceId === 'string' &&
        typeof entry.templateId === 'string' &&
        TEMPLATE_ID_SET.has(entry.templateId as WidgetTemplateId)
      ) {
        return {
          templateId: entry.templateId as WidgetTemplateId,
          instanceId: entry.instanceId
        }
      }
      return null
    })
    .filter((entry): entry is WidgetInstance => Boolean(entry))
}

function loadWorkspaceWidgetInstances(workspaceId: string): WidgetInstance[] {
  if (typeof window === 'undefined') return createDefaultWidgetInstances()
  try {
    const raw = window.localStorage.getItem(widgetInstanceStorageKey(workspaceId))
    if (raw) {
      const parsed = parseWidgetInstanceList(JSON.parse(raw))
      if (parsed.length) return parsed
    }
  } catch {
    // ignore and fall back below
  }
  return createDefaultWidgetInstances()
}

type CreateWidgetConfigOptions = {
  templateId: WidgetTemplateId
  workspace: WorkspaceRecord
  instanceId: string
  offsetIndex: number
  navigator: CanvasNavigatorController
  removable: boolean
}

function createWidgetConfig(options: CreateWidgetConfigOptions): CanvasWidgetConfig {
  const { templateId, workspace, instanceId, offsetIndex, navigator, removable } = options
  const definition = getWidgetDefinition(templateId)
  if (definition) {
    return {
      id: instanceId,
      title: definition.title,
      description: definition.description,
      icon: definition.icon,
      initialPosition: offsetPosition(definition.initialPosition, offsetIndex),
      initialSize: definition.initialSize,
      startOpen: definition.startOpen,
      removable,
      content: () => definition.render({ workspace, navigator })
    }
  }
  return {
    id: instanceId,
    title: templateId,
    initialPosition: offsetPosition({ x: 0, y: 0 }, offsetIndex),
    removable,
    content: () => <div>Unknown widget</div>
  }
}

function generateWidgetInstanceId(templateId: WidgetTemplateId) {
  const uniqueSegment =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  return `${templateId}-${uniqueSegment}`
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
        Use the canvas navigator drawer to register a repository. Once a workspace exists, it becomes the center of
        every workflow, terminal session, and Coding Agent transcript.
      </p>
      <button
        class="rounded-2xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white"
        type="button"
        onClick={props.onOpenNavigator}
      >
        Open navigator
      </button>
    </div>
  )
}
