export type WidgetTemplateId =
  | 'workspace-summary'
  | 'workspace-workflows'
  | 'workspace-terminal'
  | 'workspace-code-server'
  | 'workspace-sessions'

export type WidgetTemplate = {
  id: WidgetTemplateId
  label: string
  description: string
}

export type WidgetAddEventDetail = {
  templateId: WidgetTemplateId
}

export const WIDGET_TEMPLATES: WidgetTemplate[] = [
  {
    id: 'workspace-summary',
    label: 'Workspace overview',
    description: 'Repository details and quick actions'
  },
  {
    id: 'workspace-workflows',
    label: 'Workflows',
    description: 'Run history and queue'
  },
  {
    id: 'workspace-terminal',
    label: 'Terminal',
    description: 'Shell access scoped to this workspace'
  },
  {
    id: 'workspace-code-server',
    label: 'Code workspace',
    description: 'Embedded code-server experience for this repo'
  },
  {
    id: 'workspace-sessions',
    label: 'Coding Agent sessions',
    description: 'Background Coding Agent activity feed'
  }
]
