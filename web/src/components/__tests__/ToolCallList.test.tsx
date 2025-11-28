import { render, screen } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import ToolCallList from '../ToolCallList'

describe('ToolCallList', () => {
  it('renders list of tool calls', () => {
    const calls = [
      { id: '1', text: 'git status', durationMs: 120 },
      { id: '2', text: 'npm install', durationMs: 340 }
    ]

    render(() => <ToolCallList calls={calls as any} />)

    expect(screen.getByText('Tool calls')).toBeDefined()
    expect(screen.getByText('git status')).toBeDefined()
    expect(screen.getByText('120 ms')).toBeDefined()
    expect(screen.getByText('npm install')).toBeDefined()
    expect(screen.getByText('340 ms')).toBeDefined()
  })
})
