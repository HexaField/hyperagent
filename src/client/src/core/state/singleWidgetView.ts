import type { CanvasWidgetConfig } from '../layout/CanvasWorkspace'

export type SingleWidgetViewDetail = {
  storageKey: string
  widgets: CanvasWidgetConfig[]
  onRemoveWidget?: (id: string) => void
  workspaceId?: string
}

declare global {
  interface Window {
    __singleWidgetViewActive?: boolean
    __pendingSingleWidgetView?: SingleWidgetViewDetail | null
  }
}

export {}
