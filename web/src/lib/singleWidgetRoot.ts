import { createSignal } from 'solid-js'
import type { CanvasWidgetConfig } from '../components/layout/CanvasWorkspace'

export type SingleViewState = {
  storageKey: string
  widgets: CanvasWidgetConfig[]
  onRemoveWidget?: (id: string) => void
} | null

const [state, setState] = createSignal<SingleViewState>(null)

export function openSingleView(payload: {
  storageKey: string
  widgets: CanvasWidgetConfig[]
  onRemoveWidget?: (id: string) => void
}) {
  setState(payload)
}

export function closeSingleView() {
  setState(null)
}

export function useSingleView() {
  return state
}
