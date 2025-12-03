import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceNarratorFeedResponse } from '../../../../interfaces/widgets/workspaceNarrator'
import { WorkspaceNarratorWidget } from './index'
import { fetchNarratorFeed, fetchNarratorRawLog, postNarratorMessage } from '../../lib/narratorFeed'

vi.mock('../../lib/narratorFeed', () => {
  return {
    fetchNarratorFeed: vi.fn(),
    postNarratorMessage: vi.fn(),
    fetchNarratorRawLog: vi.fn()
  }
})

describe('WorkspaceNarratorWidget', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('renders narrator timeline and playbook guidance', async () => {
    const initialFeed: WorkspaceNarratorFeedResponse = {
      workspaceId: 'ws-1',
      conversationId: 'conv-777',
      summaryRef: 'summaries/conv-777.md',
      events: [
        {
          id: 'evt-1',
          timestamp: '2025-11-30T10:00:00Z',
          type: 'narration',
          headline: 'Narrator spoke',
          detail: 'Shared latest summary.',
          severity: 'info',
          source: 'narrator'
        },
        {
          id: 'evt-2',
          timestamp: '2025-11-30T10:01:00Z',
          type: 'suppressed',
          headline: 'Narrator gated',
          detail: 'Controller kept narrator silent.',
          severity: 'warning',
          source: 'system',
          playbookId: 'narration-suppressed'
        }
      ]
    }
    const updatedFeed: WorkspaceNarratorFeedResponse = {
      ...initialFeed,
      events: [
        ...initialFeed.events,
        {
          id: 'narrator-1',
          timestamp: '2025-11-30T10:02:00Z',
          type: 'narration',
          headline: 'Controller reply',
          detail: 'Acknowledged.',
          severity: 'info',
          source: 'narrator'
        }
      ]
    }
    ;(fetchNarratorFeed as ReturnType<typeof vi.fn>).mockResolvedValueOnce(initialFeed).mockResolvedValue(updatedFeed)
    ;(postNarratorMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      workspaceId: 'ws-1',
      conversationId: 'conv-777',
      eventId: 'narrator-1'
    })
    ;(fetchNarratorRawLog as ReturnType<typeof vi.fn>).mockResolvedValue('{"id":"evt-raw"}')

    render(() => <WorkspaceNarratorWidget workspaceId="ws-1" workspaceName="Monorepo" repositoryPath="/repo" />)

    await waitFor(() => {
      expect(screen.getByText('Narrator activity for Monorepo')).toBeDefined()
    })

    expect(screen.getByText('Conversation thread')).toBeDefined()
    expect(screen.getByText('Conversation conv-777')).toBeDefined()
    const narratorHeadlines = screen.getAllByText('Narrator spoke')
    expect(narratorHeadlines.length).toBeGreaterThan(0)
    expect(screen.queryByText('Narrator gated')).toBeNull()
    expect(screen.getByText(/events captured for this workspace/i)).toBeDefined()
    const composer = screen.getAllByPlaceholderText('Message narrator')[0] as HTMLTextAreaElement
    fireEvent.input(composer, { target: { value: 'Ship the changes' } })
    const sendButton = screen.getAllByRole('button', { name: /Send message/i })[0]
    fireEvent.click(sendButton)
    await waitFor(() => {
      expect(postNarratorMessage).toHaveBeenCalledWith({ workspaceId: 'ws-1', message: 'Ship the changes' })
    })
    await waitFor(() => {
      expect(screen.getByText(/Narrator reply received/i)).toBeDefined()
    })

    const rawToggle = screen.getByRole('button', { name: /Raw narrator stream/i })
    expect(rawToggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(rawToggle)
    await waitFor(() => {
      expect(fetchNarratorRawLog).toHaveBeenCalledWith({ workspaceId: 'ws-1' })
    })
    await waitFor(() => {
      expect(screen.getByText('{"id":"evt-raw"}')).toBeDefined()
    })

    const rawLink = screen.getByRole('link', { name: /Download raw logs/i })
    expect(rawLink.getAttribute('href')).toContain('/api/workspaces/ws-1/narrator/raw')
    await waitFor(() => {
      expect(fetchNarratorFeed).toHaveBeenCalledWith({ workspaceId: 'ws-1', limit: 50 })
    })
  })

  it('shows relay failures and keeps polling', async () => {
    const intervalCalls: number[] = []
    const originalSetInterval = window.setInterval.bind(window)
    vi.spyOn(window, 'setInterval').mockImplementation((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      intervalCalls.push(Number(timeout))
      return originalSetInterval(handler, timeout, ...args) as unknown as ReturnType<typeof window.setInterval>
    })
    const feed: WorkspaceNarratorFeedResponse = {
      workspaceId: 'ws-err',
      conversationId: 'ws-err',
      events: [],
      summaryRef: null
    }
    ;(fetchNarratorFeed as ReturnType<typeof vi.fn>).mockResolvedValue(feed)
    ;(postNarratorMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Relay failed'))

    render(() => <WorkspaceNarratorWidget workspaceId="ws-err" workspaceName="Err" repositoryPath="/repo" />)

    await waitFor(() => {
      expect(fetchNarratorFeed).toHaveBeenCalled()
      expect(intervalCalls).toContain(5000)
    })

    const composer = screen.getAllByPlaceholderText('Message narrator')[0] as HTMLTextAreaElement
    fireEvent.input(composer, { target: { value: 'Hello' } })
    const sendButton = screen.getAllByRole('button', { name: /Send message/i })[0]
    fireEvent.click(sendButton)

    await waitFor(() => {
      expect(intervalCalls).toContain(1000)
      expect(screen.getByText(/Narrator relay failed/i)).toBeDefined()
      expect(screen.getAllByText(/Relay failed/i).length).toBeGreaterThan(0)
    })
    expect(sendButton.hasAttribute('disabled')).toBe(false)

    await waitFor(() => {
      const slowIntervals = intervalCalls.filter((delay) => delay === 5000)
      expect(slowIntervals.length).toBeGreaterThanOrEqual(2)
    })
  }, 10000)
})
