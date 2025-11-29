import type { JSX } from 'solid-js'
import CodingAgentConsole from './CodingAgentConsole'

const DEFAULT_PROMPT = `Draft a quick project overview for a habit-tracking app.`

type AgentProps = {
  title?: string
  description?: string
  defaultPrompt?: string
  workspacePath?: string
  onRunComplete?: (sessionId: string) => void
  headerActions?: JSX.Element
  hideHeader?: boolean
  class?: string
}

export default function Agent(props: AgentProps = {}) {
  return (
    <CodingAgentConsole
      workspaceFilter={props.workspacePath}
      lockWorkspace={Boolean(props.workspacePath)}
      heading={props.title ?? 'Coding Agent session console'}
      description={
        props.description ??
        'Coding Agent runs persist in detached background sessions so you can resume transcripts or replay work across restarts.'
      }
      defaultPrompt={props.defaultPrompt ?? DEFAULT_PROMPT}
      onRunStarted={props.onRunComplete}
      headerActions={props.headerActions}
      hideHeader={props.hideHeader}
      class={props.class}
    />
  )
}
