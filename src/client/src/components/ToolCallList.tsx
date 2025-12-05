import { For } from 'solid-js'
import type { ToolCall } from '../lib/messageParts'

export default function ToolCallList(props: { calls: ToolCall[] }) {
  const calls = props.calls ?? []
  if (calls.length === 0) return null
  return (
    <div class="mt-2 mb-2 rounded-md border border-[var(--border)] bg-[var(--bg-card)] p-2 text-xs">
      <div class="font-semibold">Tool calls</div>
      <ul class="mt-2 list-disc pl-6 text-sm">
        <For each={calls}>
          {(c) => (
            <li>
              <div class="font-medium break-words">{c.text}</div>
              <div class="text-xs text-[var(--text-muted)]">{c.durationMs != null ? `${c.durationMs} ms` : ''}</div>
            </li>
          )}
        </For>
      </ul>
    </div>
  )
}
