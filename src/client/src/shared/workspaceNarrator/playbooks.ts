export type NarratorPlaybook = {
  id: string
  title: string
  summary: string
  steps: string[]
}

export const PLAYBOOKS: Record<string, NarratorPlaybook> = {
  'narration-suppressed': {
    id: 'narration-suppressed',
    title: 'Narration suppressed',
    summary: 'Narrator output was intentionally muted. Confirm the run has clear instructions and rerun when ready.',
    steps: [
      'Review the last controller task for gating reasons.',
      'Gather any missing context or assets requested by the controller.',
      'Resume the workflow once requirements are satisfied.'
    ]
  },
  'agent-run-failed': {
    id: 'agent-run-failed',
    title: 'Agent run failed',
    summary: 'An agent reported a failure or timeout. Inspect the error and retry after resolving blocking issues.',
    steps: [
      'Open the relevant Coding Agent session or workflow logs.',
      'Identify the failing command, test, or validation step.',
      'Re-run the task after fixing the root cause.'
    ]
  },
  'narrator-error': {
    id: 'narrator-error',
    title: 'Narrator error',
    summary: 'The narrator pipeline hit an unexpected exception. Check the Streaming LLM logs for stack traces.',
    steps: [
      'Download the raw narrator log to capture the exception.',
      'Verify the Streaming LLM sidecar is healthy.',
      'Restart the orchestrator or replay the task if needed.'
    ]
  }
}

export function getPlaybook(id: string | undefined): NarratorPlaybook | null {
  if (!id) return null
  return PLAYBOOKS[id] ?? null
}
