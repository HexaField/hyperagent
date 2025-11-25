import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { Route, Router } from '@solidjs/router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RepositoryNavigator from '../RepositoryNavigator'
import { fetchJson } from '../../../lib/http'

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

vi.mock('../../../lib/http', () => ({
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
    if (input === '/api/workflows') {
      return { workflow: { id: 'wf-1' } }
    }
    throw new Error(`Unhandled request: ${input}`)
  })
  return { projects, radicle }
}

function renderNavigator() {
  window.history.replaceState({}, '', '/')
  return render(() => (
    <Router root={(props) => <>{props.children}</>}>
      <Route path="/" component={RepositoryNavigator} />
    </Router>
  ))
}

describe('RepositoryNavigator', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('creates a Hyperagent project from the drawer', async () => {
    setupApiMocks()
    renderNavigator()

    const trigger = await screen.findByRole('button', { name: /new repository/i })
    fireEvent.click(trigger)

    fireEvent.input(await screen.findByLabelText('Name'), { target: { value: 'Drawer Repo' } })
    fireEvent.input(screen.getByLabelText('Repository path'), { target: { value: '/tmp/drawer' } })
    fireEvent.input(screen.getByLabelText('Default branch'), { target: { value: 'develop' } })
    fireEvent.input(screen.getByLabelText('Description (optional)'), { target: { value: 'Via drawer' } })

    fireEvent.submit(screen.getByTestId('new-repo-form'))

    await waitFor(() => {
      const postCall = fetchJsonMock.mock.calls.find(([url, init]) => url === '/api/projects' && init?.method === 'POST')
      expect(postCall).toBeTruthy()
      const [, init] = postCall!
      const payload = JSON.parse(init!.body as string)
      expect(payload).toMatchObject({
        name: 'Drawer Repo',
        repositoryPath: '/tmp/drawer',
        defaultBranch: 'develop',
        description: 'Via drawer'
      })
    })
  })

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
      const postCall = fetchJsonMock.mock.calls.find(([url, init]) => url === '/api/projects' && init?.method === 'POST')
      expect(postCall).toBeTruthy()
      const [, init] = postCall!
      const payload = JSON.parse(init!.body as string)
      expect(payload).toMatchObject({ name: 'Rad Repo', repositoryPath: '/tmp/rad' })
    })
  })
})
