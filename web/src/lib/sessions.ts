export type SessionWorkflowPayload = {
  projectId: string
  kind: string
  autoStart: boolean
  tasks: Array<{
    title: string
    instructions: string
    agentType: string
  }>
  data: {
    sessionName: string
    sessionDetails: string
    source: string
  }
}

export function buildSessionWorkflowPayload(input: {
  projectId: string
  sessionName: string
  sessionDetails: string
}): SessionWorkflowPayload {
  const sessionName = input.sessionName.trim()
  const sessionDetails = input.sessionDetails.trim()
  if (!sessionName) {
    throw new Error('Session name is required')
  }
  if (!sessionDetails) {
    throw new Error('Session details are required')
  }
  return {
    projectId: input.projectId,
    kind: 'session',
    autoStart: true,
    data: {
      sessionName,
      sessionDetails,
      source: 'repositories:new-session'
    },
    tasks: [
      {
        title: sessionName,
        instructions: sessionDetails,
        agentType: 'coding'
      }
    ]
  }
}
