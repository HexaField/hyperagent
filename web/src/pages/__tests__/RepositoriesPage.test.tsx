import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { Route, Router } from '@solidjs/router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RepositoriesPage from '../RepositoriesPage'
import { fetchJson } from '../../lib/http'

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

vi.mock('../../lib/http', () => ({
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
    throw new Error(`Unhandled request: ${input}`)
  })
  return { projects, radicle }
}

function renderPage() {
  window.history.replaceState({}, '', '/repositories')
  return render(() => (
    <Router root={(props) => <>{props.children}</>}>
      <Route path="/repositories" component={RepositoriesPage} />
    </Router>
  ))
}

describe('RepositoriesPage', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('opens the New repository modal and submits the form', async () => {
    setupApiMocks()
    renderPage()

    const trigger = await screen.findByRole('button', { name: /new repository/i })
    fireEvent.click(trigger)

    const nameInput = await screen.findByLabelText('Name')
    fireEvent.input(nameInput, { target: { value: 'My Repo' } })
    fireEvent.input(screen.getByLabelText('Repository path'), { target: { value: '/tmp/my-repo' } })
    fireEvent.input(screen.getByLabelText('Default branch'), { target: { value: 'develop' } })
    fireEvent.input(screen.getByLabelText('Description (optional)'), { target: { value: 'Testing repo' } })

    fireEvent.submit(screen.getByTestId('new-repo-form'))

    await waitFor(() => {
      const postCall = fetchJsonMock.mock.calls.find(([url, init]) => url === '/api/projects' && init?.method === 'POST')
      expect(postCall).toBeTruthy()
      const [, init] = postCall!
      const payload = JSON.parse(init!.body as string)
      expect(payload).toMatchObject({
        name: 'My Repo',
        repositoryPath: '/tmp/my-repo',
        defaultBranch: 'develop',
        description: 'Testing repo'
      })
    })
  })

  it('converts a Radicle-only repository into a Hyperagent project', async () => {
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

    renderPage()

    const convertButton = await screen.findByRole('button', { name: /convert to hyperagent project/i })
    fireEvent.click(convertButton)

    await waitFor(() => {
      const postCall = fetchJsonMock.mock.calls.find(([url, init]) => url === '/api/projects' && init?.method === 'POST')
      expect(postCall).toBeTruthy()
      const [, init] = postCall!
      const payload = JSON.parse(init!.body as string)
      expect(payload).toMatchObject({ name: 'Rad Repo', repositoryPath: '/tmp/rad' })
    })
  })
})
