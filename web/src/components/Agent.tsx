import type { JSX } from 'solid-js'
import OpencodeConsole from './OpencodeConsole'

const DEFAULT_PROMPT = `Draft a quick project overview for a habit-tracking app.`

type AgentProps = {
  title?: string
  description?: string
  defaultPrompt?: string
  workspacePath?: string
  onRunComplete?: (sessionId: string) => void
  headerActions?: JSX.Element
}

export default function Agent(props: AgentProps = {}) {
  return (
    <OpencodeConsole
      workspaceFilter={props.workspacePath}
      lockWorkspace={Boolean(props.workspacePath)}
      heading={props.title ?? 'Opencode session console'}
      description={
        props.description ??
        'Opencode runs persist in detached background sessions so you can resume transcripts or replay work across restarts.'
      }
      defaultPrompt={props.defaultPrompt ?? DEFAULT_PROMPT}
      onRunStarted={props.onRunComplete}
      headerActions={props.headerActions}
    />
  )
}
