import { For, Show, createMemo } from 'solid-js'

type DiffViewerProps = {
  diffText?: string | null
}

type DiffLine = {
  content: string
  type: 'header' | 'hunk' | 'addition' | 'deletion' | 'context'
}

export default function DiffViewer (props: DiffViewerProps) {
  const lines = createMemo<DiffLine[]>(() => parseDiff(props.diffText ?? ''))

  return (
    <div class="diff-viewer rounded-2xl border border-[var(--border)] bg-[var(--bg-muted)]">
      <Show when={props.diffText} fallback={<p class="p-4 text-sm text-[var(--text-muted)]">Select a step with commits to preview the diff.</p>}>
        <pre class="diff-pre">
          <For each={lines()}>
            {line => (
              <code classList={lineClass(line.type)}>{line.content}</code>
            )}
          </For>
        </pre>
      </Show>
    </div>
  )
}

function parseDiff (raw: string): DiffLine[] {
  if (!raw.trim()) return []
  return raw.split('\n').map((line) => {
    if (line.startsWith('diff --git')) {
      return { content: line, type: 'header' as const }
    }
    if (line.startsWith('@@')) {
      return { content: line, type: 'hunk' as const }
    }
    if (line.startsWith('+')) {
      return { content: line, type: 'addition' as const }
    }
    if (line.startsWith('-')) {
      return { content: line, type: 'deletion' as const }
    }
    return { content: line, type: 'context' as const }
  })
}

function lineClass (type: DiffLine['type']) {
  return {
    'diff-line': true,
    'diff-line-header': type === 'header',
    'diff-line-hunk': type === 'hunk',
    'diff-line-addition': type === 'addition',
    'diff-line-deletion': type === 'deletion'
  }
}
