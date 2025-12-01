import type { JSX } from 'solid-js'
import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js'
import type { CodingAgentMessage, CodingAgentMessagePart } from '../lib/codingAgent'
import { extractDiffText, extractToolCalls } from '../lib/messageParts'
import ToolRenderer from '../lib/ToolRenderer'
import DiffViewer from './DiffViewer'
import TodoList from './TodoList'
import ToolCallList from './ToolCallList'

export type MessageScrollerProps = {
  messages: CodingAgentMessage[]
  class?: string
  onAutoScrollChange?: (v: boolean) => void
  scrollToBottomTrigger?: number
  sessionId?: string | null
  onMessageClick?: (message: CodingAgentMessage) => void
  selectedMessageId?: string | null
}

export default function MessageScroller(props: MessageScrollerProps) {
  const [container, setContainer] = createSignal<HTMLElement | null>(null)
  const [autoScroll, setAutoScroll] = createSignal(true)
  const [copiedTargetKey, setCopiedTargetKey] = createSignal<string | null>(null)
  const [selectionMenu, setSelectionMenu] = createSignal<{ text: string } | null>(null)
  let lastMessageKey: string | null = null
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined

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
    const el = container()
    if (!el) return
    // Clear any persisted scroll position for this session when user requests auto-scroll
    try {
      const sid = props.sessionId
      if (sid) SCROLL_POSITIONS.delete(sid)
    } catch {}
    // Do not change the user's autoScroll preference here.
    // We only clear any persisted scroll position and perform the requested scroll.
    // The parent (CodingAgentConsole) is responsible for flipping its own autoScroll state when the user clicks resume.
    // First attempt a smooth scroll then force an instant settle
    scrollToBottom(el, true)
  })

  onCleanup(() => {
    if (typeof window !== 'undefined' && copyResetTimer) {
      clearTimeout(copyResetTimer)
    }
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
      mo = new MutationObserver(() => {
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

  type DetailsToggleProps = {
    summaryText: string
    duration?: string
    title?: string
    children?: any
    copyHint?: { payload: string; key: string }
  }

  function DetailsWithToggle(props: DetailsToggleProps) {
    const [open, setOpen] = createSignal(false)
    return (
      <details
        class="mb-2 rounded-md border border-[var(--border)] bg-[var(--bg-card)]"
        open={false}
        onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary class="px-3 py-2 cursor-pointer flex items-center justify-between">
          <div class="flex items-center gap-2">
            <div class="font-medium">{props.summaryText}</div>
            <div class="text-xs text-[var(--text-muted)]">{props.title}</div>
          </div>
          <div class="flex items-center gap-2">
            <div class="text-xs text-[var(--text-muted)]">{props.duration}</div>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              class={`ml-2 transition-transform duration-150 ${open() ? 'rotate-90' : ''}`}
            >
              <path fill="currentColor" d="M9 6l6 6-6 6" />
            </svg>
          </div>
        </summary>
        <div class="relative p-3">
          {open() && props.copyHint ? (
            <button
              type="button"
              class="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-muted)] transition hover:bg-blue-600 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
              aria-label={copiedTargetKey() === props.copyHint.key ? 'Tool output copied' : 'Copy tool output'}
              title="Copy tool output"
              onClick={() => void copyTextPayload(props.copyHint!.payload, props.copyHint!.key)}
            >
              {copiedTargetKey() === props.copyHint.key ? (
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M20.285 6.708a1 1 0 00-1.513-1.3l-8.05 9.368-3.492-3.492a1 1 0 10-1.414 1.414l4.25 4.25a1 1 0 001.495-.06z"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path fill="currentColor" d="M8 2h10a2 2 0 012 2v12h-2V4H8z" />
                  <path
                    fill="currentColor"
                    d="M5 6h10a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2zm0 2v12h10V8z"
                  />
                </svg>
              )}
            </button>
          ) : null}
          {props.children}
        </div>
      </details>
    )
  }

  function toolPartClipboardText(message: CodingAgentMessage, part: CodingAgentMessagePart): string {
    const meta: string[] = []
    const toolName = String((part as any)?.tool ?? (part as any)?.toolName ?? (part as any)?.name ?? '')
    if (toolName) meta.push(`Tool: ${toolName}`)
    if ((part as any)?.title) meta.push(String((part as any).title))
    if (message.createdAt) meta.push(new Date(message.createdAt).toLocaleString())

    const body: string[] = []
    const append = (value: string | null | undefined) => {
      if (typeof value === 'string' && value.trim()) body.push(value.trim())
    }
    append(part.text)
    append((part as any)?.output)
    append((part as any)?.state?.output)
    const diffText = extractDiffText(part)
    if (diffText) body.push(diffText)

    if (body.length === 0) return ''
    return [...meta, '', ...body].join('\n').trim()
  }

  async function copyTextPayload(payload: string, targetKey: string) {
    if (!payload) return
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload)
      } else if (typeof document !== 'undefined') {
        const textarea = document.createElement('textarea')
        textarea.value = payload
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.focus()
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      } else {
        throw new Error('Clipboard API unavailable')
      }
      setCopiedTargetKey(targetKey)
      if (typeof window !== 'undefined') {
        if (copyResetTimer) clearTimeout(copyResetTimer)
        copyResetTimer = setTimeout(() => setCopiedTargetKey(null), 2000)
      }
    } catch (error) {
      console.error('Failed to copy message', error)
    }
  }

  const closeSelectionMenu = () => {
    setSelectionMenu(null)
    if (typeof window === 'undefined') return
    try {
      const sel = window.getSelection()
      sel?.removeAllRanges?.()
    } catch {}
  }

  const handleSelectionCopy = async () => {
    const menu = selectionMenu()
    if (!menu) return
    await copyTextPayload(menu.text, 'selection')
    closeSelectionMenu()
  }

  function scheduleSelectionMenuUpdate() {
    if (typeof window === 'undefined') return
    setTimeout(() => {
      const root = container()
      if (!root) return
      let sel: Selection | null = null
      try {
        sel = window.getSelection()
      } catch {}
      if (!sel || sel.isCollapsed) return
      const anchorNode = sel.anchorNode
      const focusNode = sel.focusNode
      if (!anchorNode || !focusNode) return
      if (!root.contains(anchorNode) || !root.contains(focusNode)) return
      const text = sel.toString().trim()
      if (!text) return
      setSelectionMenu({ text })
    }, 0)
  }

  createEffect(() => {
    const el = container()
    if (!el) return
    const handlePointerUp = () => scheduleSelectionMenuUpdate()
    const handleKeyUp = () => scheduleSelectionMenuUpdate()
    el.addEventListener('pointerup', handlePointerUp)
    el.addEventListener('keyup', handleKeyUp)
    onCleanup(() => {
      el.removeEventListener('pointerup', handlePointerUp)
      el.removeEventListener('keyup', handleKeyUp)
    })
  })

  createEffect(() => {
    if (typeof window === 'undefined') return
    const handleSelectionChange = () => {
      try {
        const sel = window.getSelection()
        if (!sel || sel.isCollapsed) setSelectionMenu(null)
      } catch {}
    }
    document.addEventListener('selectionchange', handleSelectionChange)
    onCleanup(() => document.removeEventListener('selectionchange', handleSelectionChange))
  })

  createEffect(() => {
    if (typeof window === 'undefined') return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSelectionMenu()
    }
    document.addEventListener('keydown', handleKeyDown)
    onCleanup(() => document.removeEventListener('keydown', handleKeyDown))
  })

  function renderMessageParts(message: CodingAgentMessage) {
    const parts: any[] = (message as any).parts ?? []
    if (!parts || parts.length === 0) {
      return message.text.split('\n').map((line) => <p class="mb-1 last:mb-0 break-words">{line}</p>)
    }
    const elements: JSX.Element[] = []
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]
      if (!part) continue

      if (part.type === 'text' || part.type === 'step-finish') {
        if (typeof part.text === 'string' && part.text.trim()) {
          elements.push(<p class="mb-1 last:mb-0 break-words">{part.text.trim()}</p>)
        }
        continue
      }

      if (part.type === 'tool') {
        const toolName = String(part.tool ?? part.toolName ?? part.name ?? '')
        const title = part.title ?? part.state?.title ?? ''
        const text = typeof part.text === 'string' && part.text.trim() ? part.text.trim() : null
        const output =
          typeof (part.state?.output ?? part.output) === 'string' ? (part.state?.output ?? part.output) : null

        // Heuristic: tool name indicates todowrite
        const nameIndicatesTodo =
          toolName.toLowerCase().includes('todo') || toolName.toLowerCase().includes('todowrite')

        const tryParseTodos = (candidate: string | null) => {
          if (!candidate) return null
          try {
            const parsed = JSON.parse(candidate)
            if (!Array.isArray(parsed)) return null
            const ok = parsed.every(
              (it) => it && typeof it === 'object' && ('content' in it || 'text' in it) && 'id' in it
            )
            if (!ok) return null
            const todos = parsed.map((it: any) => ({
              content: String(it.content ?? it.text ?? ''),
              id: String(it.id ?? Math.random().toString(36).slice(2, 8)),
              priority:
                it.priority === 'high' || it.priority === 'medium' || it.priority === 'low' ? it.priority : 'low',
              status:
                it.status === 'pending' ||
                it.status === 'in_progress' ||
                it.status === 'completed' ||
                it.status === 'cancelled'
                  ? it.status
                  : 'pending'
            }))
            return todos
          } catch {
            return null
          }
        }

        // Diagnostic / file tag parsers
        const tryParseFileTags = (candidate: string | null) => {
          if (!candidate) return null
          try {
            const parsed = JSON.parse(candidate)
            if (!parsed || typeof parsed !== 'object') return null
            // single file object
            if (parsed.type === 'file' && typeof parsed.path === 'string') return { type: 'file', value: parsed }
            if (
              parsed.type === 'file-diagnostic' &&
              typeof parsed.path === 'string' &&
              Array.isArray(parsed.diagnostics)
            )
              return { type: 'file-diagnostic', value: parsed }
            if (parsed.type === 'project-diagnostic' && Array.isArray(parsed.diagnostics))
              return { type: 'project-diagnostic', value: parsed }
            // array of diagnostics (common for read/edit/write tools)
            if (Array.isArray(parsed) && parsed.every((it) => it && typeof it === 'object')) {
              // if items have 'path' and 'diagnostics'
              if (parsed.every((it) => typeof it.path === 'string' && Array.isArray(it.diagnostics))) {
                return { type: 'file-diagnostic-array', value: parsed }
              }
            }
            return null
          } catch {
            return null
          }
        }

        // Small renderers for file/diagnostic tags
        const renderFile = (fileObj: any) => (
          <div class="mb-2 rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3 text-sm">
            <div class="font-semibold">File: {fileObj.path}</div>
            {fileObj.preview ? <pre class="mt-2 whitespace-pre-wrap">{String(fileObj.preview)}</pre> : null}
          </div>
        )

        const renderDiagnostics = (diagObj: any) => {
          const diags: any[] = Array.isArray(diagObj.diagnostics) ? diagObj.diagnostics : []
          return (
            <div class="mb-2 rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-3 text-sm">
              <div class="font-semibold">Diagnostics for {diagObj.path ?? 'project'}</div>
              <ul class="mt-2 list-disc pl-4">
                {diags.map((d) => (
                  <li>
                    <div class="font-semibold">{d.severity ?? d.level ?? 'info'}</div>
                    <div class="text-xs text-[var(--text-muted)]">{d.message ?? d.msg ?? ''}</div>
                    {d.range ? <div class="text-xs text-[var(--text-muted)]">{JSON.stringify(d.range)}</div> : null}
                  </li>
                ))}
              </ul>
            </div>
          )
        }

        // Prefer parsing when name suggests todo
        if (nameIndicatesTodo) {
          const candidate = output ?? text
          const parsed = tryParseTodos(candidate)
          if (parsed) {
            elements.push(<TodoList todos={parsed} />)
            continue
          }
        }

        // Otherwise, attempt to parse output/text as JSON todo array
        const parsedAny = tryParseTodos(output ?? text)
        if (parsedAny) {
          elements.push(<TodoList todos={parsedAny} />)
          continue
        }

        // Try parsing file/diagnostic tags used by read/edit/write tools
        const parsedTags = tryParseFileTags(output ?? text)
        if (parsedTags) {
          switch (parsedTags.type) {
            case 'file':
              elements.push(renderFile(parsedTags.value))
              break
            case 'file-diagnostic':
              elements.push(renderDiagnostics(parsedTags.value))
              break
            case 'project-diagnostic':
              elements.push(renderDiagnostics(parsedTags.value))
              break
            case 'file-diagnostic-array':
              for (const item of parsedTags.value) elements.push(renderDiagnostics(item))
              break
          }
          continue
        }

        // Render tool output inside a collapsed details block by default
        const durationLabel = (() => {
          const start = part.start ? String(part.start) : null
          const end = part.end ? String(part.end) : null
          if (start && end) {
            const d = Math.max(0, Date.parse(end) - Date.parse(start))
            return `${d} ms`
          }
          return ''
        })()

        const diffText = extractDiffText(part)
        const summaryText = toolName || (text ?? 'Tool')
        const partKey = String(part.id ?? `${message.id}-${index}`)
        const toolCopyPayload = toolPartClipboardText(message, part)

        elements.push(
          <DetailsWithToggle
            summaryText={summaryText}
            duration={durationLabel}
            title={title}
            copyHint={toolCopyPayload ? { payload: toolCopyPayload, key: `tool:${message.id}:${partKey}` } : undefined}
          >
            {/* Try to render todos or file/diagnostic tags first */}
            {nameIndicatesTodo
              ? (() => {
                  const candidate = output ?? text
                  const parsed = tryParseTodos(candidate)
                  if (parsed) return <TodoList todos={parsed} />
                  return null
                })()
              : null}

            {(() => {
              const parsedAny = tryParseTodos(output ?? text)
              if (parsedAny) return <TodoList todos={parsedAny} />
              return null
            })()}

            {(() => {
              const parsedTags = tryParseFileTags(output ?? text)
              if (!parsedTags) return null
              switch (parsedTags.type) {
                case 'file':
                  return renderFile(parsedTags.value)
                case 'file-diagnostic':
                  return renderDiagnostics(parsedTags.value)
                case 'project-diagnostic':
                  return renderDiagnostics(parsedTags.value)
                case 'file-diagnostic-array':
                  return parsedTags.value.map((item: any) => renderDiagnostics(item))
              }
              return null
            })()}

            {diffText ? (
              <div class="mt-2 mb-2">
                <DiffViewer diffText={diffText} />
              </div>
            ) : (output || text) && !(nameIndicatesTodo && tryParseTodos(output ?? text)) ? (
              <ToolRenderer part={part} />
            ) : null}
          </DetailsWithToggle>
        )

        // If there are multiple tool parts in the message, show a summarized list
        const toolCalls = extractToolCalls(parts)
        if (toolCalls.length > 1) {
          elements.push(<ToolCallList calls={toolCalls as any} />)
        }

        continue
      }

      if (part.type === 'file-diff' || part.type === 'diff') {
        const diffText = extractDiffText(part)
        elements.push(
          <div class="mt-2 mb-2">
            <DiffViewer diffText={diffText ?? undefined} />
          </div>
        )
        continue
      }
    }
    if (elements.length === 0) return null
    return elements
  }

  function groupedMessages() {
    const msgs = props.messages ?? []
    const groups: { role: string; messages: CodingAgentMessage[]; timestamp: string }[] = []
    for (const m of msgs) {
      if (!m) continue
      if (groups.length === 0 || groups[groups.length - 1].role !== m.role) {
        groups.push({ role: m.role, messages: [m], timestamp: String(m.createdAt) })
      } else {
        // append to existing group and update timestamp to most recent message
        groups[groups.length - 1].messages.push(m)
        groups[groups.length - 1].timestamp = String(m.createdAt)
      }
    }
    return groups
  }

  return (
    <div ref={(el) => setContainer(el ?? null)} class={props.class ?? ''}>
      <For each={groupedMessages()}>
        {(group) => (
          <article class="rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)] p-4">
            <header class="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
              <span class="uppercase tracking-wide">{group.role}</span>
              <span>{new Date(group.timestamp).toLocaleString()}</span>
            </header>
            <div class="whitespace-pre-wrap text-[var(--text)] break-words text-sm">
              <For each={group.messages}>
                {(message) => (
                  <div
                    class="relative mb-3 rounded-xl border border-transparent p-3 transition hover:border-[var(--border)] last:mb-0"
                    classList={{
                      'border-blue-500 bg-blue-50 dark:bg-blue-950/30': props.selectedMessageId === message.id,
                      'cursor-pointer': Boolean(props.onMessageClick)
                    }}
                    role={props.onMessageClick ? 'button' : undefined}
                    tabIndex={props.onMessageClick ? 0 : undefined}
                    onClick={() => props.onMessageClick?.(message)}
                    onKeyDown={(event) => {
                      if (!props.onMessageClick) return
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        props.onMessageClick(message)
                      }
                    }}
                  >
                    <div>{renderMessageParts(message)}</div>
                  </div>
                )}
              </For>
            </div>
          </article>
        )}
      </For>
      <Show when={selectionMenu()} keyed>
        {(menu) => (
          <div
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={closeSelectionMenu}
          >
            <div
              class="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-5 shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div class="mb-2 text-base font-semibold text-[var(--text)]">Text selection</div>
              <p class="mb-3 text-xs text-[var(--text-muted)]">Hold-select to open actions</p>
              <div class="mb-5 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-[var(--bg-muted)] p-3 text-sm text-[var(--text)]">
                {menu.text}
              </div>
              <div class="flex justify-end gap-2">
                <button
                  type="button"
                  class="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--text)]"
                  onClick={closeSelectionMenu}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  onClick={() => void handleSelectionCopy()}
                >
                  {copiedTargetKey() === 'selection' ? 'Copied' : 'Copy selection'}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}
