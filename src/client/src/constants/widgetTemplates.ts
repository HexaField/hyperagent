export type WidgetTemplateId =
  | 'workspace-summary'
  | 'workspace-terminal'
  | 'workspace-code-server'
  | 'workspace-sessions'
// | 'workspace-narrator'

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
  // {
  //   id: 'workspace-narrator',
  //   label: 'Narrator activity',
  //   description: 'Streaming LLM narration timeline'
  // }
]
