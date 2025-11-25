import { Router } from '@solidjs/router'
import { cleanup, render, screen } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspacePage from '../WorkspacePage'
import { CanvasNavigatorContext, type CanvasNavigatorController } from '../../contexts/CanvasNavigatorContext'
import type { WorkspaceRecord } from '../../contexts/WorkspaceSelectionContext'

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

vi.mock('../../contexts/WorkspaceSelectionContext', () => ({
  useWorkspaceSelection: () => selectionMock
}))

function setSelectionState(partial: Partial<SelectionState>) {
  Object.assign(selectionState, partial)
}

function renderPage() {
  return render(() => (
    <CanvasNavigatorContext.Provider value={navigatorMock}>
      <Router root={(props) => <>{props.children}</>}>
        <WorkspacePage />
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

  it('renders the active workspace summary when one is selected', () => {
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
    expect(screen.getByText(workspace.name)).toBeTruthy()
    expect(screen.getByText(workspace.repositoryPath)).toBeTruthy()
    screen.getByRole('button', { name: /manage workspaces/i }).click()
    expect(openSpy).toHaveBeenCalledTimes(1)
  })
})
