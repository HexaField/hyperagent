import { vi } from 'vitest'

// Mock native node-pty bindings to avoid requiring compiled binaries during tests.
vi.mock('node-pty', () => {
  const fakePty = () => {
    const listeners: Array<() => void> = []
    return {
      cols: 120,
      rows: 30,
      onExit: (handler: () => void) => {
        listeners.push(handler)
      },
      kill: vi.fn(() => {
        listeners.forEach((handler) => handler())
      }),
      resize: vi.fn()
    }
  }

  return {
    spawn: vi.fn(() => fakePty())
  }
})
