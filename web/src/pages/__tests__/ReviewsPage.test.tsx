import { render, screen } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ReviewsPage from '../ReviewsPage'
import { fetchJson } from '../../lib/http'

vi.mock('../../lib/http', () => ({
  fetchJson: vi.fn()
}))

const fetchJsonMock = vi.mocked(fetchJson)

describe('ReviewsPage', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders active pull requests grouped by project', async () => {
    const now = new Date().toISOString()
    fetchJsonMock.mockResolvedValueOnce({
      groups: [
        {
          project: {
            id: 'project-1',
            name: 'Project Alpha',
            repositoryPath: '/repos/alpha',
            defaultBranch: 'main'
          },
          pullRequests: [
            {
              id: 'pr-1',
              projectId: 'project-1',
              title: 'Improve onboarding flow',
              description: 'Add contextual tips throughout the wizard.',
              sourceBranch: 'feature/onboarding-tips',
              targetBranch: 'main',
              status: 'open',
              authorUserId: 'user-1',
              createdAt: now,
              updatedAt: now,
              latestReviewRun: {
                id: 'run-1',
                status: 'completed',
                summary: 'No blocking issues found.',
                createdAt: now,
                completedAt: now
              }
            }
          ]
        }
      ]
    })

    render(() => <ReviewsPage />)

    expect(fetchJsonMock).toHaveBeenCalledWith('/api/reviews/active')
    expect(await screen.findByText('Project Alpha')).toBeTruthy()
    expect(screen.getByText('Improve onboarding flow')).toBeTruthy()
    expect(screen.getByText(/No blocking issues found/)).toBeTruthy()
  })

  it('shows empty state when there are no open pull requests', async () => {
    fetchJsonMock.mockResolvedValueOnce({ groups: [] })
    render(() => <ReviewsPage />)
    expect(await screen.findByText('No open pull requests right now.')).toBeTruthy()
  })
})
