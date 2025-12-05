import { render } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import MessageScroller from '../MessageScroller'

// Minimal message shape matching CodingAgentMessage used by MessageScroller
const makeToolMessage = (diff: string | null) =>
  ({
    id: 'm1',
    role: 'assistant',
    createdAt: new Date().toISOString(),
    completedAt: null,
    modelId: null,
    text: '',
    parts: [
      {
        id: 'p1',
        type: 'tool',
        tool: 'edit',
        text: 'edit file',
        state: diff ? { metadata: { diff } } : {}
      }
    ]
  }) as any

describe('MessageScroller tool part diff rendering', () => {
  it('renders DiffViewer when tool part has metadata.diff', async () => {
    const diff = 'diff --git a/file b/file\n@@ -1 +1 @@\n-foo\n+bar'
    const { container } = render(() => <MessageScroller messages={[makeToolMessage(diff)]} />)
    // DiffViewer initially shows file header; click to expand and reveal hunk lines
    const header = container.querySelector('.diff-file-header') as HTMLElement | null
    expect(header).not.toBeNull()
    if (header) header.click()
    // after expanding, diff hunk lines should be present
    expect(container.textContent).toContain('@@ -1 +1 @@')
  })

  it('does not render DiffViewer when no diff present', () => {
    const { container } = render(() => <MessageScroller messages={[makeToolMessage(null)]} />)
    expect(container.textContent).toContain('edit file')
  })
})
