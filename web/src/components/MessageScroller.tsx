import type { JSX } from 'solid-js'
import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js'
import type { OpencodeMessage as CodingAgentMessage } from '../lib/opencode'
import ToolRenderer from '../lib/ToolRenderer'

export type MessageScrollerProps = {
  messages: CodingAgentMessage[]
  class?: string
  onAutoScrollChange?: (v: boolean) => void
  scrollToBottomTrigger?: number
  debug?: boolean
  sessionId?: string | null
}

export default function MessageScroller(props: MessageScrollerProps) {
  const [container, setContainer] = createSignal<HTMLElement | null>(null)
  const [autoScroll, setAutoScroll] = createSignal(true)
  let lastCount = 0
  let lastMessageKey: string | null = null
  

  // store per-session scroll positions to restore after remount
  const SCROLL_POSITIONS: Map<string, number> = (globalThis as any).__MessageScrollerPositions || new Map()
  try {
    ;(globalThis as any).__MessageScrollerPositions = SCROLL_POSITIONS
  } catch {}
  

  function scrollToBottom(el: HTMLElement, smooth = true) {
    if (!el) return
    try {
      if (!smooth) {
        el.scrollTop = el.scrollHeight
        return
      }
      // Try a smooth scroll then ensure we end at the exact bottom.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          try {
            const last = el.lastElementChild as HTMLElement | null
            if (last && typeof last.scrollIntoView === 'function') {
              last.scrollIntoView({ behavior: 'smooth', block: 'end' })
            } else {
              el.scrollTop = el.scrollHeight
            }
            // After a short delay, force the instant jump to avoid being left slightly above bottom
            setTimeout(() => {
              try {
                el.scrollTop = el.scrollHeight
              } catch {}
            }, 160)
          } catch {}
        })
      })
    } catch {}
  }

  // monitor manual scroll requests
  createEffect(() => {
    const trigger = props.scrollToBottomTrigger ?? 0
    const el = container()
    if (!el) return
    // Clear any persisted scroll position for this session when user requests auto-scroll
    try {
      const sid = props.sessionId
      if (sid) SCROLL_POSITIONS.delete(sid)
    } catch {}
    // Do not change the user's autoScroll preference here.
    // We only clear any persisted scroll position and perform the requested scroll.
    // The parent (OpencodeConsole) is responsible for flipping its own autoScroll state when the user clicks resume.
    // First attempt a smooth scroll then force an instant settle
    scrollToBottom(el, true)
  })

  // mount/unmount and session change logging (debug)
  createEffect(() => {
    const el = container()
    if (!props.debug) return
    if (el) console.debug('[MessageScroller] mounted container', { sessionId: props.sessionId })
    onCleanup(() => {
      try {
        console.debug('[MessageScroller] unmounting container', { sessionId: props.sessionId })
      } catch {}
    })
  })

  // auto-scroll when messages appended
  createEffect(() => {
    const msgs = props.messages ?? []
    const el = container()
    if (!el) return
    const should = autoScroll()
    // derive a stable key for the last message to detect real appends/changes
    const last = msgs.length > 0 ? msgs[msgs.length - 1] : null
    const currentKey = last ? String((last as any).id ?? (last as any).createdAt ?? (last as any).text ?? '') : null
    if (should && currentKey && currentKey !== lastMessageKey) {
      if (props.debug) console.debug('[MessageScroller] auto-scroll on new last message', { currentKey, lastMessageKey })
      // Clear any persisted scroll position for this session since we're auto-scrolling
      try {
        const sid = props.sessionId
        if (sid) SCROLL_POSITIONS.delete(sid)
      } catch {}
      scrollToBottom(el, true)
    }
    lastMessageKey = currentKey
  })

  // track user scrolls and notify parent
  createEffect(() => {
    const el = container()
    if (!el) return
    const handler = () => {
      const distance = Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop)
      const atBottom = distance <= 4
      setAutoScroll(atBottom)
      props.onAutoScrollChange?.(atBottom)
      if (props.debug) console.debug('[MessageScroller] scroll', { distance, atBottom })
      // persist scrollTop per session
      try {
        const sid = props.sessionId
        if (sid) {
          // Only persist when user is not at bottom (we don't need to save bottom)
          if (!atBottom) SCROLL_POSITIONS.set(sid, el.scrollTop)
          else SCROLL_POSITIONS.delete(sid)
        }
      } catch {}
    }
    el.addEventListener('scroll', handler)
    onCleanup(() => el.removeEventListener('scroll', handler))
  })

  // mutation observer for late-layout changes
  createEffect(() => {
    const el = container()
    if (!el) return
    let mo: MutationObserver | null = null
    try {
      mo = new MutationObserver((records) => {
        if (props.debug) console.debug('[MessageScroller] mutation', { recordsLength: records.length })
        if (autoScroll()) scrollToBottom(el, true)
      })
      mo.observe(el, { childList: true, subtree: true, characterData: true })
    } catch {}
    onCleanup(() => {
      try {
        mo?.disconnect()
      } catch {}
    })
  })

  // restore scroll position for session on mount if user had scrolled (and autoScroll is off)
  createEffect(() => {
    const el = container()
    if (!el) return
    const sid = props.sessionId
    if (!sid) return
    try {
      const saved = SCROLL_POSITIONS.get(sid)
      if (saved !== undefined && saved !== null) {
        // restore only when autoScroll is explicitly off
        if (!autoScroll()) {
          // Small double RAF to let layout settle, then restore saved position
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              try {
                el.scrollTop = saved
              } catch {}
            })
          })
        }
      }
    } catch {}
  })

  function renderMetadata(meta: Record<string, unknown>) {
    const entries = Object.entries(meta).filter(([k]) => !['text', 'type', 'start', 'end', 'id'].includes(k))
    if (entries.length === 0) return null
    return (
      <div class="mt-1 rounded-md bg-[var(--bg-muted)] p-2 text-xs text-[var(--text-muted)]">
        {entries.map(([k, v]) => (
          <div>
            <span class="font-semibold">{k}:</span>{' '}
            {typeof v === 'object' && v !== null ? (
              <pre class="whitespace-pre-wrap rounded bg-[var(--bg-card)] p-2 text-xs">{JSON.stringify(v, null, 2)}</pre>
            ) : (
              <span>{String(v)}</span>
            )}
          </div>
        ))}
      </div>
    )
  }

  function renderMessageParts(message: CodingAgentMessage) {
    const parts: any[] = (message as any).parts ?? []
    if (!parts || parts.length === 0) {
      return message.text.split('\n').map((line) => <p class="mb-1 last:mb-0 break-words">{line}</p>)
    }
    const elements: JSX.Element[] = []
    for (const part of parts) {
      if (!part) continue
      if (part.type === 'text' || part.type === 'step-finish') {
        if (typeof part.text === 'string' && part.text.trim()) {
          elements.push(<p class="mb-1 last:mb-0 break-words">{part.text.trim()}</p>)
        }
        continue
      }
      if (part.type === 'tool') {
        const text = typeof part.text === 'string' && part.text.trim() ? part.text.trim() : null
        const output = typeof (part.state?.output ?? part.output) === 'string' ? (part.state?.output ?? part.output) : null
        if (output || text) {
          elements.push(<ToolRenderer part={part} />)
        }
        continue
      }
      if (part.type === 'file-diff' || part.type === 'diff') {
        elements.push(<p class="mb-1 last:mb-0 break-words">[diff]</p>)
        continue
      }
    }
    if (elements.length === 0) return null
    return elements
  }

  return (
    <div ref={(el) => setContainer(el ?? null)} class={props.class ?? ''}>
      <For each={props.messages}>
        {(message) => (
          <article class="rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-4">
            <header class="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
              <span class="uppercase tracking-wide">{message.role}</span>
              <span>{new Date(message.createdAt).toLocaleString()}</span>
            </header>
            <div class="whitespace-pre-wrap text-[var(--text)] break-words text-sm">{renderMessageParts(message)}</div>
            <Show when={(message as any).meta} keyed>
              {(meta) => renderMetadata(meta as Record<string, unknown>)}
            </Show>
          </article>
        )}
      </For>
    </div>
  )
}
