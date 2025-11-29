import { render, screen } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import MessageScroller from '../MessageScroller'

const fileMessage = {
  id: 'f1',
  role: 'assistant',
  createdAt: new Date().toISOString(),
  text: '',
  parts: [
    {
      type: 'tool',
      tool: 'read',
      state: { output: JSON.stringify({ type: 'file', path: 'src/foo.ts', preview: 'const a = 1' }) }
    }
  ]
}

const fileDiagMessage = {
  id: 'd1',
  role: 'assistant',
  createdAt: new Date().toISOString(),
  text: '',
  parts: [
    {
      type: 'tool',
      tool: 'read',
      state: {
        output: JSON.stringify({
          type: 'file-diagnostic',
          path: 'src/foo.ts',
          diagnostics: [{ severity: 'error', message: 'Unexpected token', range: { start: { line: 1, character: 6 } } }]
        })
      }
    }
  ]
}

describe('MessageScroller file tags', () => {
  it('renders file preview', () => {
    render(() => <MessageScroller messages={[fileMessage as any]} />)
    expect(screen.getByText('File: src/foo.ts')).toBeDefined()
    expect(screen.getByText('const a = 1')).toBeDefined()
  })
  it('renders diagnostics', () => {
    render(() => <MessageScroller messages={[fileDiagMessage as any]} />)
    expect(screen.getByText('Diagnostics for src/foo.ts')).toBeDefined()
    expect(screen.getByText('Unexpected token')).toBeDefined()
  })
})
