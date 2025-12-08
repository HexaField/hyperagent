import { lazy, type JSX } from 'solid-js'
import type { WorkspaceRecord } from '../../../interfaces/core/projects'
import type { WidgetTemplateId } from '../constants/widgetTemplates'
import type { CanvasNavigatorController } from '../core/state/CanvasNavigatorContext'

const WorkspaceSummaryView = lazy(async () => {
  const module = await import('./workspaceSummary')
  return { default: module.WorkspaceSummary }
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

const WorkspaceNarratorView = lazy(async () => {
  const module = await import('./workspaceNarrator')
  return { default: module.WorkspaceNarratorWidget }
})

const WorkspaceWorkflowsView = lazy(async () => {
  const module = await import('./workflows')
  return { default: module.WorkflowsWidget }
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
    render: ({ workspace }) => <WorkspaceSummaryView workspace={workspace} />
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
  },
  'workspace-workflows': {
    id: 'workspace-workflows',
    title: 'Workflows',
    description: 'Author, validate, and save workflows',
    icon: '🧩',
    initialPosition: { x: -320, y: 940 },
    initialSize: { width: 780, height: 640 },
    startOpen: true,
    render: ({ workspace }) => <WorkspaceWorkflowsView workspace={workspace} />
  }
  // 'workspace-narrator': {
  //   id: 'workspace-narrator',
  //   title: 'Narrator activity',
  //   description: 'Streaming LLM narration timeline',
  //   icon: '📣',
  //   initialPosition: { x: 120, y: 1080 },
  //   initialSize: { width: 760, height: 560 },
  //   startOpen: true,
  //   render: ({ workspace }) => (
  //     <WorkspaceNarratorView
  //       workspaceId={workspace.id}
  //       workspaceName={workspace.name}
  //       repositoryPath={workspace.repositoryPath}
  //     />
  //   )
  // }
}

export function getWidgetDefinition(id: WidgetTemplateId): WidgetDefinition | undefined {
  return definitionMap[id]
}

export function listWidgetDefinitions(): WidgetDefinition[] {
  return Object.values(definitionMap)
}
