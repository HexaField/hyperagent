import { Route, Router } from '@solidjs/router'
import { cleanup, render, screen } from '@solidjs/testing-library'
import type { MockInstance } from 'vitest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasNavigatorContext, type CanvasNavigatorController } from '../../core/state/CanvasNavigatorContext'
import type { WorkspaceRecord } from '../../core/state/WorkspaceSelectionContext'
import WorkspacePage from '../WorkspacePage'

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  if (url.startsWith('/api/projects/') && url.endsWith('/devspace')) {
    const workspace = selectionState.currentWorkspace
    return jsonResponse({
      projectId: workspace?.id ?? 'mock-project',
      sessionId: 'session-mock',
      codeServerUrl: 'https://example.test/code-server/session-mock',
      workspacePath: workspace?.repositoryPath ?? '/tmp/mock',
      branch: workspace?.defaultBranch ?? 'main'
    })
  }
  if (url.includes('/api/code-server/sessions')) {
    return jsonResponse({ sessions: [] })
  }
  if (url === '/api/workflows') {
    return jsonResponse({ workflows: [] })
  }
  if (url.startsWith('/api/terminal/sessions')) {
    return jsonResponse({ sessions: [] })
  }
  if (url === '/api/terminal/sessions') {
    return jsonResponse({ session: null })
  }
  return jsonResponse({ ok: true })
})

const openSpy = vi.fn()
const closeSpy = vi.fn()
const toggleSpy = vi.fn()

const navigatorMock: CanvasNavigatorController = {
  isOpen: () => false,
  open: openSpy,
  close: closeSpy,
  toggle: toggleSpy
}

type SelectionState = {
  workspaces?: WorkspaceRecord[]
  isLoading: boolean
  currentWorkspace: WorkspaceRecord | null
}

const selectionState: SelectionState = {
  workspaces: [],
  isLoading: false,
  currentWorkspace: null
}

const selectionMock = {
  workspaces: () => selectionState.workspaces,
  isLoading: () => selectionState.isLoading,
  currentWorkspaceId: () => selectionState.currentWorkspace?.id ?? null,
  currentWorkspace: () => selectionState.currentWorkspace,
  setWorkspaceId: vi.fn(),
  refetchWorkspaces: vi.fn(async () => selectionState.workspaces)
}

vi.mock('../../core/state/WorkspaceSelectionContext', () => ({
  useWorkspaceSelection: () => selectionMock
}))

const originalMatchMedia = window.matchMedia
let matchMediaSpy: MockInstance<[query: string], MediaQueryList> | null = null

beforeAll(() => {
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        media: '',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(() => false)
      }))
    })
  } else {
    matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation(() => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false)
    }))
  }
  vi.stubGlobal('fetch', fetchMock)
})

afterAll(() => {
  vi.unstubAllGlobals()
  if (matchMediaSpy) {
    matchMediaSpy.mockRestore()
  } else if (originalMatchMedia) {
    window.matchMedia = originalMatchMedia
  } else {
    // @ts-expect-error allow cleanup for test-only stub
    delete window.matchMedia
  }
})

function setSelectionState(partial: Partial<SelectionState>) {
  Object.assign(selectionState, partial)
}

function renderPage() {
  return render(() => (
    <CanvasNavigatorContext.Provider value={navigatorMock}>
      <Router root={(props) => <>{props.children}</>}>
        <Route path="/" component={WorkspacePage} />
      </Router>
    </CanvasNavigatorContext.Provider>
  ))
}

describe('WorkspacePage', () => {
  beforeEach(() => {
    selectionMock.setWorkspaceId.mockClear()
    selectionMock.refetchWorkspaces.mockClear()
    openSpy.mockClear()
    closeSpy.mockClear()
    toggleSpy.mockClear()
    setSelectionState({ workspaces: [], isLoading: false, currentWorkspace: null })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows a loading indicator while fetching workspaces', () => {
    setSelectionState({ isLoading: true, workspaces: undefined, currentWorkspace: null })
    renderPage()
    expect(screen.getByText(/loading workspaces/i)).toBeTruthy()
  })

  it('renders the empty state when no workspace is available', () => {
    setSelectionState({ isLoading: false, workspaces: [], currentWorkspace: null })
    renderPage()
    expect(screen.getByText(/create your first workspace/i)).toBeTruthy()
    const openButton = screen.getByRole('button', { name: /open navigator/i })
    openButton.click()
    expect(openSpy).toHaveBeenCalledTimes(1)
  })

  it('renders the active workspace summary when one is selected', async () => {
    const workspace: WorkspaceRecord = {
      id: 'w1',
      name: 'Test Workspace',
      repositoryPath: '/tmp/test',
      defaultBranch: 'main',
      createdAt: new Date('2024-01-01').toISOString(),
      description: 'Demo workspace'
    }
    setSelectionState({ workspaces: [workspace], currentWorkspace: workspace, isLoading: false })
    renderPage()
    await screen.findByText(workspace.name)
    const pathInstances = await screen.findAllByText(workspace.repositoryPath)
    expect(pathInstances.length).toBeGreaterThan(0)
    const manageButton = await screen.findByRole('button', { name: /manage workspaces/i })
    manageButton.click()
    expect(openSpy).toHaveBeenCalledTimes(1)
  })
})
