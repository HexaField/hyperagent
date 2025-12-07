import { runAgentWorkflow } from '../modules/agent/agent-orchestrator.js'
import { closeOpencodeServer } from '../modules/agent/opencode.js'
import { singleAgentWorkflowDefinition, verifierWorkerWorkflowDefinition } from '../modules/agent/workflows/index.js'
import { ensureProviderConfig } from '../modules/providerConfig.js'

const getEnv = (key: string) => process.env[key]?.trim()

async function main() {
  try {
    const workspacePath = getEnv('AGENT_WORKSPACE_PATH')
    const prompt = getEnv('AGENT_PROMPT') ?? ''
    const model = getEnv('AGENT_MODEL') ?? 'gpt-4o-mini'
    const workflowId = getEnv('AGENT_WORKFLOW_ID') ?? singleAgentWorkflowDefinition.id
    const workflowSource = (getEnv('AGENT_WORKFLOW_SOURCE') as 'builtin' | 'user' | undefined) ?? 'builtin'
    const runId = getEnv('AGENT_RUN_ID')
    const personaId = getEnv('AGENT_PERSONA_ID')

    if (!workspacePath) {
      throw new Error('AGENT_WORKSPACE_PATH is required')
    }
    if (!prompt.trim()) {
      throw new Error('AGENT_PROMPT is required')
    }

    const workflow =
      workflowId === verifierWorkerWorkflowDefinition.id
        ? {
            id: verifierWorkerWorkflowDefinition.id,
            definition: verifierWorkerWorkflowDefinition,
            source: 'builtin' as const
          }
        : {
            id: singleAgentWorkflowDefinition.id,
            definition: singleAgentWorkflowDefinition,
            source: 'builtin' as const
          }

    if (personaId) {
      await ensureProviderConfig(workspacePath, 'opencode', personaId)
    }

    const response = await runAgentWorkflow(workflow.definition, {
      runID: runId,
      userInstructions: prompt,
      model,
      sessionDir: workspacePath,
      workflowId: workflow.id,
      workflowSource,
      workflowLabel: workflow.definition.description
    })

    const resolvedRunId = response.runId ?? runId ?? `${workflow.id}-${Date.now()}`
    console.log(JSON.stringify({ event: 'agent.run.completed', runId: resolvedRunId }))
  } finally {
    closeOpencodeServer()
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(JSON.stringify({ event: 'agent.run.error', message }))
  process.exit(1)
})