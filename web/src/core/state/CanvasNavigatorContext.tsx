import { Accessor, createContext, useContext } from 'solid-js'

export type CanvasNavigatorController = {
  isOpen: Accessor<boolean>
  open: () => void
  close: () => void
  toggle: () => void
}

const noop = () => undefined
const fallbackAccessor: Accessor<boolean> = () => false

export const CanvasNavigatorContext = createContext<CanvasNavigatorController>({
  isOpen: fallbackAccessor,
  open: noop,
  close: noop,
  toggle: noop
})

export const useCanvasNavigator = () => useContext(CanvasNavigatorContext)
