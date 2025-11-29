import { lazy, type JSX } from 'solid-js'
import type { WidgetTemplateId } from '../constants/widgetTemplates'
import type { CanvasNavigatorController } from '../core/state/CanvasNavigatorContext'
import type { WorkspaceRecord } from '../../../src/interfaces/core/projects'

const WorkspaceSummaryView = lazy(async () => {
  const module = await import('./workspaceSummary')
  return { default: module.WorkspaceSummary }
})

const WorkflowsWidgetView = lazy(async () => {
  const module = await import('./workspaceWorkflows')
  return { default: module.WorkflowsWidget }
})

const WorkspaceTerminalView = lazy(async () => {
  const module = await import('./workspaceTerminal')
  return { default: module.WorkspaceTerminalWidget }
})

const WorkspaceCodeServerView = lazy(async () => {
  const module = await import('./workspaceCodeServer')
  return { default: module.WorkspaceCodeServerWidget }
})

const SessionsWidgetView = lazy(async () => {
  const module = await import('./workspaceSessions')
  return { default: module.SessionsWidget }
})

export type WidgetRenderContext = {
  workspace: WorkspaceRecord
  navigator: CanvasNavigatorController
}

export type WidgetDefinition = {
  id: WidgetTemplateId
  title: string
  description: string
  icon: string
  initialPosition: { x: number; y: number }
  initialSize: { width: number; height: number }
  startOpen: boolean
  render: (context: WidgetRenderContext) => JSX.Element
}

const definitionMap: Record<WidgetTemplateId, WidgetDefinition> = {
  'workspace-summary': {
    id: 'workspace-summary',
    title: 'Workspace overview',
    description: 'Repository details and quick actions',
    icon: '🧭',
    initialPosition: { x: -300, y: -140 },
    initialSize: { width: 480, height: 400 },
    startOpen: true,
    render: ({ workspace, navigator }) => (
      <WorkspaceSummaryView workspace={workspace} onOpenNavigator={navigator.open} />
    )
  },
  'workspace-workflows': {
    id: 'workspace-workflows',
    title: 'Workflows',
    description: 'Run history and queue',
    icon: '🧩',
    initialPosition: { x: 280, y: -100 },
    initialSize: { width: 920, height: 760 },
    startOpen: true,
    render: ({ workspace }) => <WorkflowsWidgetView workspaceId={workspace.id} workspaceName={workspace.name} />
  },
  'workspace-terminal': {
    id: 'workspace-terminal',
    title: 'Terminal',
    description: 'Shell access scoped to this workspace',
    icon: '🖥️',
    initialPosition: { x: -320, y: 420 },
    initialSize: { width: 720, height: 520 },
    startOpen: true,
    render: ({ workspace }) => (
      <WorkspaceTerminalView workspaceId={workspace.id} workspacePath={workspace.repositoryPath} />
    )
  },
  'workspace-code-server': {
    id: 'workspace-code-server',
    title: 'Code workspace',
    description: 'Open the repository inside code-server',
    icon: '💻',
    initialPosition: { x: 320, y: 420 },
    initialSize: { width: 960, height: 640 },
    startOpen: true,
    render: ({ workspace }) => (
      <WorkspaceCodeServerView
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        workspacePath={workspace.repositoryPath}
      />
    )
  },
  'workspace-sessions': {
    id: 'workspace-sessions',
    title: 'Coding Agent sessions',
    description: 'Background Coding Agent activity feed',
    icon: '🕘',
    initialPosition: { x: 460, y: 520 },
    initialSize: { width: 720, height: 520 },
    startOpen: true,
    render: ({ workspace }) => <SessionsWidgetView workspacePath={workspace.repositoryPath} />
  }
}

export function getWidgetDefinition(id: WidgetTemplateId): WidgetDefinition | undefined {
  return definitionMap[id]
}

export function listWidgetDefinitions(): WidgetDefinition[] {
  return Object.values(definitionMap)
}
