export const WORKSPACE_NAVIGATOR_OPEN_EVENT = 'workspace:open-navigator'
export const WORKSPACE_NAVIGATOR_CLOSE_EVENT = 'workspace:close-navigator'

export function dispatchWorkspaceNavigatorOpen() {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent(WORKSPACE_NAVIGATOR_OPEN_EVENT))
  } catch {
    /* ignore */
  }
}

export function dispatchWorkspaceNavigatorClose() {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent(WORKSPACE_NAVIGATOR_CLOSE_EVENT))
  } catch {
    /* ignore */
  }
}
