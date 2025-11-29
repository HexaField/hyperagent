import { useSearchParams } from '@solidjs/router'
import { Accessor, Component, JSX, createContext, createEffect, createMemo, createResource, useContext } from 'solid-js'
import type { ProjectListResponse, WorkspaceRecord } from '../../../../src/interfaces/core/projects'
import { fetchJson } from '../../shared/api/httpClient'

export type { WorkspaceRecord }

type WorkspaceSelectionValue = {
  workspaces: Accessor<WorkspaceRecord[] | undefined>
  isLoading: Accessor<boolean>
  currentWorkspaceId: Accessor<string | null>
  currentWorkspace: Accessor<WorkspaceRecord | null>
  setWorkspaceId: (workspaceId: string | null) => void
  refetchWorkspaces: () => Promise<WorkspaceRecord[] | undefined>
}

const WorkspaceSelectionContext = createContext<WorkspaceSelectionValue>()

async function fetchWorkspaces() {
  const payload = await fetchJson<ProjectListResponse>('/api/projects')
  return payload.projects
}

export const WorkspaceSelectionProvider: Component<{ children: JSX.Element }> = (props) => {
  const [params, setParams] = useSearchParams()
  const [workspaces, { refetch }] = createResource(fetchWorkspaces)
  const isLoading = () => workspaces.state === 'pending'

  const paramWorkspaceId = () =>
    typeof params.workspaceId === 'string' && params.workspaceId.length ? params.workspaceId : null

  const currentWorkspaceId = createMemo<string | null>(() => {
    const list = workspaces()
    const fromParam = paramWorkspaceId()
    if (fromParam && list?.some((workspace) => workspace.id === fromParam)) {
      return fromParam
    }
    if (list && list.length) {
      return list[0].id
    }
    return null
  })

  createEffect(() => {
    const list = workspaces()
    if (!list || !list.length) return
    const explicit = paramWorkspaceId()
    if (!explicit || !list.some((workspace) => workspace.id === explicit)) {
      setParams({ workspaceId: list[0].id }, { replace: true })
    }
  })

  const currentWorkspace = createMemo(() => {
    const list = workspaces()
    if (!list) return null
    const id = currentWorkspaceId()
    if (!id) return null
    return list.find((workspace) => workspace.id === id) ?? null
  })

  const setWorkspaceId = (workspaceId: string | null) => {
    setParams({ workspaceId: workspaceId ?? undefined })
  }

  const value: WorkspaceSelectionValue = {
    workspaces,
    isLoading,
    currentWorkspaceId,
    currentWorkspace,
    setWorkspaceId,
    refetchWorkspaces: async () => {
      const result = await refetch()
      return result ?? workspaces()
    }
  }

  return <WorkspaceSelectionContext.Provider value={value}>{props.children}</WorkspaceSelectionContext.Provider>
}

export const useWorkspaceSelection = () => {
  const context = useContext(WorkspaceSelectionContext)
  if (!context) {
    throw new Error('useWorkspaceSelection must be used within a WorkspaceSelectionProvider')
  }
  return context
}
