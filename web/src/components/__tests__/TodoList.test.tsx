import { render, screen } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import TodoList from '../TodoList'

const todos = [
  {
    content: 'Inspect ToolRenderer, DiffViewer, and console components',
    id: '1',
    priority: 'high' as const,
    status: 'completed' as const
  },
  {
    content: 'Fix ToolRenderer.tsx syntax and prop usage',
    id: '2',
    priority: 'high' as const,
    status: 'completed' as const
  },
  { content: 'Run TypeScript check and tests', id: '3', priority: 'medium' as const, status: 'completed' as const },
  { content: 'Add/adjust tests if failures remain', id: '4', priority: 'low' as const, status: 'in_progress' as const }
]

describe('TodoList', () => {
  it('renders todos and count', () => {
    render(() => <TodoList todos={todos} />)
    expect(screen.getByText('Todo')).toBeDefined()
    expect(screen.getByText('4 items')).toBeDefined()
    expect(screen.getByText(todos[0].content)).toBeDefined()
    expect(screen.getAllByText('high')).toHaveLength(2)
    expect(screen.getByText('in progress')).toBeDefined()
  })
})
