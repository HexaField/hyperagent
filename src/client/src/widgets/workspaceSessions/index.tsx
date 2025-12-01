import { createEffect, createSignal } from 'solid-js'
import CodingAgentConsole from '../../components/CodingAgentConsole'
import { WorkspaceFilterInput } from '../shared/WorkspaceFilterInput'

export type SessionsWidgetProps = {
  workspacePath: string
  workspaceName?: string
}

export function SessionsWidget(props: SessionsWidgetProps) {
  const [filter, setFilter] = createSignal(props.workspacePath ?? '')
  createEffect(() => {
    if (props.workspacePath) {
      setFilter(props.workspacePath)
    }
  })
  return (
    <div class="flex h-full flex-col gap-4">
      <WorkspaceFilterInput
        label="Coding Agent workspace"
        description="Update the repository path before starting a run."
        value={filter()}
        onChange={setFilter}
      />
      <div class="flex-1 min-h-0">
        <CodingAgentConsole workspaceFilter={filter()} onWorkspaceFilterChange={setFilter} hideHeader />
      </div>
    </div>
  )
}

export default SessionsWidget
