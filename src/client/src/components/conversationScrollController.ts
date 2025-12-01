import { createSignal } from 'solid-js'

const normalizeKey = (value: string | number | null | undefined): string | null => {
  if (value === undefined || value === null) return null
  const text = String(value)
  return text.length > 0 ? text : null
}

export function createConversationScrollController() {
  const [autoScrollEnabled, setAutoScrollEnabled] = createSignal(true)
  const [scrollSignal, setScrollSignal] = createSignal(0)
  let lastContextKey: string | null = null
  let lastMessageKey: string | null = null

  const requestScroll = () => setScrollSignal((value) => value + 1)

  const handleAutoScrollChange = (value: boolean) => {
    setAutoScrollEnabled(value)
  }

  const notifyLatestKey = (key?: string | number | null) => {
    const normalized = normalizeKey(key)
    if (normalized === null) {
      lastMessageKey = null
      return
    }
    if (normalized === lastMessageKey) return
    lastMessageKey = normalized
    if (autoScrollEnabled()) {
      requestScroll()
    }
  }

  const requestScrollIfAuto = () => {
    if (!autoScrollEnabled()) return
    requestScroll()
  }

  const setContext = (key?: string | number | null) => {
    const normalized = normalizeKey(key)
    if (normalized === lastContextKey) return
    lastContextKey = normalized
    lastMessageKey = null
    setAutoScrollEnabled(true)
    requestScroll()
  }

  return {
    autoScrollEnabled,
    scrollSignal,
    handleAutoScrollChange,
    notifyLatestKey,
    requestScrollIfAuto,
    setContext
  }
}
