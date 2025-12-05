import type { JSX } from 'solid-js'
import { Show, createMemo, createSignal } from 'solid-js'
import type { LogEntry } from '../lib/codingAgent'
import MessageScroller from './MessageScroller'

export type ConversationPaneProps = {
  messages: LogEntry[]
  sessionId?: string | null
  emptyPlaceholder?: JSX.Element | string
  footer?: JSX.Element
  class?: string
  scrollerClass?: string
  footerClass?: string
  scrollButtonClass?: string
  scrollToLatestSignal?: number
  onAutoScrollChange?: (value: boolean) => void
}

export default function ConversationPane(props: ConversationPaneProps) {
  const [localScrollNudge, setLocalScrollNudge] = createSignal(0)
  const [autoScroll, setAutoScroll] = createSignal(true)

  const messageList = createMemo(() => props.messages ?? [])
  const hasMessages = createMemo(() => messageList().length > 0)

  const combinedScrollTrigger = () => (props.scrollToLatestSignal ?? 0) + localScrollNudge()

  const handleAutoScrollChange = (value: boolean) => {
    setAutoScroll(value)
    props.onAutoScrollChange?.(value)
  }

  const footerContent = createMemo(() => {
    if (!props.footer) return null
    const wrapperClass = props.footerClass ?? 'pt-3'
    return <div class={wrapperClass}>{props.footer}</div>
  })

  const resumeAutoScroll = () => {
    setLocalScrollNudge((value) => value + 1)
    setAutoScroll(true)
  }

  const renderPlaceholder = () => {
    if (!props.emptyPlaceholder) return 'No messages yet.'
    if (typeof props.emptyPlaceholder === 'string') return props.emptyPlaceholder
    return props.emptyPlaceholder
  }

  return (
    <div class={`relative flex h-full min-h-0 flex-col ${props.class ?? ''}`}>
      <MessageScroller
        messages={messageList()}
        sessionId={props.sessionId}
        class={`flex flex-col gap-3 overflow-y-auto pr-1 ${props.scrollerClass ?? ''}`}
        onAutoScrollChange={handleAutoScrollChange}
        scrollToBottomTrigger={combinedScrollTrigger()}
        footer={footerContent()}
      />
      <Show when={!hasMessages()}>
        <div class="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-[var(--text-muted)]">
          {renderPlaceholder()}
        </div>
      </Show>
      <Show when={!autoScroll() && hasMessages()}>
        <button
          type="button"
          class={`absolute flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg ${props.scrollButtonClass ?? 'right-3 bottom-3'}`}
          onClick={resumeAutoScroll}
          title="Scroll to latest"
        >
          ↓
        </button>
      </Show>
    </div>
  )
}
