import { createEffect, createSignal } from 'solid-js'
import CodingAgentConsole from '../../components/CodingAgentConsole'

export type SessionsWidgetProps = {
  workspacePath: string
}

export function SessionsWidget(props: SessionsWidgetProps) {
  const [filter, setFilter] = createSignal(props.workspacePath ?? '')
  createEffect(() => {
    if (props.workspacePath) {
      setFilter(props.workspacePath)
    }
  })
  return <CodingAgentConsole workspaceFilter={filter()} onWorkspaceFilterChange={setFilter} hideHeader />
}

export default SessionsWidget
