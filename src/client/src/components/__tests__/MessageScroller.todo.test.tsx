import { render, screen } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import MessageScroller from '../MessageScroller'

const todos = [
  { content: 'Task A', id: 'a1', priority: 'high', status: 'pending' },
  { content: 'Task B', id: 'b2', priority: 'low', status: 'in_progress' }
]

const message = {
  id: 'm1',
  role: 'assistant',
  createdAt: new Date().toISOString(),
  text: '',
  parts: [
    {
      type: 'tool',
      tool: 'todowrite',
      state: { output: JSON.stringify(todos) }
    }
  ]
}

describe('MessageScroller todowrite rendering', () => {
  it('renders TodoList when tool outputs todowrite JSON', () => {
    render(() => <MessageScroller messages={[message as any]} />)
    expect(screen.getByText('Todo')).toBeDefined()
    expect(screen.getByText('2 items')).toBeDefined()
    expect(screen.getByText('Task A')).toBeDefined()
    expect(screen.getByText('high')).toBeDefined()
  })
})
