import { Route, Router } from '@solidjs/router'
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchJson } from '../../../../shared/api/httpClient'
import { WorkspaceSelectionProvider } from '../../../state/WorkspaceSelectionContext'
import RepositoryNavigator from '../RepositoryNavigator'

type ProjectPayload = {
  id: string
  name: string
  repositoryPath: string
  defaultBranch: string
  description?: string | null
  createdAt: string
  git?: Record<string, unknown> | null
}

type RadicleEntryPayload = {
  project: ProjectPayload
  radicle: Record<string, unknown> | null
  git: Record<string, unknown> | null
}

vi.mock('../../../../shared/api/httpClient', () => ({
  fetchJson: vi.fn()
}))

const fetchJsonMock = vi.mocked(fetchJson)

const defaultFsListing = { path: '/', parent: null, entries: [] }

function setupApiMocks(params?: { projects?: ProjectPayload[]; radicle?: RadicleEntryPayload[] }) {
  const projects = [...(params?.projects ?? [])]
  const radicle = params?.radicle ?? []
  fetchJsonMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
    if (typeof input !== 'string') {
      throw new Error('Unexpected non-string request input')
    }
    if (input.startsWith('/api/fs/browse')) {
      return defaultFsListing
    }
    if (input === '/api/projects' && (!init || !('method' in init))) {
      return { projects }
    }
    if (input === '/api/projects' && init?.method === 'POST') {
      const payload = typeof init.body === 'string' ? JSON.parse(init.body) : {}
      const created = {
        id: `project-${projects.length + 1}`,
        name: payload.name ?? 'Unnamed',
        repositoryPath: payload.repositoryPath ?? '/tmp/repo',
        defaultBranch: payload.defaultBranch ?? 'main',
        description: payload.description ?? null,
        createdAt: new Date().toISOString()
      }
      projects.push(created)
      return created
    }
    if (input === '/api/radicle/repositories') {
      return { repositories: radicle }
    }
    if (input === '/api/radicle/register') {
      return { status: 'ok' }
    }
    if (input === '/api/coding-agent/sessions') {
      return { run: { id: 'run-1' } }
    }
    throw new Error(`Unhandled request: ${input}`)
  })
  return { projects, radicle }
}

function renderNavigator() {
  window.history.replaceState({}, '', '/')
  return render(() => (
    <Router root={(props) => <WorkspaceSelectionProvider>{props.children}</WorkspaceSelectionProvider>}>
      <Route path="/" component={RepositoryNavigator} />
    </Router>
  ))
}

describe('RepositoryNavigator', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  // Legacy drawer-based project creation was removed in favor of the template modal.

  it('converts a Radicle-only entry into a Hyperagent project', async () => {
    const syntheticProject: ProjectPayload = {
      id: 'rad-only-sample',
      name: 'Rad Repo',
      repositoryPath: '/tmp/rad',
      defaultBranch: 'main',
      description: null,
      createdAt: new Date().toISOString()
    }
    setupApiMocks({
      radicle: [
        {
          project: syntheticProject,
          radicle: {
            repositoryPath: '/tmp/rad',
            radicleProjectId: 'rad1',
            remoteUrl: null,
            defaultBranch: 'main',
            registered: true
          },
          git: null
        }
      ]
    })

    renderNavigator()

    const convertButton = await screen.findByRole('button', { name: /convert to hyperagent project/i })
    fireEvent.click(convertButton)

    await waitFor(() => {
      const postCall = fetchJsonMock.mock.calls.find(
        ([url, init]) => url === '/api/projects' && init?.method === 'POST'
      )
      expect(postCall).toBeTruthy()
      const [, init] = postCall!
      const payload = JSON.parse(init!.body as string)
      expect(payload).toMatchObject({ name: 'Rad Repo', repositoryPath: '/tmp/rad' })
    })
  })
})
